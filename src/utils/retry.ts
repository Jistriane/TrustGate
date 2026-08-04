export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  shouldRetry?: (err: unknown) => boolean;
}

const TRANSIENT_ERROR_PATTERN = /account not found|timeout|timed out|ECONNRESET|ETIMEDOUT|network/i;

export function isTransientNetworkError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return TRANSIENT_ERROR_PATTERN.test(message);
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

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === retries || !shouldRetry(err)) break;
      const delayMs = baseDelayMs * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}
