import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Uuid, Sha256Hash } from './primitives.js';

test('Uuid accepts a valid UUID v4', () => {
  const v = '550e8400-e29b-41d4-a716-446655440000';
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
