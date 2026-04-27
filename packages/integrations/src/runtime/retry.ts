import type { RetryOptions } from './types.js';

/**
 * Exponential backoff with symmetric jitter.
 *
 * Calls `fn` up to `max_attempts` times. On each failure, sleeps
 * `initial_delay_ms * 2 ** attempt` (capped at `max_delay_ms`),
 * adjusted by ±`jitter_ratio` randomness to avoid thundering-herd
 * sync across callers. After the last attempt fails, rethrows the
 * most recent error.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const max = opts.max_attempts ?? 5;
  const initial = opts.initial_delay_ms ?? 200;
  const maxDelay = opts.max_delay_ms ?? 30_000;
  const jitter = opts.jitter_ratio ?? 0.3;

  let lastError: unknown;
  for (let attempt = 0; attempt < max; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (attempt === max - 1) break;
      const base = Math.min(maxDelay, initial * 2 ** attempt);
      const noise = base * jitter * (Math.random() * 2 - 1);
      await new Promise((r) => setTimeout(r, base + noise));
    }
  }
  throw lastError;
}
