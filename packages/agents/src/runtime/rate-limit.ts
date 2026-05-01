import { setTimeout as delay } from 'node:timers/promises';

/**
 * Canonical short identifier for the three P6 agents. Mirrors the feature-flag
 * identifiers in `env.ts` (Task 2.4) so a single `'A' | 'B' | 'C'` key is used
 * throughout cross-cutting infra. The descriptive names live alongside in
 * span attributes (`telemetry.ts`) — those are free-form for human readers
 * and are deliberately decoupled from this rate-limit key.
 *
 *   A = expenditure classifier (Haiku)
 *   B = activity register synthesizer (Sonnet)
 *   C = narrative drafter (Sonnet, streaming)
 */
export type AgentName = 'A' | 'B' | 'C';

/**
 * Thrown when a call cannot acquire its token within `maxWaitMs`. The HTTP
 * boundary is expected to translate this into a `429 Too Many Requests` with
 * `Retry-After: ceil(retryAfterMs / 1000)`. Failing fast here is intentional:
 * a runaway agent loop blocking forever on `bucket.consume(1)` would keep
 * Node's HTTP request open until the LB times it out, producing a much
 * worse caller experience than a typed 429.
 */
export class RateLimitExceededError extends Error {
  public readonly tenantId: string;
  public readonly agent: AgentName;
  /**
   * Milliseconds until the next token would be available given the bucket's
   * current refill rate, regardless of `maxWaitMs`. The HTTP layer translates
   * this into a `Retry-After` header — that header tells the client when it
   * is genuinely safe to retry, which is "after the bucket has refilled",
   * not "after our caller-side deadline elapses". The two are distinct:
   * `maxWaitMs` bounds how long *this* call is willing to block; `retryAfterMs`
   * tells the *next* call how long to back off.
   */
  public readonly retryAfterMs: number;

  constructor(tenantId: string, agent: AgentName, retryAfterMs: number) {
    super(
      `rate limit exceeded for tenant=${tenantId} agent=${agent} (retry after ~${Math.ceil(retryAfterMs)}ms)`,
    );
    this.name = 'RateLimitExceededError';
    this.tenantId = tenantId;
    this.agent = agent;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Tunable knobs. `capacity` doubles as the per-window quota: a fresh tenant
 * may burst the full minute's quota immediately (token bucket starting full),
 * then sustained throughput is bounded by `capacity / windowMs`.
 *
 * `maxWaitMs` is the upper bound on how long `consume(1)` will block before
 * throwing `RateLimitExceededError`. Default 60_000 lines up with a typical
 * LB / Cloud Run request timeout — we'd rather throw an actionable 429 than
 * have the request silently timed out.
 */
type RateLimitConfig = {
  capacity: number;
  windowMs: number;
  maxWaitMs: number;
};

/**
 * Read the env override **once** at module load. Re-reading per-call would
 * make per-test overrides require process restarts; reading once means the
 * test escape hatch (`_configureForTests`) is the only thing that mutates
 * config after module load, which keeps surprise off the menu in production
 * where `process.env` is effectively immutable.
 *
 * Single env var by design — per-agent overrides would be a follow-up. The
 * default of 100/min is deliberately conservative: capped at $5/min across
 * all three agents under a runaway loop on Sonnet pricing. See design doc
 * Section 6.
 */
function loadConfigFromEnv(): RateLimitConfig {
  const raw = process.env.P6_AGENT_RATE_LIMIT_PER_MIN;
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  const capacity = Number.isFinite(parsed) && parsed > 0 ? parsed : 100;
  return {
    capacity,
    windowMs: 60_000,
    maxWaitMs: 60_000,
  };
}

let config: RateLimitConfig = loadConfigFromEnv();

type Bucket = {
  /** Tokens available right now (lazy-refilled — recompute on access). */
  tokens: number;
  /** Wall-clock ms timestamp of the last refill calculation. */
  lastRefillAt: number;
};

/**
 * Per-process Map keyed by `${tenantId}|${agent}`. The pipe separator is safe
 * because tenant ids are UUIDs (no `|`) and `agent` is constrained to
 * `'A' | 'B' | 'C'`.
 *
 * IMPORTANT: scope is per-process. A multi-replica deployment under-enforces
 * by N×: 100/min/replica × N replicas. That trade-off is intentional for P6
 * (avoids a Redis dep on the hot path); a future task can swap this for a
 * Redis-backed bucket if cross-process enforcement becomes necessary.
 */
const buckets = new Map<string, Bucket>();

function bucketKey(tenantId: string, agent: AgentName): string {
  return `${tenantId}|${agent}`;
}

/**
 * Compute current available tokens given `cfg.capacity` and `cfg.windowMs`.
 * Refill is lazy — we do NOT use `setInterval`. Two reasons:
 *   1. Unref'd timers would still keep `node --test` from exiting cleanly,
 *      forcing every test to teardown timers explicitly.
 *   2. Most buckets are idle most of the time. Computing on demand costs
 *      O(1) per call vs O(N buckets) per tick.
 *
 * `refillRatePerMs = capacity / windowMs`. Tokens added between two
 * accesses = `(now - lastRefillAt) * refillRatePerMs`, capped at capacity.
 */
function refill(b: Bucket, now: number): void {
  if (now <= b.lastRefillAt) return;
  const elapsed = now - b.lastRefillAt;
  const refillRatePerMs = config.capacity / config.windowMs;
  b.tokens = Math.min(config.capacity, b.tokens + elapsed * refillRatePerMs);
  b.lastRefillAt = now;
}

function getOrCreateBucket(tenantId: string, agent: AgentName): Bucket {
  const key = bucketKey(tenantId, agent);
  const existing = buckets.get(key);
  if (existing) return existing;
  // Start full so a fresh tenant doesn't get throttled on its first call.
  const created: Bucket = { tokens: config.capacity, lastRefillAt: Date.now() };
  buckets.set(key, created);
  return created;
}

/**
 * Core token-bucket consume operation. Subtracts 1 token if available;
 * otherwise computes how long we'd need to wait for 1 token's worth of
 * refill, and either blocks-with-`setTimeout` (no busy poll) or throws
 * `RateLimitExceededError` if that wait exceeds the *cumulative* deadline.
 *
 * Using `node:timers/promises` `setTimeout` gives a typed promise that is
 * cancellable via AbortSignal in future iterations — and crucially, it
 * doesn't keep the event loop alive past the test runner's deadline (unlike
 * a hand-rolled `new Promise(resolve => setTimeout(resolve, ms))` if the
 * timer were unref'd incorrectly).
 *
 * NOTE: a token is consumed *only* on the success path. We do NOT subtract
 * up-front and refund on failure — this matches the design intent that the
 * Anthropic call probably went out and counted against the upstream quota
 * even when the wrapped `fn()` later rejects.
 *
 * Cumulative-wait bound: an absolute deadline is captured **once** at entry
 * and the iteration checks it every loop. Under sustained contention
 * (multiple concurrent consumers losing the race after wake-up) an individual
 * call therefore cannot exceed `maxWaitMs` of total wall-clock wait — the
 * earlier recursion-based version reset the budget on every wake-up, which
 * could let a single call wait far longer than `maxWaitMs`. Iteration is
 * preferred over recursion-with-deadline-arg here for the conventional
 * reasons (no stack-depth concern, easier to reason about loop invariants).
 */
async function consume(tenantId: string, agent: AgentName): Promise<void> {
  const deadline = Date.now() + config.maxWaitMs;
  const bucket = getOrCreateBucket(tenantId, agent);

  // Loop until we either acquire a token or run out of cumulative budget.
  // Termination: every iteration either returns, throws, or awaits at least
  // 1ms of progress toward `deadline`; the deadline check above the await
  // guarantees we cannot loop past it.
  for (;;) {
    refill(bucket, Date.now());

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return;
    }

    // Need to wait for `1 - bucket.tokens` worth of refill. Convert to ms.
    const refillRatePerMs = config.capacity / config.windowMs;
    const tokensNeeded = 1 - bucket.tokens;
    const waitMs = tokensNeeded / refillRatePerMs;

    const remaining = deadline - Date.now();
    if (waitMs > remaining) {
      // `waitMs` (not `remaining`) is what the *next* caller should back off
      // for — see the Retry-After commentary on `RateLimitExceededError`.
      throw new RateLimitExceededError(tenantId, agent, waitMs);
    }

    // Sleep at most until the deadline. If a concurrent consumer wins the
    // post-wake race, the next loop iteration recomputes `waitMs` against
    // the (now smaller) `remaining` and may throw — the cumulative bound
    // is preserved.
    await delay(Math.min(waitMs, remaining));
  }
}

/**
 * Wrap an Anthropic call with a per-`(tenantId, agent)` token-bucket gate.
 *
 * Default = 100 calls/min/(tenant, agent), overridable via
 * `P6_AGENT_RATE_LIMIT_PER_MIN` (read once at module load). The bucket
 * starts full so a fresh tenant can burst the entire minute's quota
 * immediately, then sustained throughput is bounded.
 *
 * Fail mode: if no token can be acquired within `maxWaitMs` (default 60s),
 * throws `RateLimitExceededError`. The HTTP boundary should translate this
 * into a 429 with `Retry-After`.
 *
 * @example
 * ```ts
 * const result = await rateLimitedAnthropicCall(tenantId, 'A', () =>
 *   anthropic.messages.create({ ... })
 * );
 * ```
 */
export async function rateLimitedAnthropicCall<T>(
  tenantId: string,
  agent: AgentName,
  fn: () => Promise<T>,
): Promise<T> {
  await consume(tenantId, agent);
  return fn();
}

/**
 * Test-only escape hatch: drop all in-memory buckets so tests can run in
 * isolation without polluting each other's state. Mirrors the pattern in
 * `anthropic-client.ts`'s `_resetAnthropicClientForTests`. Production code
 * MUST NOT call this — buckets are intentionally per-process and persistent.
 */
export function _resetBucketsForTests(): void {
  buckets.clear();
}

/**
 * Test-only escape hatch: override config without re-importing the module.
 * Tests pass tiny capacities and short windows to keep refill-cycle waits
 * inside ~200ms of wall-clock time.
 *
 * Production code MUST NOT call this — env override is the supported
 * mechanism for changing limits in deployed environments.
 *
 * Pass no arg to reset to env-derived defaults.
 */
export function _configureForTests(opts?: Partial<RateLimitConfig>): void {
  if (!opts) {
    config = loadConfigFromEnv();
    return;
  }
  config = {
    capacity: opts.capacity ?? config.capacity,
    windowMs: opts.windowMs ?? config.windowMs,
    maxWaitMs: opts.maxWaitMs ?? config.maxWaitMs,
  };
}
