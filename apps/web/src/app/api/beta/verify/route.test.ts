import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mintMagicLinkToken } from '@/lib/beta-auth';

const TEST_SECRET = 'a'.repeat(64);
process.env.BETA_AUTH_SECRET = TEST_SECRET;

const { GET } = await import('./route.js');

function makeReq(query: Record<string, string>): Request {
  const url = new URL('https://example.com/api/beta/verify');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new Request(url, { method: 'GET' });
}

test('GET /api/beta/verify: valid token sets beta_session cookie + 302 to /', async () => {
  const token = await mintMagicLinkToken('alice@firm.com', TEST_SECRET);
  const res = await GET(makeReq({ token }));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/');
  const setCookie = res.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /^beta_session=eyJ/);
  assert.match(setCookie, /Max-Age=\d+/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Lax/);
});

test('GET /api/beta/verify: valid token + next=/dashboard -> 302 to /dashboard', async () => {
  const token = await mintMagicLinkToken('alice@firm.com', TEST_SECRET);
  const res = await GET(makeReq({ token, next: '/dashboard' }));
  assert.equal(res.headers.get('location'), '/dashboard');
});

test('GET /api/beta/verify: next=https://evil.com -> sanitized to /', async () => {
  const token = await mintMagicLinkToken('alice@firm.com', TEST_SECRET);
  const res = await GET(makeReq({ token, next: 'https://evil.com' }));
  assert.equal(res.headers.get('location'), '/');
});

test('GET /api/beta/verify: next=//evil.com -> sanitized to /', async () => {
  const token = await mintMagicLinkToken('alice@firm.com', TEST_SECRET);
  const res = await GET(makeReq({ token, next: '//evil.com' }));
  assert.equal(res.headers.get('location'), '/');
});

test('GET /api/beta/verify: tampered token -> 302 to /beta-access?error=invalid', async () => {
  const token = await mintMagicLinkToken('alice@firm.com', TEST_SECRET);
  const tampered = token.slice(0, -3) + 'AAA';
  const res = await GET(makeReq({ token: tampered }));
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location') ?? '', /\/beta-access\?error=invalid/);
});

test('GET /api/beta/verify: missing token -> 302 to /beta-access', async () => {
  const res = await GET(makeReq({}));
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location') ?? '', /^\/beta-access/);
});
