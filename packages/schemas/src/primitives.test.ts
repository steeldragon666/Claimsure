import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Uuid, Sha256Hash, Iso8601 } from './primitives.js';

test('Uuid accepts a valid UUID v4', () => {
  const v = '550e8400-e29b-41d4-a716-446655440000';
  assert.equal(Uuid.parse(v), v);
});

test('Uuid accepts a v1 UUID (RFC 9562 — validator is shape-only)', () => {
  // Commit 5051605 relaxed Uuid from v4-only to any RFC 9562 UUID after
  // a UUID v8 in workflow_state.agreed_by was wrongly rejected. v1 must
  // also pass for the same reason — the validator's job is shape, not
  // version. Routes that need v4 specifically should layer their own
  // check (see primitives.ts:14-19).
  const v = 'a8098c1a-f86e-11da-bd1a-00112444be1e';
  assert.equal(Uuid.parse(v), v);
});

test('Uuid accepts the nil UUID (RFC 9562 §5.9)', () => {
  // The nil UUID is a valid RFC 9562 sentinel and several call sites in
  // this codebase use it as the all-zeros tenant placeholder (see
  // pipeline test fixtures + dev-login fallback). Rejecting it here
  // would force those call sites to special-case the sentinel.
  const v = '00000000-0000-0000-0000-000000000000';
  assert.equal(Uuid.parse(v), v);
});

test('Uuid rejects a non-UUID string', () => {
  assert.throws(() => Uuid.parse('not-a-uuid'));
});

test('Sha256Hash accepts a 64-char lowercase hex string', () => {
  const v = 'a'.repeat(64);
  assert.equal(Sha256Hash.parse(v), v);
});

test('Sha256Hash rejects a 63-char string', () => {
  assert.throws(() => Sha256Hash.parse('a'.repeat(63)));
});

test('Sha256Hash rejects uppercase hex', () => {
  assert.throws(() => Sha256Hash.parse('A'.repeat(64)));
});

test('Iso8601 accepts UTC Z suffix', () => {
  const v = '2026-04-25T12:34:56Z';
  assert.equal(Iso8601.parse(v), v);
});

test('Iso8601 accepts numeric offset', () => {
  const v = '2026-04-25T22:34:56+10:00';
  assert.equal(Iso8601.parse(v), v);
});

test('Iso8601 rejects naive datetime (no offset)', () => {
  assert.throws(() => Iso8601.parse('2026-04-25T12:34:56'));
});

test('Iso8601 rejects date-only', () => {
  assert.throws(() => Iso8601.parse('2026-04-25'));
});
