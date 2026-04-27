import type { RateLimitOptions } from './types.js';

/**
 * In-memory token-bucket rate limiter, keyed by a caller-provided string
 * (typically `${tenant_id}:${provider}`).
 *
 * NOTE: the `buckets` Map is process-local. This is fine for v1 where
 * the API runs as a single Fastify instance. Horizontal scale will need
 * a Redis-backed bucket — keep this module's signature stable so the
 * swap is mechanical.
 */

type Bucket = { tokens: number; last_refill_ms: number };
const buckets = new Map<string, Bucket>();

export function tryAcquire(key: string, opts: RateLimitOptions): boolean {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: opts.capacity, last_refill_ms: now };
    buckets.set(key, bucket);
  }
  const elapsed_s = (now - bucket.last_refill_ms) / 1000;
  bucket.tokens = Math.min(opts.capacity, bucket.tokens + elapsed_s * opts.refill_per_second);
  bucket.last_refill_ms = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }
  return false;
}

/**
 * Test-only escape hatch: clear the in-memory bucket map between tests
 * so state from one test never leaks into another. NOT exported from
 * the package's public `runtime/index.ts`.
 */
export function _resetRateLimitForTests(): void {
  buckets.clear();
}
