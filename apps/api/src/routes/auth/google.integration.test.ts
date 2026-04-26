// CRITICAL: Google OIDC route registration is gated on
// GOOGLE_OIDC_CLIENT_ID + GOOGLE_OIDC_CLIENT_SECRET — set BEFORE the
// buildApp import. Microsoft env vars are deliberately left UNSET in
// this file so that buildApp() in this test file does not also register
// the Microsoft route (each .test.ts file is its own tsx process so
// process.env mutations don't bleed across files).
process.env['GOOGLE_OIDC_CLIENT_ID'] = 'test-g-client-id';
process.env['GOOGLE_OIDC_CLIENT_SECRET'] = 'test-g-client-secret';
process.env['GOOGLE_OIDC_REDIRECT_URI'] = 'http://localhost:3000/v1/auth/google/callback';

import { test, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import nock from 'nock';
import { sql } from '@cpa/db/client';
import { buildApp } from '../../app.js';
import { mockGoogleIdp } from './test-fixtures.js';

const TEST_SUB = 'test-t11-g-sub';
const TEST_EMAIL = 't11-g@example.com';

beforeEach(() => {
  nock.disableNetConnect();
  nock.enableNetConnect((host) => host.includes('localhost') || host.includes('127.0.0.1'));
});

afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

// Each *.test.ts file runs in its own tsx subprocess (node:test default
// when given multiple files), so we DO need sql.end() here — otherwise
// the postgres pool keeps node's event loop alive and the subprocess
// won't exit, hanging the runner.
after(async () => {
  await sql`DELETE FROM "user" WHERE external_id LIKE 'google:test-t11-%'`;
  await sql.end();
});

const HANDSHAKE_RE = /cpa_oidc_handshake_g=([^;]+)/;
function extractHandshakeCookie(setCookie: string | string[] | undefined): {
  encoded: string;
  parsed: { state: string; nonce: string; verifier: string };
} {
  const lines = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
  for (const line of lines) {
    const m = line.match(HANDSHAKE_RE);
    if (m && m[1] && m[1].length > 0) {
      const encoded = m[1];
      const parsed = JSON.parse(decodeURIComponent(encoded)) as {
        state: string;
        nonce: string;
        verifier: string;
      };
      return { encoded, parsed };
    }
  }
  throw new Error('handshake cookie not found in set-cookie response');
}

test('OIDC Google: full callback flow creates user + sets session cookie', async () => {
  const app = buildApp();
  // Arm nock for discovery+JWKS+token before app.ready resolves the
  // deferred Issuer.discover. The placeholder nonce is replaced once we
  // capture the real handshake nonce from the /login response.
  await mockGoogleIdp({
    clientId: 'test-g-client-id',
    claims: {
      sub: TEST_SUB,
      email: TEST_EMAIL,
      name: 'T11 G User',
      nonce: 'placeholder',
    },
    authCode: 'test-g-code',
  });
  await app.ready();
  try {
    const loginRes = await app.inject({ method: 'GET', url: '/v1/auth/google/login' });
    assert.equal(loginRes.statusCode, 302);
    const location = loginRes.headers['location'];
    assert.ok(typeof location === 'string', 'Location header is a string');
    assert.match(location, /^https:\/\/accounts\.google\.com\//);
    assert.match(location, /code_challenge_method=S256/);

    const { encoded: handshakeEncoded, parsed: handshake } = extractHandshakeCookie(
      loginRes.headers['set-cookie'],
    );

    // Re-arm with the real nonce so the ID token validates
    nock.cleanAll();
    await mockGoogleIdp({
      clientId: 'test-g-client-id',
      claims: {
        sub: TEST_SUB,
        email: TEST_EMAIL,
        name: 'T11 G User',
        nonce: handshake.nonce,
      },
      authCode: 'test-g-code',
    });

    const cbRes = await app.inject({
      method: 'GET',
      url: `/v1/auth/google/callback?code=test-g-code&state=${encodeURIComponent(handshake.state)}`,
      cookies: { cpa_oidc_handshake_g: decodeURIComponent(handshakeEncoded) },
    });
    assert.equal(cbRes.statusCode, 302, 'callback redirects on success');
    assert.equal(cbRes.headers['location'], '/');

    const cbCookies = Array.isArray(cbRes.headers['set-cookie'])
      ? cbRes.headers['set-cookie']
      : [String(cbRes.headers['set-cookie'])];
    const sessionLine = cbCookies.find((c) => /^cpa_session=[^;]/i.test(c));
    assert.ok(sessionLine, 'session cookie set on success');
    assert.match(sessionLine, /HttpOnly/i);
    assert.match(sessionLine, /SameSite=Lax/i);
    const handshakeClearLine = cbCookies.find((c) => /^cpa_oidc_handshake_g=;/i.test(c));
    assert.ok(handshakeClearLine, 'handshake cookie cleared on success');
    assert.match(handshakeClearLine, /Max-Age=0/i);

    // user row created with the google: prefix and `sub` (not `oid`)
    const users = await sql<{ id: string; email: string; primary_idp: string }[]>`
      SELECT id, email, primary_idp FROM "user" WHERE external_id = ${'google:' + TEST_SUB}
    `;
    assert.equal(users.length, 1, 'user row created');
    assert.equal(users[0]?.email, TEST_EMAIL);
    assert.equal(users[0]?.primary_idp, 'google');
  } finally {
    await app.close();
  }
});

test('OIDC Google: callback without handshake cookie returns 400 missing_handshake', async () => {
  // Discovery still runs at app.ready() (Issuer.discover happens inside
  // the registerGoogleAuth plugin), so we need the discovery + JWKS
  // interceptors armed even though we never reach the token POST.
  await mockGoogleIdp({
    clientId: 'test-g-client-id',
    claims: {
      sub: 'unused',
      email: 'unused@example.com',
      nonce: 'unused',
    },
    authCode: 'unused',
  });

  const app = buildApp();
  await app.ready();
  try {
    // No cpa_oidc_handshake_g cookie — handler short-circuits on the
    // missing-cookie branch before any openid-client work.
    const cbRes = await app.inject({
      method: 'GET',
      url: '/v1/auth/google/callback?code=any&state=any-state',
    });
    assert.equal(cbRes.statusCode, 400);
    const body = cbRes.json<{ error: string; message: string; requestId: string }>();
    assert.equal(body.error, 'missing_handshake');
  } finally {
    await app.close();
  }
});
