import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { _resetRateLimitForTests, tryAcquire } from './rate-limit.js';

beforeEach(() => {
  _resetRateLimitForTests();
});

test('first acquire seeds bucket at full capacity', () => {
  const opts = { capacity: 5, refill_per_second: 1 };
  for (let i = 0; i < 5; i++) {
    assert.equal(tryAcquire('tenant1:provider', opts), true, `acquire #${i + 1}`);
  }
  assert.equal(
    tryAcquire('tenant1:provider', opts),
    false,
    'sixth acquire fails — bucket empty',
  );
});

test('different keys have independent buckets', () => {
  const opts = { capacity: 2, refill_per_second: 1 };
  assert.equal(tryAcquire('a', opts), true);
  assert.equal(tryAcquire('a', opts), true);
  assert.equal(tryAcquire('a', opts), false);
  // Key 'b' is unaffected.
  assert.equal(tryAcquire('b', opts), true);
  assert.equal(tryAcquire('b', opts), true);
  assert.equal(tryAcquire('b', opts), false);
});

test('bucket refills over time', () => {
  const opts = { capacity: 3, refill_per_second: 2 };
  const realNow = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  try {
    // Drain the bucket.
    assert.equal(tryAcquire('k', opts), true);
    assert.equal(tryAcquire('k', opts), true);
    assert.equal(tryAcquire('k', opts), true);
    assert.equal(tryAcquire('k', opts), false);

    // Advance 1 second — 2 tokens refilled.
    now += 1000;
    assert.equal(tryAcquire('k', opts), true);
    assert.equal(tryAcquire('k', opts), true);
    assert.equal(tryAcquire('k', opts), false);
  } finally {
    Date.now = realNow;
  }
});

test('refill is capped at capacity', () => {
  const opts = { capacity: 4, refill_per_second: 10 };
  const realNow = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  try {
    // Drain.
    for (let i = 0; i < 4; i++) assert.equal(tryAcquire('k', opts), true);
    assert.equal(tryAcquire('k', opts), false);
    // Advance 60s — would refill 600 tokens, but capacity is 4.
    now += 60_000;
    for (let i = 0; i < 4; i++) {
      assert.equal(tryAcquire('k', opts), true, `post-refill #${i + 1}`);
    }
    assert.equal(tryAcquire('k', opts), false, 'fifth fails — capped');
  } finally {
    Date.now = realNow;
  }
});

test('partial refill — fractional tokens accumulate', () => {
  const opts = { capacity: 5, refill_per_second: 1 };
  const realNow = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  try {
    for (let i = 0; i < 5; i++) assert.equal(tryAcquire('k', opts), true);
    assert.equal(tryAcquire('k', opts), false);
    // Advance 500ms — half a token, not enough.
    now += 500;
    assert.equal(tryAcquire('k', opts), false);
    // Another 500ms — total 1 token, enough.
    now += 500;
    assert.equal(tryAcquire('k', opts), true);
  } finally {
    Date.now = realNow;
  }
});
