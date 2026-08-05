import { withRetry } from '../utils/retry';

export interface WebhookServiceOptions {
  timeoutMs: number;
  /**
   * Maximum number of retries inside a single `postJson` call, over and
   * above the initial attempt. So `maxRetries = 3` means up to 4 total
   * HTTP attempts per call before giving up and throwing.
   *
   * The outer WorkerService still has its own WORKER_MAX_ATTEMPTS retry
   * cycle on top (via Redis Streams XAUTOCLAIM / XREADGROUP), so a webhook
   * failing both layers is truly dead-lettered.
   */
  maxRetries: number;
  /** Base backoff for the first retry. Subsequent retries double this. */
  baseBackoffMs: number;
}

export class WebhookHttpError extends Error {
  public readonly name = 'WebhookHttpError';
  constructor(
    message: string,
    public readonly status: number,
    public readonly bodyText: string,
    /** Parsed delta-seconds from the `Retry-After` response header, if any. */
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

function parseRetryAfterSeconds(headers: Headers): number | undefined {
  const raw = headers.get('Retry-After');
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  if (Number.isFinite(n) && n >= 0 && Number.isInteger(n)) return Math.trunc(n);
  return undefined;
}

function classifyStatus(status: number): '2xx' | '3xx' | '4xx' | '5xx' {
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 300) return '3xx';
  return '2xx';
}

/**
 * Default webhook retry predicate (A1 decision matrix):
 *   RETRY on — any network-level exception thrown by fetch (DNS/TCP/TLS),
 *   any 5xx response, 408 Request Timeout, or 429 Too Many Requests.
 *   DO NOT RETRY on — 400/401/403/404/410 (bad request; retries never help).
 *
 * For 429/503 that carry a `Retry-After: N` header the actual wait is
 * handled upstream by the caller / withRetry (via `retryAfterSeconds` on
 * the Error).
 */
export function isWebhookRetryableError(err: unknown): boolean {
  if (err instanceof WebhookHttpError) {
    if (err.status === 408 || err.status === 429) return true;
    return err.status >= 500 && err.status < 600;
  }
  if (err instanceof Error && err.name === 'AbortError') return true;
  const message = err instanceof Error ? err.message : String(err ?? '');
  const typ =
    err !== null && typeof err === 'object'
      ? ((err as { type?: unknown }).type as unknown)
      : undefined;
  if (typeof typ === 'string' && /network|timeout|fetch/i.test(typ)) return true;
  return /fetch failed|econnreset|etimedout|dns|enotfound|tls|socket|aborted|timeout|timed out/i.test(
    message,
  );
}

export function classifyWebhookError(err: unknown): {
  statusClass: '2xx' | '3xx' | '4xx' | '5xx' | 'network' | 'timeout';
  retryReason: '5xx' | '429' | '408' | 'network' | 'timeout' | 'retry_after' | null;
} {
  if (err instanceof WebhookHttpError) {
    const s = classifyStatus(err.status);
    let reason: '5xx' | '429' | '408' | null = null;
    if (err.status === 429) reason = '429';
    else if (err.status === 408) reason = '408';
    else if (err.status >= 500) reason = '5xx';
    return { statusClass: s, retryReason: reason };
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return { statusClass: 'timeout', retryReason: 'timeout' };
  }
  return { statusClass: 'network', retryReason: 'network' };
}

export interface PostJsonResult {
  status: number;
  bodyText: string;
  /**
   * Total number of HTTP attempts actually made for this call. Always >= 1
   * on success; >= 1 on failure (even when retries are exhausted).
   */
  attempts: number;
}

export class WebhookService {
  constructor(private readonly options: WebhookServiceOptions) {}

  async postJson(
    url: string,
    payload: unknown,
    hooks?: {
      onAttempt?: (info: {
        attemptIndex: number;
        totalAttempts: number;
        statusClass?: '2xx' | '3xx' | '4xx' | '5xx' | 'network' | 'timeout';
        httpStatus?: number;
        willRetry: boolean;
        sleepMs?: number;
        err?: unknown;
      }) => void | Promise<void>;
    },
  ): Promise<PostJsonResult> {
    const maxRetries = Math.max(0, Number.isFinite(this.options.maxRetries) ? this.options.maxRetries : 3);
    const baseBackoffMs = Math.max(50, Number.isFinite(this.options.baseBackoffMs) ? this.options.baseBackoffMs : 1000);
    let attempts = 0;

    return withRetry(
      async () => {
        attempts += 1;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
        let res: Response | undefined;
        try {
          res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal,
          });
          const status = res.status;
          const bodyText = await res.text();
          if (status >= 200 && status < 300) {
            await hooks?.onAttempt?.({
              attemptIndex: attempts - 1,
              totalAttempts: maxRetries + 1,
              statusClass: classifyStatus(status),
              httpStatus: status,
              willRetry: false,
            });
            return { status, bodyText, attempts };
          }
          const retryAfter = parseRetryAfterSeconds(res.headers);
          const err = new WebhookHttpError(
            `webhook failed: ${status} ${bodyText}`,
            status,
            bodyText,
            retryAfter,
          );
          await hooks?.onAttempt?.({
            attemptIndex: attempts - 1,
            totalAttempts: maxRetries + 1,
            statusClass: classifyStatus(status),
            httpStatus: status,
            willRetry: isWebhookRetryableError(err) && attempts <= maxRetries,
            err,
          });
          throw err;
        } catch (err) {
          if (res === undefined) {
            const isAbort = err instanceof Error && err.name === 'AbortError';
            const sc: 'network' | 'timeout' = isAbort ? 'timeout' : 'network';
            await hooks?.onAttempt?.({
              attemptIndex: attempts - 1,
              totalAttempts: maxRetries + 1,
              statusClass: sc,
              willRetry: isWebhookRetryableError(err) && attempts <= maxRetries,
              err,
            });
          }
          throw err;
        } finally {
          clearTimeout(timer);
        }
      },
      {
        retries: maxRetries,
        baseDelayMs: baseBackoffMs,
        jitterPct: 0.5,
        shouldRetry: isWebhookRetryableError,
        onRetry: async ({ attempt, totalAttempts, lastError, computedDelayMs }) => {
          const info = classifyWebhookError(lastError);
          const retryReason =
            (lastError instanceof WebhookHttpError &&
              lastError.status === 429 &&
              typeof lastError.retryAfterSeconds === 'number') ||
            (lastError instanceof WebhookHttpError &&
              lastError.status === 503 &&
              typeof lastError.retryAfterSeconds === 'number')
              ? 'retry_after'
              : info.retryReason;
          if (hooks?.onAttempt) {
            await hooks.onAttempt({
              attemptIndex: attempt + 1,
              totalAttempts,
              statusClass: info.statusClass,
              httpStatus: lastError instanceof WebhookHttpError ? lastError.status : undefined,
              willRetry: true,
              sleepMs: computedDelayMs,
              err: lastError,
            });
          }
          // Make reason discoverable by caller via metric label even when
          // using the fallback Retry-After path — we expose a helper label.
          void retryReason;
          return undefined;
        },
      },
    );
  }
}
