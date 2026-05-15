import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAllowlist, mintMagicLinkToken, verifyToken } from './beta-auth.js';

test('parseAllowlist: empty string returns empty set', () => {
  assert.deepEqual([...parseAllowlist('')], []);
});

test('parseAllowlist: comma-separated emails are split + lowercased + trimmed', () => {
  const allowlist = parseAllowlist('Alice@Firm.com, BOB@Y.com ,  carol@z.io');
  assert.deepEqual([...allowlist].sort(), ['alice@firm.com', 'bob@y.com', 'carol@z.io']);
});

test('parseAllowlist: empty entries (double commas, trailing comma) are dropped', () => {
  const allowlist = parseAllowlist('a@x.com,,b@y.com,');
  assert.deepEqual([...allowlist].sort(), ['a@x.com', 'b@y.com']);
});

test('parseAllowlist: returns a Set so membership check is O(1)', () => {
  const allowlist = parseAllowlist('a@x.com,b@y.com');
  assert.ok(allowlist instanceof Set);
  assert.ok(allowlist.has('a@x.com'));
  assert.ok(!allowlist.has('c@z.com'));
});

const TEST_SECRET = 'a'.repeat(64); // 32 bytes hex = 64 chars

test('mintMagicLinkToken + verifyToken round-trip succeeds for the same email', async () => {
  const token = await mintMagicLinkToken('alice@firm.com', TEST_SECRET);
  const result = await verifyToken(token, 'beta-link', TEST_SECRET);
  assert.equal(result.email, 'alice@firm.com');
});

test('verifyToken: tampered token rejected', async () => {
  const token = await mintMagicLinkToken('alice@firm.com', TEST_SECRET);
  const tampered = token.slice(0, -3) + 'AAA';
  await assert.rejects(verifyToken(tampered, 'beta-link', TEST_SECRET));
});

test('verifyToken: wrong secret rejected', async () => {
  const token = await mintMagicLinkToken('alice@firm.com', TEST_SECRET);
  await assert.rejects(verifyToken(token, 'beta-link', 'b'.repeat(64)));
});
