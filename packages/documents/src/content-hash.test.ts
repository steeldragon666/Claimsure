import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentHash } from './content-hash.js';

test('contentHash: deterministic for same input', () => {
  const a = contentHash({ x: 1, y: 'hello' });
  const b = contentHash({ x: 1, y: 'hello' });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('contentHash: same hash regardless of key order', () => {
  const a = contentHash({ x: 1, y: 2, z: 3 });
  const b = contentHash({ z: 3, y: 2, x: 1 });
  const c = contentHash({ y: 2, x: 1, z: 3 });
  assert.equal(a, b);
  assert.equal(a, c);
});

test('contentHash: nested objects sorted recursively', () => {
  const a = contentHash({ outer: { x: 1, y: 2 } });
  const b = contentHash({ outer: { y: 2, x: 1 } });
  assert.equal(a, b);
});

test('contentHash: arrays preserve order (positional, not keyed)', () => {
  const a = contentHash([1, 2, 3]);
  const b = contentHash([3, 2, 1]);
  assert.notEqual(a, b);
});

test('contentHash: rejects NaN', () => {
  assert.throws(() => contentHash({ value: NaN }), /non-finite number/);
});

test('contentHash: rejects Infinity', () => {
  assert.throws(() => contentHash({ value: Infinity }), /non-finite number/);
});

test('contentHash: known value (regression anchor)', () => {
  // Lock the hash for a stable input. If anyone changes the canonical
  // algorithm and breaks the chain.ts side too, both this test AND the
  // F6 regression-anchor in chain.test.ts will fail simultaneously,
  // alerting reviewers to coordinate the change.
  const h = contentHash({ doc_kind: 'rdti_application', claim_id: 'c-1' });
  assert.match(h, /^[0-9a-f]{64}$/);
  // Discovery method: the initial run produced this hex digest; locking
  // it here turns the test into a regression anchor for the algorithm.
  assert.equal(h, 'ac05e4789a9ecd997f417de38af57e193cc36a0130e84ef991e2585be5d56a28');
});
