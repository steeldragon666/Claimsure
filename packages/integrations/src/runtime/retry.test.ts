import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry } from './retry.js';

test('withRetry returns immediately on first success', async () => {
  let calls = 0;
  const r = await withRetry(() => {
    calls += 1;
    return Promise.resolve('ok');
  });
  assert.equal(r, 'ok');
  assert.equal(calls, 1);
});

test('withRetry retries until success and returns the result', async () => {
  let calls = 0;
  const r = await withRetry(
    () => {
      calls += 1;
      if (calls < 4) return Promise.reject(new Error('transient'));
      return Promise.resolve(42);
    },
    { initial_delay_ms: 1, max_delay_ms: 5, max_attempts: 5, jitter_ratio: 0 },
  );
  assert.equal(r, 42);
  assert.equal(calls, 4);
});

test('withRetry rethrows the last error after exhausting attempts', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      () => {
        calls += 1;
        return Promise.reject(new Error(`fail ${calls}`));
      },
      { max_attempts: 3, initial_delay_ms: 1, max_delay_ms: 5, jitter_ratio: 0 },
    ),
    /fail 3/,
  );
  assert.equal(calls, 3);
});

test('withRetry delay grows exponentially (jitter=0)', async () => {
  // Stub setTimeout to capture scheduled delays without actually waiting.
  const delays: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((cb: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    return realSetTimeout(cb, 0);
  }) as typeof globalThis.setTimeout;
  try {
    let calls = 0;
    await assert.rejects(
      withRetry(
        () => {
          calls += 1;
          return Promise.reject(new Error('always'));
        },
        { max_attempts: 4, initial_delay_ms: 100, max_delay_ms: 10_000, jitter_ratio: 0 },
      ),
    );
    assert.equal(calls, 4);
    // 3 delays scheduled (between 4 attempts); each is initial * 2^attempt.
    assert.deepEqual(delays, [100, 200, 400]);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test('withRetry respects max_delay_ms cap', async () => {
  const delays: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((cb: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    return realSetTimeout(cb, 0);
  }) as typeof globalThis.setTimeout;
  try {
    await assert.rejects(
      withRetry(() => Promise.reject(new Error('x')), {
        max_attempts: 5,
        initial_delay_ms: 1000,
        max_delay_ms: 1500,
        jitter_ratio: 0,
      }),
    );
    // Without cap, delays would be [1000, 2000, 4000, 8000]. Cap clamps to 1500.
    assert.deepEqual(delays, [1000, 1500, 1500, 1500]);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});
