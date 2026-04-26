// CRITICAL: env vars are set BEFORE the buildApp import below, because
// buildApp() conditionally registers the Microsoft route based on the
// presence of MICROSOFT_OIDC_CLIENT_ID + MICROSOFT_OIDC_CLIENT_SECRET.
// At import time of `../../app.js` Fastify itself is loaded, but the
// gating happens inside buildApp() so this ordering is enough — what
// matters is that the env is set before any test calls buildApp().
process.env['MICROSOFT_OIDC_TENANT'] = 'common';
process.env['MICROSOFT_OIDC_CLIENT_ID'] = 'test-ms-client-id';
process.env['MICROSOFT_OIDC_CLIENT_SECRET'] = 'test-ms-client-secret';
process.env['MICROSOFT_OIDC_REDIRECT_URI'] = 'http://localhost:3000/v1/auth/microsoft/callback';

import { test, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import nock from 'nock';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../../app.js';
import { mockMicrosoftIdp } from './test-fixtures.js';

// Use a t11- prefix to scope test rows; the after() hook deletes via
// LIKE 'microsoft:test-t11-%' so we don't trample real users.
const TEST_OID_FULL = 'test-t11-ms-oid-full';
const TEST_EMAIL_FULL = 't11-ms-full@example.com';
const TEST_OID_WHOAMI = 'test-t11-ms-oid-whoami';
const TEST_EMAIL_WHOAMI = 't11-ms-whoami@example.com';
const TENANT_ID_WHOAMI = '00000000-0000-4000-8000-00000000ab11';

// Block real network — any unmocked outbound HTTP request fails loudly
// instead of hanging on DNS for login.microsoftonline.com. Postgres
// uses the pg wire protocol over TCP, not HTTP, so it isn't touched
// by nock.disableNetConnect; localhost is also explicitly allow-listed
// just in case some library reaches into 127.0.0.1.
beforeEach(() => {
  nock.disableNetConnect();
  nock.enableNetConnect((host) => host.includes('localhost') || host.includes('127.0.0.1'));
});

afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

// Cleanup: pool drain + remove anything we INSERTed. The user table is
// global (no RLS), so the cpa_app sql client is sufficient. tenant_user
// rows for the whoami test are deleted via privilegedSql because RLS
// is forced on tenant_user and the seeding flow ran as cpa anyway.
// Each *.test.ts file runs in its own tsx subprocess (node:test default
// when given multiple files), so we close BOTH pools here — otherwise
// the open postgres connections keep node's event loop alive and the
// subprocess won't exit, hanging the runner.
after(async () => {
  await privilegedSql`DELETE FROM tenant_user WHERE user_id IN (
    SELECT id FROM "user" WHERE external_id LIKE 'microsoft:test-t11-%'
  )`;
  await sql`DELETE FROM "user" WHERE external_id LIKE 'microsoft:test-t11-%'`;
  await sql`DELETE FROM tenant WHERE id = ${TENANT_ID_WHOAMI}`;
  await sql.end();
  await privilegedSql.end();
});

// Extract the JSON-encoded handshake from the Set-Cookie response. The
// route writes one or more set-cookie headers; we want the encoded
// value (still URL-encoded) so it round-trips cleanly back into the
// callback request.
const HANDSHAKE_RE = /cpa_oidc_handshake_ms=([^;]+)/;
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

test('OIDC Microsoft: /login redirects to login.microsoftonline.com with PKCE+state+nonce', async () => {
  // /login still triggers Issuer.discover during route registration,
  // so the discovery + JWKS interceptors must be armed before app.ready()
  // resolves the deferred plugin.
  await mockMicrosoftIdp({
    tenantId: 'common',
    clientId: 'test-ms-client-id',
    claims: {
      sub: 'unused',
      email: 'unused@example.com',
      nonce: 'unused-nonce',
    },
    authCode: 'unused-code',
  });

  const app = buildApp();
  await app.ready();
  try {
    const res = await app.inject({ method: 'GET', url: '/v1/auth/microsoft/login' });
    assert.equal(res.statusCode, 302);
    const location = res.headers['location'];
    assert.ok(typeof location === 'string', 'Location header is a string');
    assert.match(location, /^https:\/\/login\.microsoftonline\.com\//);
    assert.match(location, /code_challenge_method=S256/);
    assert.match(location, /state=/);
    assert.match(location, /nonce=/);
    assert.match(location, /response_type=code/);
    assert.match(location, /client_id=test-ms-client-id/);

    const setCookie = res.headers['set-cookie'];
    const { parsed } = extractHandshakeCookie(setCookie);
    assert.ok(parsed.state.length > 0, 'state present in handshake');
    assert.ok(parsed.nonce.length > 0, 'nonce present in handshake');
    assert.ok(parsed.verifier.length > 0, 'verifier present in handshake');

    // The state in the URL matches the state in the handshake cookie —
    // tamper with either and the callback would 401.
    const urlState = location.match(/[?&]state=([^&]+)/);
    assert.ok(urlState && urlState[1], 'state extractable from redirect URL');
    assert.equal(decodeURIComponent(urlState[1]), parsed.state);
  } finally {
    await app.close();
  }
});

test('OIDC Microsoft: full callback flow creates user + sets session cookie', async () => {
  const app = buildApp();
  // Arm nock first; openid-client discovers during app.ready() (it's
  // wrapped in app.register(async (instance) => await registerMicrosoftAuth(...))
  // so the discovery hits nock once per buildApp call).
  await mockMicrosoftIdp({
    tenantId: 'common',
    clientId: 'test-ms-client-id',
    claims: {
      sub: TEST_OID_FULL,
      oid: TEST_OID_FULL,
      email: TEST_EMAIL_FULL,
      name: 'T11 MS Full',
      // nonce overridden below once we have the real handshake nonce
      nonce: 'placeholder',
    },
    authCode: 'test-auth-code',
  });
  await app.ready();
  try {
    // Step 1: /login to mint a handshake; capture state+nonce+verifier
    const loginRes = await app.inject({ method: 'GET', url: '/v1/auth/microsoft/login' });
    assert.equal(loginRes.statusCode, 302);
    const { encoded: handshakeEncoded, parsed: handshake } = extractHandshakeCookie(
      loginRes.headers['set-cookie'],
    );

    // Re-arm nock with the real nonce so the ID token's nonce claim
    // matches what client.callback() expects from the handshake. We
    // cleanAll first because the placeholder interceptors are still
    // installed with .persist().
    nock.cleanAll();
    await mockMicrosoftIdp({
      tenantId: 'common',
      clientId: 'test-ms-client-id',
      claims: {
        sub: TEST_OID_FULL,
        oid: TEST_OID_FULL,
        email: TEST_EMAIL_FULL,
        name: 'T11 MS Full',
        nonce: handshake.nonce,
      },
      authCode: 'test-auth-code',
    });

    // Step 2: callback with the matching state, send the handshake cookie
    const cbRes = await app.inject({
      method: 'GET',
      url: `/v1/auth/microsoft/callback?code=test-auth-code&state=${encodeURIComponent(handshake.state)}`,
      cookies: { cpa_oidc_handshake_ms: decodeURIComponent(handshakeEncoded) },
    });
    assert.equal(cbRes.statusCode, 302, 'callback redirects on success');
    assert.equal(cbRes.headers['location'], '/');

    const cbSetCookie = cbRes.headers['set-cookie'];
    const cbCookies = Array.isArray(cbSetCookie) ? cbSetCookie : [String(cbSetCookie)];
    const sessionLine = cbCookies.find((c) => /^cpa_session=[^;]/i.test(c));
    assert.ok(sessionLine, 'session cookie set on success');
    assert.match(sessionLine, /HttpOnly/i);
    assert.match(sessionLine, /SameSite=Lax/i);
    const handshakeClearLine = cbCookies.find((c) => /^cpa_oidc_handshake_ms=;/i.test(c));
    assert.ok(handshakeClearLine, 'handshake cookie cleared on success');
    assert.match(handshakeClearLine, /Max-Age=0/i);

    // The user row exists, with the email from the ID token claims
    const users = await sql<{ id: string; email: string }[]>`
      SELECT id, email FROM "user" WHERE external_id = ${'microsoft:' + TEST_OID_FULL}
    `;
    assert.equal(users.length, 1, 'user row created');
    assert.equal(users[0]?.email, TEST_EMAIL_FULL);
  } finally {
    await app.close();
  }
});

test('OIDC Microsoft: callback with mismatched state returns 401', async () => {
  // Discovery still required for route registration, but the token POST
  // is never reached because client.callback() throws on state mismatch
  // synchronously (well, before any HTTP).
  await mockMicrosoftIdp({
    tenantId: 'common',
    clientId: 'test-ms-client-id',
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
    // Forge a handshake with state-A; URL says state-B → openid-client
    // throws RPError("state mismatch"), the route catches and 401s.
    const fakeHandshake = JSON.stringify({
      state: 'state-A',
      nonce: 'nonce-A',
      verifier: 'verifier-A-at-least-43-chars-long-aaaaaaaaaaaa',
    });

    const cbRes = await app.inject({
      method: 'GET',
      url: '/v1/auth/microsoft/callback?code=any&state=state-B',
      cookies: { cpa_oidc_handshake_ms: fakeHandshake },
    });
    assert.equal(cbRes.statusCode, 401);
    const body = cbRes.json<{ error: string; message: string; requestId: string }>();
    assert.equal(body.error, 'oidc_failed');
  } finally {
    await app.close();
  }
});

test('OIDC Microsoft: whoami after login returns user + tenant info via session cookie', async () => {
  // Pre-seed a tenant + tenant_user membership so lookupActiveTenant()
  // returns a non-null active tenant. The user row itself is created by
  // findOrCreateUser during the callback — but we need to know the user
  // id to pre-seed tenant_user. So we INSERT the user up front (matching
  // the same external_id the callback would derive), then INSERT the
  // tenant_user, then drive the OIDC flow which will UPDATE last_login_at
  // (the ON CONFLICT branch in findOrCreateUser).
  await sql`
    INSERT INTO tenant (id, name, slug, primary_idp)
    VALUES (${TENANT_ID_WHOAMI}, 'T11 Whoami Firm', 't11-whoami-firm', 'microsoft')
  `;
  const seededUsers = await sql<{ id: string }[]>`
    INSERT INTO "user" (id, email, primary_idp, external_id)
    VALUES (gen_random_uuid(), ${TEST_EMAIL_WHOAMI}, 'microsoft', ${'microsoft:' + TEST_OID_WHOAMI})
    RETURNING id
  `;
  const seededUserId = seededUsers[0]?.id;
  assert.ok(seededUserId, 'seeded user has id');
  await privilegedSql`
    INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
    VALUES (gen_random_uuid(), ${TENANT_ID_WHOAMI}, ${seededUserId}, 'consultant', true)
  `;

  const app = buildApp();
  await mockMicrosoftIdp({
    tenantId: 'common',
    clientId: 'test-ms-client-id',
    claims: {
      sub: TEST_OID_WHOAMI,
      oid: TEST_OID_WHOAMI,
      email: TEST_EMAIL_WHOAMI,
      name: 'T11 MS Whoami',
      nonce: 'placeholder',
    },
    authCode: 'whoami-code',
  });
  await app.ready();
  try {
    // Login — capture handshake
    const loginRes = await app.inject({ method: 'GET', url: '/v1/auth/microsoft/login' });
    assert.equal(loginRes.statusCode, 302);
    const { encoded: handshakeEncoded, parsed: handshake } = extractHandshakeCookie(
      loginRes.headers['set-cookie'],
    );

    // Re-arm with real nonce so client.callback's nonce check passes
    nock.cleanAll();
    await mockMicrosoftIdp({
      tenantId: 'common',
      clientId: 'test-ms-client-id',
      claims: {
        sub: TEST_OID_WHOAMI,
        oid: TEST_OID_WHOAMI,
        email: TEST_EMAIL_WHOAMI,
        name: 'T11 MS Whoami',
        nonce: handshake.nonce,
      },
      authCode: 'whoami-code',
    });

    // Callback — yields cpa_session cookie
    const cbRes = await app.inject({
      method: 'GET',
      url: `/v1/auth/microsoft/callback?code=whoami-code&state=${encodeURIComponent(handshake.state)}`,
      cookies: { cpa_oidc_handshake_ms: decodeURIComponent(handshakeEncoded) },
    });
    assert.equal(cbRes.statusCode, 302);
    const cbCookies = Array.isArray(cbRes.headers['set-cookie'])
      ? cbRes.headers['set-cookie']
      : [String(cbRes.headers['set-cookie'])];
    const sessionLine = cbCookies.find((c) => /^cpa_session=/.test(c));
    assert.ok(sessionLine, 'session cookie present');
    const sessionMatch = sessionLine.match(/^cpa_session=([^;]+)/);
    assert.ok(sessionMatch && sessionMatch[1], 'session JWT extractable');
    const sessionJwt = sessionMatch[1];

    // Whoami — sees user, active tenant, and the membership row
    const whoamiRes = await app.inject({
      method: 'GET',
      url: '/v1/whoami',
      cookies: { cpa_session: sessionJwt },
    });
    assert.equal(whoamiRes.statusCode, 200);
    const body = whoamiRes.json<{
      user: { id: string; email: string; tenantId: string; role: string };
      availableTenants: Array<{
        tenantId: string;
        name: string;
        slug: string;
        role: string;
        isDefault: boolean;
      }>;
    }>();
    assert.equal(body.user.id, seededUserId);
    assert.equal(body.user.email, TEST_EMAIL_WHOAMI);
    assert.equal(body.user.tenantId, TENANT_ID_WHOAMI);
    assert.equal(body.user.role, 'consultant');
    assert.equal(body.availableTenants.length, 1);
    assert.equal(body.availableTenants[0]?.tenantId, TENANT_ID_WHOAMI);
    assert.equal(body.availableTenants[0]?.role, 'consultant');
    assert.equal(body.availableTenants[0]?.isDefault, true);
  } finally {
    await app.close();
  }
});
