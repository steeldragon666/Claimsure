import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mintSessionToken } from '@/lib/beta-auth';

const TEST_SECRET = 'a'.repeat(64);
process.env.BETA_AUTH_SECRET = TEST_SECRET;
process.env.BETA_GATE_ENABLED = '1';
process.env.NODE_ENV = 'production';

const { middleware } = await import('./middleware.js');

function makeReq(path: string, cookie?: string): Request {
  return new Request(`https://example.com${path}`, {
    method: 'GET',
    headers: cookie ? { cookie } : {},
  });
}

test('middleware: no cookie + /protected -> 302 to /beta-access?next=%2Fprotected', async () => {
  const res = await middleware(makeReq('/protected'));
  assert.equal(res.status, 302);
  const loc = res.headers.get('location') ?? '';
  assert.match(loc, /\/beta-access\?next=%2Fprotected/);
});

test('middleware: valid session cookie -> pass through (no redirect)', async () => {
  const token = await mintSessionToken('alice@firm.com', TEST_SECRET);
  const res = await middleware(makeReq('/protected', `beta_session=${token}`));
  assert.notEqual(res.status, 302);
});

test('middleware: tampered cookie -> 302 to /beta-access', async () => {
  const token = await mintSessionToken('alice@firm.com', TEST_SECRET);
  const tampered = token.slice(0, -3) + 'AAA';
  const res = await middleware(makeReq('/protected', `beta_session=${tampered}`));
  assert.equal(res.status, 302);
});

test('middleware: /api/beta/request bypasses (gate own routes)', async () => {
  const res = await middleware(makeReq('/api/beta/request'));
  assert.notEqual(res.status, 302);
});

test('middleware: /beta-access bypasses (the page itself)', async () => {
  const res = await middleware(makeReq('/beta-access'));
  assert.notEqual(res.status, 302);
});

test('middleware: BETA_GATE_ENABLED=0 -> pass through', async () => {
  process.env.BETA_GATE_ENABLED = '0';
  const res = await middleware(makeReq('/protected'));
  assert.notEqual(res.status, 302);
  process.env.BETA_GATE_ENABLED = '1';
});
