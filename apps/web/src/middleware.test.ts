import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mintSessionToken } from '@/lib/beta-auth';

const TEST_SECRET = 'a'.repeat(64);
process.env.BETA_AUTH_SECRET = TEST_SECRET;
process.env.BETA_GATE_ENABLED = '1';
(process.env as Record<string, string>).NODE_ENV = 'production';

const { middleware } = await import('./middleware.js');

function makeReq(path: string, cookie?: string): Request {
  return new Request(`https://example.com${path}`, {
    method: 'GET',
    headers: cookie ? { cookie } : {},
  });
}

/**
 * Pass-through assertion. `NextResponse.next()` sets the sentinel header
 * `x-middleware-next: 1` (Next.js framework contract). Checking for this
 * proves the middleware actually returned `NextResponse.next()` — NOT a
 * plain 200 Response which would short-circuit the request and render
 * an empty page to the client.
 *
 * If a future refactor drops back to `new Response(null, {status: 200})`,
 * these tests fail loudly, which is the point.
 */
function assertPassThrough(res: Response, label: string): void {
  assert.equal(res.headers.get('x-middleware-next'), '1', `${label}: not a NextResponse.next()`);
}

test('middleware: no cookie + /protected -> redirect to /beta-access?next=%2Fprotected', async () => {
  const res = await middleware(makeReq('/protected'));
  // NextResponse.redirect with status 302 may be normalized to 307 by
  // Next; accept either as long as a redirect is present.
  assert.ok(res.status === 302 || res.status === 307, `expected redirect, got ${res.status}`);
  const loc = res.headers.get('location') ?? '';
  assert.match(loc, /\/beta-access\?next=%2Fprotected/);
});

test('middleware: valid session cookie -> NextResponse.next() pass through', async () => {
  const token = await mintSessionToken('alice@firm.com', TEST_SECRET);
  const res = await middleware(makeReq('/protected', `beta_session=${token}`));
  assertPassThrough(res, 'valid session cookie');
});

test('middleware: tampered cookie -> redirect to /beta-access', async () => {
  const token = await mintSessionToken('alice@firm.com', TEST_SECRET);
  const tampered = token.slice(0, -3) + 'AAA';
  const res = await middleware(makeReq('/protected', `beta_session=${tampered}`));
  assert.ok(res.status === 302 || res.status === 307);
  assert.match(res.headers.get('location') ?? '', /\/beta-access/);
});

test('middleware: /api/beta/request bypasses (gate own routes) via NextResponse.next()', async () => {
  const res = await middleware(makeReq('/api/beta/request'));
  assertPassThrough(res, '/api/beta/request bypass');
});

test('middleware: /beta-access bypasses (the page itself) via NextResponse.next()', async () => {
  const res = await middleware(makeReq('/beta-access'));
  assertPassThrough(res, '/beta-access bypass');
});

test('middleware: public marketing and signup pages bypass beta gate', async () => {
  for (const path of ['/', '/signup', '/verify-email']) {
    const res = await middleware(makeReq(path));
    assertPassThrough(res, `${path} public bypass`);
  }
});

test('middleware: BETA_GATE_ENABLED=0 -> NextResponse.next() pass through', async () => {
  process.env.BETA_GATE_ENABLED = '0';
  const res = await middleware(makeReq('/protected'));
  assertPassThrough(res, 'BETA_GATE_ENABLED=0 kill switch');
  process.env.BETA_GATE_ENABLED = '1';
});

/**
 * Regression guard: catches the bug class we just fixed.
 *
 * If someone reverts to `new Response(null, { status: 200 })`, this test
 * fails with a clear error message. Documents the contract in test form.
 */
test('middleware: pass-through return is always NextResponse.next() (regression guard)', async () => {
  // Use the BETA_GATE_ENABLED=0 path because it's the simplest pass-through.
  process.env.BETA_GATE_ENABLED = '0';
  const res = await middleware(makeReq('/protected'));
  process.env.BETA_GATE_ENABLED = '1';
  assert.equal(
    res.headers.get('x-middleware-next'),
    '1',
    'pass-through MUST set x-middleware-next header (use NextResponse.next() not new Response())',
  );
  // And explicitly NOT a plain 200 with empty body — verify by checking
  // for the sentinel. If body is present and x-middleware-next is missing,
  // someone reverted to the short-circuit pattern.
  const bodyLen = (await res.text()).length;
  if (res.headers.get('x-middleware-next') !== '1' && bodyLen === 0 && res.status === 200) {
    assert.fail('middleware returned an empty 200 Response — would short-circuit the route!');
  }
});
