import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { signSession } from '@cpa/auth';
import { sql } from '@cpa/db/client';
import { buildApp } from '../../app.js';

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

after(async () => {
  await sql.end();
});

test('POST /v1/auth/signout: with valid session, clears cookie and returns 204', async () => {
  const jwt = await signSession(
    {
      sub: '00000000-0000-4000-8000-00000000d901',
      email: 'signout-test@example.com',
      primaryIdp: 'microsoft',
      activeTenantId: null,
      activeRole: null,
      availableTenants: [],
    },
    SESSION_SECRET,
    { ttlSeconds: 3600 },
  );
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/signout',
    cookies: { cpa_session: jwt },
  });
  assert.equal(res.statusCode, 204);
  const setCookie = res.headers['set-cookie'];
  const setCookieStr = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie);
  assert.match(setCookieStr, /cpa_session=;/, 'cookie name cleared');
  assert.match(setCookieStr, /Max-Age=0/, 'expiry zeroed');
  assert.match(setCookieStr, /HttpOnly/, 'still HttpOnly');
  assert.match(setCookieStr, /SameSite=Lax/i, 'still sameSite=Lax');
  await app.close();
});

test('POST /v1/auth/signout: works without an existing cookie (idempotent for never-logged-in case)', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'POST', url: '/v1/auth/signout' });
  assert.equal(res.statusCode, 204);
  const setCookie = res.headers['set-cookie'];
  const setCookieStr = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie);
  assert.match(setCookieStr, /cpa_session=;.*Max-Age=0/, 'still clears cookie');
  await app.close();
});
