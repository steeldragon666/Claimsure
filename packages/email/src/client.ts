import { Resend } from 'resend';

/**
 * Resend client wrapper with configurable retry logic.
 *
 * Factory function — not a class — consistent with the codebase's
 * functional-first style. Retries with exponential backoff on transient
 * failures (429, 5xx, network errors). Non-retryable failures (4xx
 * except 429) throw immediately.
 */

export interface ResendClientOptions {
  /** Resend API key. Falls back to RESEND_API_KEY env var. */
  apiKey?: string;
  /** Maximum retry attempts for transient failures. Default: 3. */
  maxRetries?: number;
  /** Base delay between retries in ms. Doubles on each attempt. Default: 500. */
  baseDelayMs?: number;
}

export interface ResendClient {
  /** The underlying Resend SDK instance. */
  sdk: Resend;
  /** Max retries configured for this client. */
  maxRetries: number;
  /** Base delay in ms for exponential backoff. */
  baseDelayMs: number;
}

/**
 * Determines whether an error from Resend is transient and should be retried.
 *
 * Resend rate-limit responses (429) and server errors (5xx) are retryable.
 * Client errors (400, 401, 403, 404, 422) are not.
 */
export function isRetryableError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const statusCode = (err as { statusCode?: number }).statusCode;
  if (typeof statusCode === 'number') {
    return statusCode === 429 || statusCode >= 500;
  }
  // Network errors (no statusCode) are retryable.
  const name = (err as { name?: string }).name;
  if (name === 'FetchError' || name === 'AbortError' || name === 'TypeError') {
    return true;
  }
  return false;
}

/** Sleep for a given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute an async operation with exponential backoff retry.
 *
 * On each retry, the delay doubles: baseDelayMs, baseDelayMs*2, baseDelayMs*4, etc.
 * Only retries when `isRetryableError` returns true. All other errors are rethrown
 * immediately.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  baseDelayMs: number,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryableError(err) || attempt === maxRetries) {
        throw err;
      }
      const delay = baseDelayMs * Math.pow(2, attempt);
      await sleep(delay);
    }
  }
  // Unreachable — the loop always either returns or throws. TypeScript
  // cannot prove this so we throw the last captured error.
  throw lastError;
}

/**
 * Create a configured Resend client with retry capabilities.
 *
 * Usage:
 * ```ts
 * const client = createResendClient({ apiKey: process.env.RESEND_API_KEY });
 * ```
 */
export function createResendClient(options: ResendClientOptions = {}): ResendClient {
  const apiKey = options.apiKey ?? process.env['RESEND_API_KEY'];
  if (!apiKey) {
    throw new Error(
      'Resend API key is required. Pass it via options.apiKey or set RESEND_API_KEY env var.',
    );
  }

  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;

  return {
    sdk: new Resend(apiKey),
    maxRetries,
    baseDelayMs,
  };
}
