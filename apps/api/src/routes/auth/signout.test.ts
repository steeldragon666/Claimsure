import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from '@cpa/db/client';
import { buildApp } from '../../app.js';

after(async () => {
  await sql.end();
});

test('POST /v1/auth/signout: clears cookie and returns 204', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/signout',
    cookies: { cpa_session: 'doesnt-matter-stateless' },
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

test('POST /v1/auth/signout: works without an existing cookie (idempotent)', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'POST', url: '/v1/auth/signout' });
  assert.equal(res.statusCode, 204);
  await app.close();
});
