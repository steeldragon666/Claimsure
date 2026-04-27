import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { decryptToken, encryptToken, getTokenEncryptionKey } from './crypto.js';

const KEY = crypto.randomBytes(32).toString('hex');

test('encryptToken → decryptToken round-trips arbitrary plaintext', () => {
  const plaintext = 'super-secret-oauth-access-token-abc123';
  const blob = encryptToken(plaintext, KEY);
  assert.equal(decryptToken(blob, KEY), plaintext);
});

test('encryptToken produces different ciphertexts for the same plaintext (fresh IV)', () => {
  const plaintext = 'same-plaintext';
  const a = encryptToken(plaintext, KEY);
  const b = encryptToken(plaintext, KEY);
  assert.notEqual(a, b);
  // Both still decrypt back to the same plaintext.
  assert.equal(decryptToken(a, KEY), plaintext);
  assert.equal(decryptToken(b, KEY), plaintext);
});

test('decryptToken rejects tampered ciphertext via GCM auth tag', () => {
  const plaintext = 'tamper-me';
  const blob = encryptToken(plaintext, KEY);
  // Flip one hex char in the ciphertext segment.
  const [iv, tag, ct] = blob.split('.');
  const tampered = `${iv}.${tag}.${ct!.slice(0, -1)}${ct!.slice(-1) === 'a' ? 'b' : 'a'}`;
  assert.throws(() => decryptToken(tampered, KEY));
});

test('decryptToken rejects tampered auth tag', () => {
  const plaintext = 'tamper-tag';
  const blob = encryptToken(plaintext, KEY);
  const [iv, tag, ct] = blob.split('.');
  const flipped = tag!.slice(0, -1) + (tag!.slice(-1) === 'a' ? 'b' : 'a');
  const tampered = `${iv}.${flipped}.${ct}`;
  assert.throws(() => decryptToken(tampered, KEY));
});

test('decryptToken rejects malformed blob (wrong segment count)', () => {
  assert.throws(() => decryptToken('only-one-segment', KEY), /malformed/);
  assert.throws(() => decryptToken('a.b', KEY), /malformed/);
  assert.throws(() => decryptToken('a..b', KEY), /malformed/);
});

test('encryptToken throws on a too-short key', () => {
  const shortKey = crypto.randomBytes(16).toString('hex');
  assert.throws(() => encryptToken('x', shortKey), /32 bytes hex/);
});

test('decryptToken throws on a too-short key', () => {
  const shortKey = crypto.randomBytes(16).toString('hex');
  assert.throws(() => decryptToken('aa.bb.cc', shortKey), /32 bytes hex/);
});

test('getTokenEncryptionKey reads from env', () => {
  const prev = process.env['TOKEN_ENCRYPTION_KEY'];
  process.env['TOKEN_ENCRYPTION_KEY'] = KEY;
  try {
    assert.equal(getTokenEncryptionKey(), KEY);
  } finally {
    if (prev === undefined) delete process.env['TOKEN_ENCRYPTION_KEY'];
    else process.env['TOKEN_ENCRYPTION_KEY'] = prev;
  }
});

test('getTokenEncryptionKey throws when env unset', () => {
  const prev = process.env['TOKEN_ENCRYPTION_KEY'];
  delete process.env['TOKEN_ENCRYPTION_KEY'];
  try {
    assert.throws(() => getTokenEncryptionKey(), /required/);
  } finally {
    if (prev !== undefined) process.env['TOKEN_ENCRYPTION_KEY'] = prev;
  }
});
