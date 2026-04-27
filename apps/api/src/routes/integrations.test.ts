import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nock from 'nock';
import { signSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import { decryptToken } from '@cpa/integrations/runtime';
import { buildApp } from '../app.js';

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

const TENANT_A = '00000000-0000-4000-8000-0000000b3001';
const TENANT_B = '00000000-0000-4000-8000-0000000b3002';
const ADMIN_USER = '00000000-0000-4000-8000-0000000b3010';
const VIEWER_USER = '00000000-0000-4000-8000-0000000b3011';
const CONSULTANT_USER = '00000000-0000-4000-8000-0000000b3012';

// 32-byte hex (64 chars) — pinned for the test run so cookies + DB reads
// reproduce. process.env mutation is restored in `after`.
const TEST_ENC_KEY = crypto.randomBytes(32).toString('hex');

const cleanup = async (): Promise<void> => {
  await privilegedSql`DELETE FROM integration_connection WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await sql`DELETE FROM "user" WHERE id IN (${ADMIN_USER}, ${VIEWER_USER}, ${CONSULTANT_USER})`;
  await sql`DELETE FROM tenant WHERE id IN (${TENANT_A}, ${TENANT_B})`;
};

before(async () => {
  await cleanup();
  process.env['TOKEN_ENCRYPTION_KEY'] = TEST_ENC_KEY;
  process.env['DOCUSIGN_CLIENT_ID'] = 'test-docusign-client-id';
  process.env['DOCUSIGN_CLIENT_SECRET'] = 'test-docusign-client-secret';
  process.env['DOCUSIGN_REDIRECT_URI'] = 'http://localhost:3000/v1/integrations/docusign/callback';
  process.env['DOCUSIGN_AUTH_BASE_URL'] = 'https://account-d.docusign.com';

  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT_A}, 'Firm A', 'firm-a-b3', 'mixed'),
                   (${TENANT_B}, 'Firm B', 'firm-b-b3', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${ADMIN_USER}, 'b3-admin@example.com', 'microsoft', 'microsoft:b3-admin', 'B3 Admin'),
                   (${VIEWER_USER}, 'b3-viewer@example.com', 'microsoft', 'microsoft:b3-viewer', 'B3 Viewer'),
                   (${CONSULTANT_USER}, 'b3-cons@example.com', 'microsoft', 'microsoft:b3-cons', 'B3 Consultant')`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT_A}, ${ADMIN_USER}, 'admin', true),
                              (gen_random_uuid(), ${TENANT_A}, ${VIEWER_USER}, 'viewer', true),
                              (gen_random_uuid(), ${TENANT_A}, ${CONSULTANT_USER}, 'consultant', true)`;
});

after(async () => {
  await cleanup();
  await sql.end();
  await privilegedSql.end();
  nock.cleanAll();
  nock.enableNetConnect();
});

const jwtFor = (
  userId: string,
  email: string,
  role: 'admin' | 'consultant' | 'viewer',
): Promise<string> =>
  signSession(
    {
      sub: userId,
      email,
      primaryIdp: 'microsoft',
      activeTenantId: TENANT_A,
      activeRole: role,
      availableTenants: [],
    },
    SESSION_SECRET,
    { ttlSeconds: 3600 },
  );

const adminJwt = (): Promise<string> => jwtFor(ADMIN_USER, 'b3-admin@example.com', 'admin');
const viewerJwt = (): Promise<string> => jwtFor(VIEWER_USER, 'b3-viewer@example.com', 'viewer');
const consultantJwt = (): Promise<string> =>
  jwtFor(CONSULTANT_USER, 'b3-cons@example.com', 'consultant');

test('GET /v1/integrations: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/v1/integrations' });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('GET /v1/integrations: 200 with empty list when no connections', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/integrations',
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ integrations: unknown[] }>();
  assert.deepEqual(body.integrations, []);
  await app.close();
});

test('GET /v1/integrations: RLS-filtered to active firm', async () => {
  // Seed a connection for firm B that admin (in firm A) must NOT see.
  await privilegedSql`
    INSERT INTO integration_connection (
      id, tenant_id, provider, access_token_encrypted, expires_at, sync_state
    ) VALUES (
      gen_random_uuid(), ${TENANT_B}, 'docusign', 'firmb-ciphertext',
      NOW() + INTERVAL '1 hour', 'idle'
    )
  `;
  // And a connection for firm A that admin SHOULD see.
  await privilegedSql`
    INSERT INTO integration_connection (
      id, tenant_id, provider, access_token_encrypted, expires_at, sync_state
    ) VALUES (
      gen_random_uuid(), ${TENANT_A}, 'docusign', 'firma-ciphertext',
      NOW() + INTERVAL '1 hour', 'idle'
    )
  `;
  try {
    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/integrations',
      cookies: { cpa_session: await adminJwt() },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{ integrations: Array<{ tenant_id: string; provider: string }> }>();
    assert.equal(body.integrations.length, 1);
    assert.equal(body.integrations[0]?.tenant_id, TENANT_A);
    assert.equal(body.integrations[0]?.provider, 'docusign');
    await app.close();
  } finally {
    await privilegedSql`DELETE FROM integration_connection WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  }
});

test('POST /v1/integrations/:provider/connect: returns redirect URL with state + PKCE challenge', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/integrations/docusign/connect',
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ redirect_url: string }>();
  const url = new URL(body.redirect_url);
  assert.equal(url.origin + url.pathname, 'https://account-d.docusign.com/oauth/auth');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'test-docusign-client-id');
  assert.ok(url.searchParams.get('state'));
  assert.ok(url.searchParams.get('code_challenge'));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');

  // The state cookie must be set on the response.
  const setCookie = res.headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
  assert.ok(cookies.some((c) => typeof c === 'string' && c.startsWith('cpa_oauth_docusign=')));
  await app.close();
});

test('POST /v1/integrations/:provider/connect: 403 for viewer role', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/integrations/docusign/connect',
    cookies: { cpa_session: await viewerJwt() },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('POST /v1/integrations/:provider/connect: 400 for unknown provider', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/integrations/notreal/connect',
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('GET /v1/integrations/:provider/callback: 400 on state mismatch', async () => {
  const app = buildApp();
  const stash = JSON.stringify({ state: 'real-state', verifier: 'pkce-verifier' });
  const res = await app.inject({
    method: 'GET',
    url: '/v1/integrations/docusign/callback?code=abc&state=different-state',
    cookies: {
      cpa_session: await consultantJwt(),
      cpa_oauth_docusign: stash,
    },
  });
  assert.equal(res.statusCode, 400);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'oauth_state_mismatch');
  await app.close();
});

test('GET /v1/integrations/:provider/callback: 400 on missing state cookie', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/integrations/docusign/callback?code=abc&state=foo',
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(res.statusCode, 400);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'oauth_state_expired');
  await app.close();
});

test('GET /v1/integrations/:provider/callback: success → encrypts tokens, upserts row, 302', async () => {
  // Mock DocuSign's token endpoint.
  nock('https://account-d.docusign.com')
    .post('/oauth/token')
    .reply(200, {
      access_token: 'fake-access-token-12345',
      refresh_token: 'fake-refresh-token-67890',
      expires_in: 3600,
      scope: 'signature impersonation',
    });

  const stash = JSON.stringify({ state: 'real-state', verifier: 'pkce-verifier' });
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/integrations/docusign/callback?code=abc-code&state=real-state',
    cookies: {
      cpa_session: await consultantJwt(),
      cpa_oauth_docusign: stash,
    },
  });
  assert.equal(res.statusCode, 302);
  assert.match(res.headers['location'] as string, /docusign/);

  // The integration_connection row should exist with encrypted tokens.
  const rows = await privilegedSql<{
    access_token_encrypted: string;
    refresh_token_encrypted: string | null;
  }[]>`
    SELECT access_token_encrypted, refresh_token_encrypted
      FROM integration_connection
     WHERE tenant_id = ${TENANT_A} AND provider = 'docusign'
  `;
  assert.equal(rows.length, 1);
  // Encryption-at-rest: the column never holds plaintext.
  assert.notEqual(rows[0]!.access_token_encrypted, 'fake-access-token-12345');
  // And it round-trips through decryptToken.
  const decryptedAccess = decryptToken(rows[0]!.access_token_encrypted, TEST_ENC_KEY);
  assert.equal(decryptedAccess, 'fake-access-token-12345');
  const decryptedRefresh = decryptToken(rows[0]!.refresh_token_encrypted!, TEST_ENC_KEY);
  assert.equal(decryptedRefresh, 'fake-refresh-token-67890');

  // Cleanup for subsequent tests.
  await privilegedSql`DELETE FROM integration_connection WHERE tenant_id = ${TENANT_A}`;
  nock.cleanAll();
  await app.close();
});

test('DELETE /v1/integrations/:provider: archives the row', async () => {
  // Seed an active connection.
  await privilegedSql`
    INSERT INTO integration_connection (
      id, tenant_id, provider, access_token_encrypted, expires_at, sync_state
    ) VALUES (
      gen_random_uuid(), ${TENANT_A}, 'docusign', 'plaintext-stub',
      NOW() + INTERVAL '1 hour', 'idle'
    )
  `;
  try {
    const app = buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/integrations/docusign',
      cookies: { cpa_session: await adminJwt() },
    });
    assert.equal(res.statusCode, 204);

    const rows = await privilegedSql<{
      access_token_encrypted: string;
      sync_state: string;
      last_error: string | null;
    }[]>`
      SELECT access_token_encrypted, sync_state, last_error
        FROM integration_connection
       WHERE tenant_id = ${TENANT_A} AND provider = 'docusign'
    `;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.sync_state, 'failed');
    assert.equal(rows[0]?.last_error, 'revoked');
    assert.equal(rows[0]?.access_token_encrypted, '');
    await app.close();
  } finally {
    await privilegedSql`DELETE FROM integration_connection WHERE tenant_id = ${TENANT_A}`;
  }
});

test('DELETE /v1/integrations/:provider: 404 when no connection', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'DELETE',
    url: '/v1/integrations/docusign',
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});
