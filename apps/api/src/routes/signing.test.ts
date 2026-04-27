import { test, after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nock from 'nock';
import { signSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import { encryptToken } from '@cpa/integrations/runtime';
import { buildApp } from '../app.js';

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

const TENANT_A = '00000000-0000-4000-8000-0000000b6001';
const TENANT_B = '00000000-0000-4000-8000-0000000b6002';
const ADMIN_USER = '00000000-0000-4000-8000-0000000b6010';
const VIEWER_USER = '00000000-0000-4000-8000-0000000b6011';
const CONSULTANT_USER = '00000000-0000-4000-8000-0000000b6012';
const SUBJECT_A1 = '00000000-0000-4000-8000-0000000b6021';

const TEST_ENC_KEY = crypto.randomBytes(32).toString('hex');
const FAKE_ACCESS_TOKEN = 'fake-docusign-access-token';
const HMAC_SECRET = 'b6-webhook-secret';
const ACCOUNT_ID = 'b6-account-guid';

const cleanup = async (): Promise<void> => {
  await privilegedSql`DELETE FROM signing_request WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM integration_connection WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM subject_tenant WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await sql`DELETE FROM "user" WHERE id IN (${ADMIN_USER}, ${VIEWER_USER}, ${CONSULTANT_USER})`;
  await sql`DELETE FROM tenant WHERE id IN (${TENANT_A}, ${TENANT_B})`;
};

before(async () => {
  await cleanup();
  process.env['TOKEN_ENCRYPTION_KEY'] = TEST_ENC_KEY;
  process.env['DOCUSIGN_ACCOUNT_ID'] = ACCOUNT_ID;
  process.env['DOCUSIGN_API_BASE_URL'] = 'https://demo.docusign.net/restapi/v2.1';
  process.env['DOCUSIGN_WEBHOOK_HMAC_SECRET'] = HMAC_SECRET;

  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT_A}, 'Firm A', 'firm-a-b6', 'mixed'),
                   (${TENANT_B}, 'Firm B', 'firm-b-b6', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${ADMIN_USER}, 'b6-admin@example.com', 'microsoft', 'microsoft:b6-admin', 'B6 Admin'),
                   (${VIEWER_USER}, 'b6-viewer@example.com', 'microsoft', 'microsoft:b6-viewer', 'B6 Viewer'),
                   (${CONSULTANT_USER}, 'b6-cons@example.com', 'microsoft', 'microsoft:b6-cons', 'B6 Consultant')`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT_A}, ${ADMIN_USER}, 'admin', true),
                              (gen_random_uuid(), ${TENANT_A}, ${VIEWER_USER}, 'viewer', true),
                              (gen_random_uuid(), ${TENANT_A}, ${CONSULTANT_USER}, 'consultant', true)`;
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                       VALUES (${SUBJECT_A1}, ${TENANT_A}, 'Acme Co', 'claimant')`;
});

beforeEach(() => {
  nock.cleanAll();
});

after(async () => {
  await cleanup();
  await sql.end();
  await privilegedSql.end();
  nock.cleanAll();
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

const viewerJwt = (): Promise<string> => jwtFor(VIEWER_USER, 'b6-viewer@example.com', 'viewer');
const consultantJwt = (): Promise<string> =>
  jwtFor(CONSULTANT_USER, 'b6-cons@example.com', 'consultant');

const seedDocuSignConnection = async (): Promise<void> => {
  await privilegedSql`DELETE FROM integration_connection WHERE tenant_id = ${TENANT_A} AND provider = 'docusign'`;
  await privilegedSql`
    INSERT INTO integration_connection (
      id, tenant_id, provider, access_token_encrypted, expires_at, sync_state
    ) VALUES (
      gen_random_uuid(), ${TENANT_A}, 'docusign',
      ${encryptToken(FAKE_ACCESS_TOKEN, TEST_ENC_KEY)},
      NOW() + INTERVAL '1 hour', 'idle'
    )
  `;
};

test('POST /v1/signing/requests: 412 if no docusign integration_connection', async () => {
  await privilegedSql`DELETE FROM integration_connection WHERE tenant_id = ${TENANT_A}`;
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/signing/requests',
    cookies: { cpa_session: await consultantJwt() },
    payload: {
      subject_tenant_id: SUBJECT_A1,
      recipient_email: 'signer@example.com',
      recipient_name: 'Sam Signer',
      document_kind: 'engagement_letter',
      template_id: 'tpl-123',
      subject: 'Please sign',
    },
  });
  assert.equal(res.statusCode, 412);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'docusign_not_connected');
  await app.close();
});

test('POST /v1/signing/requests: 201 + DB row inserted on success', async () => {
  await seedDocuSignConnection();
  nock('https://demo.docusign.net')
    .post(`/restapi/v2.1/accounts/${ACCOUNT_ID}/envelopes`)
    .matchHeader('authorization', `Bearer ${FAKE_ACCESS_TOKEN}`)
    .reply(201, {
      envelopeId: 'env-from-docusign',
      status: 'sent',
      uri: '/uri',
    });

  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/signing/requests',
    cookies: { cpa_session: await consultantJwt() },
    payload: {
      subject_tenant_id: SUBJECT_A1,
      recipient_email: 'signer@example.com',
      recipient_name: 'Sam Signer',
      document_kind: 'engagement_letter',
      template_id: 'tpl-123',
      subject: 'Please sign',
      email_blurb: 'Quick sig',
    },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json<{
    signing_request: { id: string; docusign_envelope_id: string; status: string };
  }>();
  assert.equal(body.signing_request.docusign_envelope_id, 'env-from-docusign');
  assert.equal(body.signing_request.status, 'sent');

  const rows = await privilegedSql<{ id: string; status: string; docusign_envelope_id: string }[]>`
    SELECT id, status, docusign_envelope_id FROM signing_request
     WHERE id = ${body.signing_request.id}
  `;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, 'sent');
  assert.equal(rows[0]?.docusign_envelope_id, 'env-from-docusign');
  await app.close();
});

test('POST /v1/signing/requests: 403 for viewer', async () => {
  await seedDocuSignConnection();
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/signing/requests',
    cookies: { cpa_session: await viewerJwt() },
    payload: {
      subject_tenant_id: SUBJECT_A1,
      recipient_email: 'r@example.com',
      recipient_name: 'R',
      document_kind: 'engagement_letter',
      template_id: 'tpl',
      subject: 'x',
    },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('POST /v1/signing/requests: 400 when neither template_id nor document supplied', async () => {
  await seedDocuSignConnection();
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/signing/requests',
    cookies: { cpa_session: await consultantJwt() },
    payload: {
      subject_tenant_id: SUBJECT_A1,
      recipient_email: 'r@example.com',
      recipient_name: 'R',
      document_kind: 'engagement_letter',
      subject: 'x',
    },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('GET /v1/signing/:id: returns the row when present', async () => {
  // Seed a signing_request row directly.
  const sigId = crypto.randomUUID();
  await privilegedSql`
    INSERT INTO signing_request (
      id, tenant_id, subject_tenant_id, initiated_by_user_id,
      recipient_email, document_kind, docusign_envelope_id, status
    ) VALUES (
      ${sigId}, ${TENANT_A}, ${SUBJECT_A1}, ${CONSULTANT_USER},
      'r@example.com', 'engagement_letter', ${'env-' + sigId}, 'sent'
    )
  `;
  try {
    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/signing/${sigId}`,
      cookies: { cpa_session: await viewerJwt() },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{ signing_request: { id: string; status: string } }>();
    assert.equal(body.signing_request.id, sigId);
    assert.equal(body.signing_request.status, 'sent');
    await app.close();
  } finally {
    await privilegedSql`DELETE FROM signing_request WHERE id = ${sigId}`;
  }
});

test('GET /v1/signing/:id: 404 when not present', async () => {
  const app = buildApp();
  const missingId = '00000000-0000-4000-8000-0000000b6099';
  const res = await app.inject({
    method: 'GET',
    url: `/v1/signing/${missingId}`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('POST /v1/integrations/docusign/webhook: 401 with bad signature', async () => {
  const app = buildApp();
  const body = JSON.stringify({
    envelopeId: 'env-x',
    status: 'completed',
    statusChangedDateTime: '2026-04-27T12:00:00Z',
  });
  const res = await app.inject({
    method: 'POST',
    url: '/v1/integrations/docusign/webhook',
    headers: {
      'content-type': 'application/json',
      'x-docusign-signature-1': 'totally-wrong-base64==',
    },
    payload: body,
  });
  assert.equal(res.statusCode, 401);
  const parsed = res.json<{ error: string }>();
  assert.equal(parsed.error, 'invalid_signature');
  await app.close();
});

test('POST /v1/integrations/docusign/webhook: 401 when signature header missing', async () => {
  const app = buildApp();
  const body = JSON.stringify({
    envelopeId: 'env-x',
    status: 'completed',
    statusChangedDateTime: '2026-04-27T12:00:00Z',
  });
  const res = await app.inject({
    method: 'POST',
    url: '/v1/integrations/docusign/webhook',
    headers: { 'content-type': 'application/json' },
    payload: body,
  });
  assert.equal(res.statusCode, 401);
  const parsed = res.json<{ error: string }>();
  assert.equal(parsed.error, 'missing_signature');
  await app.close();
});

test('POST /v1/integrations/docusign/webhook: valid sig updates DB to completed + signed_at', async () => {
  // Seed a signing_request to update.
  const sigId = crypto.randomUUID();
  const envelopeId = 'env-webhook-completion-' + sigId;
  await privilegedSql`
    INSERT INTO signing_request (
      id, tenant_id, subject_tenant_id, initiated_by_user_id,
      recipient_email, document_kind, docusign_envelope_id, status
    ) VALUES (
      ${sigId}, ${TENANT_A}, ${SUBJECT_A1}, ${CONSULTANT_USER},
      'r@example.com', 'engagement_letter', ${envelopeId}, 'sent'
    )
  `;
  try {
    const app = buildApp();
    const body = JSON.stringify({
      envelopeId,
      status: 'completed',
      statusChangedDateTime: '2026-04-27T12:34:56Z',
      customFields: { textCustomFields: [{ name: 'signing_request_id', value: sigId }] },
    });
    const sig = crypto.createHmac('sha256', HMAC_SECRET).update(Buffer.from(body)).digest('base64');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/integrations/docusign/webhook',
      headers: {
        'content-type': 'application/json',
        'x-docusign-signature-1': sig,
      },
      payload: body,
    });
    assert.equal(res.statusCode, 200);
    const parsed = res.json<{ ok: boolean; matched: boolean }>();
    assert.equal(parsed.ok, true);
    assert.equal(parsed.matched, true);

    const rows = await privilegedSql<{ status: string; signed_at: Date | null }[]>`
      SELECT status, signed_at FROM signing_request WHERE id = ${sigId}
    `;
    assert.equal(rows[0]?.status, 'completed');
    assert.ok(rows[0]?.signed_at);
    await app.close();
  } finally {
    await privilegedSql`DELETE FROM signing_request WHERE id = ${sigId}`;
  }
});

test('POST /v1/integrations/docusign/webhook: valid sig + unknown envelope_id → 200 matched=false', async () => {
  const app = buildApp();
  const body = JSON.stringify({
    envelopeId: 'env-does-not-exist',
    status: 'completed',
    statusChangedDateTime: '2026-04-27T13:00:00Z',
  });
  const sig = crypto.createHmac('sha256', HMAC_SECRET).update(Buffer.from(body)).digest('base64');
  const res = await app.inject({
    method: 'POST',
    url: '/v1/integrations/docusign/webhook',
    headers: {
      'content-type': 'application/json',
      'x-docusign-signature-1': sig,
    },
    payload: body,
  });
  assert.equal(res.statusCode, 200);
  const parsed = res.json<{ matched: boolean }>();
  assert.equal(parsed.matched, false);
  await app.close();
});
