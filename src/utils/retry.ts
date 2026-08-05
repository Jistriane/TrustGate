export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  shouldRetry?: (err: unknown) => boolean;
  /**
   * Percentage (0 to 1) of random jitter added to the computed exponential
   * backoff delay. `0.5` = ±50% jitter = "Full Jitter" AWS recommended
   * pattern to avoid thundering-herd retries after correlated failures.
   *
   * Default: `0` (no jitter) for backwards compatibility with existing
   * callers (Stellar RPC retries) that expect deterministic delays.
   */
  jitterPct?: number;
  /**
   * Optional callback invoked right before each retry sleep. Useful for
   * structured logging, metrics, and propagating a `retry-after` hint via
   * the thrown error object. When `onRetry` returns a number of
   * milliseconds > `computedDelayMs`, that value is used as the sleep
   * duration instead (to honour HTTP `Retry-After: N` or equivalent).
   */
  onRetry?: (info: {
    attempt: number;
    totalAttempts: number;
    lastError: unknown;
    computedDelayMs: number;
  }) => number | void | Promise<number | void>;
}

const TRANSIENT_ERROR_PATTERN = /account not found|timeout|timed out|ECONNRESET|ETIMEDOUT|network/i;

export function isTransientNetworkError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return TRANSIENT_ERROR_PATTERN.test(message);
}

/**
 * If a thrown Error carries a `retryAfterSeconds` number (e.g. an HTTP 429
 * or 503 with a `Retry-After: delta-seconds` response header), converts
 * that value to milliseconds and returns it. Otherwise returns `0`.
 */
export function extractRetryAfterMs(err: unknown): number {
  if (
    err !== null &&
    typeof err === 'object' &&
    typeof (err as { retryAfterSeconds?: unknown }).retryAfterSeconds === 'number'
  ) {
    const s = (err as { retryAfterSeconds: number }).retryAfterSeconds;
    if (Number.isFinite(s) && s > 0) return Math.trunc(s * 1000);
  }
  return 0;
}

/**
 * Retries a flaky async operation with exponential backoff. Public Stellar
 * RPC nodes occasionally return a stale "Account not found" for an account
 * that was just created/funded moments earlier — an eventual-consistency
 * lag between Horizon and the RPC node's own ledger view, not a real
 * missing account. A short retry clears it.
 *
 * Only retries errors that look transient (see `isTransientNetworkError`)
 * by default, so a genuine business-logic failure (e.g. "already
 * registered", "insufficient balance") surfaces immediately instead of
 * uselessly retrying for several seconds first.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const retries = options.retries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const shouldRetry = options.shouldRetry ?? isTransientNetworkError;
  const jitterPct = options.jitterPct ?? 0;
  const onRetry = options.onRetry;

  const totalAttempts = retries + 1;
  let lastError: unknown;
  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === retries || !shouldRetry(err)) break;

      const rawDelay = baseDelayMs * 2 ** attempt;
      const jitterMs = jitterPct > 0 ? (Math.random() * 2 - 1) * rawDelay * jitterPct : 0;
      const computedDelayMs = Math.max(0, Math.trunc(rawDelay + jitterMs));

      let sleepMs = computedDelayMs;
      if (onRetry) {
        const override = await onRetry({ attempt, totalAttempts, lastError: err, computedDelayMs });
        if (typeof override === 'number' && Number.isFinite(override) && override > sleepMs) {
          sleepMs = Math.trunc(override);
        }
      }
      const retryAfterMs = extractRetryAfterMs(err);
      if (retryAfterMs > sleepMs) sleepMs = retryAfterMs;

      await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }
  }
  throw lastError;
}
