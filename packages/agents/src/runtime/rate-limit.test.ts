import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import {
  rateLimitedAnthropicCall,
  RateLimitExceededError,
  _resetBucketsForTests,
  _configureForTests,
  type AgentName,
} from './rate-limit.js';

// Each test runs in isolation: reset module-level Map of buckets and any
// test-only config override before each scenario. Without this, callers in
// earlier tests would have already drained shared (tenant, agent) buckets.
function reset(opts?: { capacity?: number; windowMs?: number; maxWaitMs?: number }): void {
  _configureForTests(opts);
  _resetBucketsForTests();
}

test('rateLimitedAnthropicCall: invokes fn exactly once and returns its value', async () => {
  reset({ capacity: 10, windowMs: 1000, maxWaitMs: 5000 });
  let calls = 0;
  const result = await rateLimitedAnthropicCall('tenant-a', 'A', () => {
    calls += 1;
    return Promise.resolve('value');
  });
  assert.equal(result, 'value');
  assert.equal(calls, 1);
});

test('rateLimitedAnthropicCall: first call from a fresh bucket succeeds immediately', async () => {
  reset({ capacity: 5, windowMs: 1000, maxWaitMs: 5000 });
  const start = Date.now();
  await rateLimitedAnthropicCall('tenant-a', 'A', () => Promise.resolve());
  // Allow some scheduler slack but assert no meaningful wait happened.
  assert.ok(Date.now() - start < 50, 'first call should not wait for a refill');
});

test('rateLimitedAnthropicCall: all calls within capacity succeed without delay', async () => {
  reset({ capacity: 100, windowMs: 60_000, maxWaitMs: 5000 });
  const start = Date.now();
  const results = await Promise.all(
    Array.from({ length: 100 }, (_, i) =>
      rateLimitedAnthropicCall('tenant-a', 'A', () => Promise.resolve(i)),
    ),
  );
  assert.equal(results.length, 100);
  assert.deepEqual(
    results.sort((a, b) => a - b),
    Array.from({ length: 100 }, (_, i) => i),
  );
  // 100 calls should complete in well under a second; we don't hit the bucket
  // limit because capacity == 100. Generous bound for slow CI machines.
  assert.ok(
    Date.now() - start < 500,
    `100 calls under capacity should be fast, got ${Date.now() - start}ms`,
  );
});

test('rateLimitedAnthropicCall: bucket exhaustion blocks the over-limit call', async () => {
  // capacity 2, slow refill so the over-limit call must wait for refill.
  reset({ capacity: 2, windowMs: 10_000, maxWaitMs: 60_000 });
  await rateLimitedAnthropicCall('tenant-a', 'A', () => Promise.resolve(1));
  await rateLimitedAnthropicCall('tenant-a', 'A', () => Promise.resolve(2));

  // Third call must wait. Race it against a short timer; the timer should win.
  const pending = rateLimitedAnthropicCall('tenant-a', 'A', () => Promise.resolve(3));
  const winner = await Promise.race([
    pending.then(() => 'pending-resolved'),
    delay(50).then(() => 'timer-resolved'),
  ]);
  assert.equal(winner, 'timer-resolved', 'over-limit call should not resolve immediately');

  // Reset config to abort the still-pending call quickly so test runner exits clean.
  // Drop maxWaitMs so it throws fast instead of holding the test open until refill.
  _configureForTests({ capacity: 2, windowMs: 10_000, maxWaitMs: 1 });
  // Note: existing pending call captured the old maxWaitMs at consume time, so
  // we still need to await it. With windowMs=10s, refill rate is 0.0002 tok/ms,
  // so 1 token takes ~5s to refill. Just await for it; bounded by the refill.
  await pending;
});

test('rateLimitedAnthropicCall: refill restores capacity over time', async () => {
  // capacity 2, windowMs=200ms => refill rate = 0.01 tok/ms => 1 token per 100ms.
  reset({ capacity: 2, windowMs: 200, maxWaitMs: 5000 });
  await rateLimitedAnthropicCall('tenant-a', 'A', () => Promise.resolve());
  await rateLimitedAnthropicCall('tenant-a', 'A', () => Promise.resolve());
  // Wait for one full refill cycle (capacity tokens in windowMs ms).
  await delay(220);
  // Now bucket should be ~full again — two more calls should succeed quickly.
  const start = Date.now();
  await rateLimitedAnthropicCall('tenant-a', 'A', () => Promise.resolve());
  await rateLimitedAnthropicCall('tenant-a', 'A', () => Promise.resolve());
  assert.ok(
    Date.now() - start < 50,
    `post-refill calls should be fast, got ${Date.now() - start}ms`,
  );
});

test('rateLimitedAnthropicCall: different tenants have independent buckets', async () => {
  reset({ capacity: 2, windowMs: 10_000, maxWaitMs: 5000 });
  // Drain tenant-a's bucket.
  await rateLimitedAnthropicCall('tenant-a', 'A', () => Promise.resolve());
  await rateLimitedAnthropicCall('tenant-a', 'A', () => Promise.resolve());
  // tenant-b should be unaffected.
  const start = Date.now();
  await rateLimitedAnthropicCall('tenant-b', 'A', () => Promise.resolve());
  await rateLimitedAnthropicCall('tenant-b', 'A', () => Promise.resolve());
  assert.ok(
    Date.now() - start < 50,
    `tenant-b calls should be fast (independent bucket), got ${Date.now() - start}ms`,
  );
});

test('rateLimitedAnthropicCall: same tenant, different agents have independent buckets', async () => {
  reset({ capacity: 2, windowMs: 10_000, maxWaitMs: 5000 });
  // Drain agent A's bucket for tenant-a.
  await rateLimitedAnthropicCall('tenant-a', 'A', () => Promise.resolve());
  await rateLimitedAnthropicCall('tenant-a', 'A', () => Promise.resolve());
  // Agent B should be unaffected.
  const start = Date.now();
  await rateLimitedAnthropicCall('tenant-a', 'B', () => Promise.resolve());
  await rateLimitedAnthropicCall('tenant-a', 'B', () => Promise.resolve());
  assert.ok(
    Date.now() - start < 50,
    `agent B calls should be fast (independent bucket), got ${Date.now() - start}ms`,
  );
});

test('rateLimitedAnthropicCall: throws RateLimitExceededError when wait exceeds maxWaitMs', async () => {
  // capacity 1, windowMs=10s => refill 0.0001 tok/ms (tiny). maxWaitMs=50ms is
  // too short for refill, so the second call must reject.
  reset({ capacity: 1, windowMs: 10_000, maxWaitMs: 50 });
  await rateLimitedAnthropicCall('tenant-a', 'A', () => Promise.resolve());
  let caught: unknown;
  try {
    await rateLimitedAnthropicCall('tenant-a', 'A', () => Promise.resolve());
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof RateLimitExceededError, 'should throw RateLimitExceededError');
  assert.ok(caught instanceof Error, 'should also be an instanceof Error');
  assert.equal(caught.tenantId, 'tenant-a');
  assert.equal(caught.agent, 'A');
  assert.ok(caught.retryAfterMs > 0, 'retryAfterMs should be positive');
});

test('rateLimitedAnthropicCall: propagates errors from the wrapped fn', async () => {
  reset({ capacity: 5, windowMs: 1000, maxWaitMs: 5000 });
  await assert.rejects(
    () => rateLimitedAnthropicCall('tenant-a', 'A', () => Promise.reject(new Error('boom'))),
    /boom/,
  );
});

test('rateLimitedAnthropicCall: fn rejection does not refund the consumed token', async () => {
  // Token was already consumed before fn ran; if fn throws, bucket stays
  // drained. This matches the design (the API call most likely went out and
  // counted against Anthropic's per-key rate limit even on a thrown error).
  reset({ capacity: 1, windowMs: 10_000, maxWaitMs: 50 });
  await assert.rejects(
    () =>
      rateLimitedAnthropicCall('tenant-a', 'A', () =>
        Promise.reject(new Error('first call fails')),
      ),
    /first call fails/,
  );
  // Second call should now also fail rate-limit, because the token wasn't refunded.
  await assert.rejects(
    () => rateLimitedAnthropicCall('tenant-a', 'A', () => Promise.resolve()),
    RateLimitExceededError,
  );
});

test('AgentName type accepts A, B, C as the documented identifiers', () => {
  // Pure type-level smoke test: this would fail to compile if AgentName drifts.
  const names: AgentName[] = ['A', 'B', 'C'];
  assert.equal(names.length, 3);
});

test('rateLimitedAnthropicCall: contended waiters are bounded by cumulative maxWaitMs', async () => {
  // Discriminating test for the cumulative-wait bound. Pre-fix, recursion
  // re-checked `maxWaitMs` against a fresh clock on every wake-up, so a
  // single contended call could wait through *multiple* refill cycles, far
  // exceeding the documented `maxWaitMs` budget. Post-fix, an absolute
  // deadline is captured at entry and the iteration honors it.
  //
  // Setup: capacity=1, windowMs=100ms => refill 0.01 tok/ms (one token per
  // 100ms). maxWaitMs=150ms — enough budget for one refill cycle, but not
  // two (two cycles would need ≥200ms cumulative).
  //
  // Sequence under load:
  //   * Pre-consume the only token (bucket empty, fresh window).
  //   * Two concurrent waiters arrive: both compute waitMs≈100ms ≤ 150ms,
  //     both `delay(100)`.
  //   * At T≈100ms both wake. Refill produces ~1 token; one waiter wins
  //     (bucket.tokens decrements to 0). The losing waiter sees tokens<1.
  //   * PRE-FIX: loser recurses into a *fresh* `consume()` that re-checks
  //     `waitMs(≈100) > config.maxWaitMs(150)` — passes — and `delay(100)`s
  //     again. At T≈200ms it finally acquires. Total wait ≈ 200ms,
  //     exceeding the documented maxWaitMs=150ms by ~33%.
  //   * POST-FIX: loser hits the deadline check. `remaining = deadline - now
  //     ≈ 50ms`, `waitMs ≈ 100ms > remaining` → RateLimitExceededError thrown
  //     promptly. Total elapsed ≈ 100ms (one refill cycle), bounded.
  //
  // Discriminator: assert at least one waiter rejects with
  // RateLimitExceededError, AND total elapsed < ~maxWaitMs + small slack.
  // Pre-fix, both waiters succeed (the loser silently waits ~200ms — twice
  // the contracted budget).
  reset({ capacity: 1, windowMs: 100, maxWaitMs: 150 });
  await rateLimitedAnthropicCall('tenant-contend', 'A', () => Promise.resolve());

  const start = Date.now();
  const results = await Promise.allSettled([
    rateLimitedAnthropicCall('tenant-contend', 'A', () => Promise.resolve('w1')),
    rateLimitedAnthropicCall('tenant-contend', 'A', () => Promise.resolve('w2')),
  ]);
  const elapsed = Date.now() - start;

  const rejections = results.filter((r) => r.status === 'rejected');

  // Cumulative-wait bound: the original deadline (start + maxWaitMs ≈
  // start + 150ms) must be honored. Pre-fix, the losing waiter would have
  // taken ~200ms cumulative, putting `elapsed` ≥ 200ms.
  assert.ok(
    elapsed < 250,
    `contended waiters should be bounded by cumulative maxWaitMs (~150ms+slack), got ${elapsed}ms`,
  );

  // At least one waiter must reject — pre-fix, the buggy recursion would
  // have let *both* eventually succeed (one at T≈100, the other at T≈200,
  // after a second `delay(100)` cycle that escaped the per-call check).
  assert.ok(
    rejections.length >= 1,
    `expected at least one RateLimitExceededError under contention, got 0 (results: ${JSON.stringify(results.map((r) => r.status))})`,
  );

  // All rejections must be the typed RateLimitExceededError (not some other
  // surprise error from the runtime).
  for (const r of rejections) {
    assert.ok(
      r.status === 'rejected' && r.reason instanceof RateLimitExceededError,
      `expected RateLimitExceededError, got ${r.status === 'rejected' ? r.reason : '<resolved>'}`,
    );
  }
});

test('_configureForTests + module load: capacity override is observed', async () => {
  // Demonstrate the config override path tests use to simulate
  // P6_AGENT_RATE_LIMIT_PER_MIN. The env var itself is read once at module
  // load (so only an out-of-process restart picks up a real change); we
  // expose `_configureForTests` to exercise override behavior in this suite
  // without re-importing the module.
  reset({ capacity: 5, windowMs: 60_000, maxWaitMs: 50 });
  // 5 succeed immediately.
  for (let i = 0; i < 5; i++) {
    await rateLimitedAnthropicCall('tenant-override', 'A', () => Promise.resolve(i));
  }
  // 6th immediately exhausts (refill rate at 5/min is too slow for 50ms wait).
  await assert.rejects(
    () => rateLimitedAnthropicCall('tenant-override', 'A', () => Promise.resolve()),
    RateLimitExceededError,
  );
});
