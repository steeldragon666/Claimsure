import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../app.js';
import { MOBILE_AUDIENCE } from '../middleware/mobile-jwt-verifier.js';

const SESSION_SECRET =
  process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';
process.env['SESSION_JWT_SECRET'] = SESSION_SECRET;
// Deepgram key is read by the transcribe job's best-effort enqueue.
// The S3 stub throws first so Deepgram never actually fires, but the
// env var must still be set or the worker would log a "missing key"
// error at warn level — set a placeholder for clean test output.
process.env['DEEPGRAM_API_KEY'] = process.env['DEEPGRAM_API_KEY'] ?? 'test-deepgram-key';

const TENANT_A = '00000000-0000-4000-8000-0000000a4001';
const TENANT_B = '00000000-0000-4000-8000-0000000a4002';
const ADMIN_USER = '00000000-0000-4000-8000-0000000a4010';
const SUBJECT_A1 = '00000000-0000-4000-8000-0000000a4021';
const SUBJECT_B1 = '00000000-0000-4000-8000-0000000a4022';
const EMPLOYEE_A = '00000000-0000-4000-8000-0000000a4030';

const cleanup = async (): Promise<void> => {
  await privilegedSql`DELETE FROM event WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM subject_tenant_employee WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM subject_tenant_user WHERE subject_tenant_id IN (
    SELECT id FROM subject_tenant WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})
  )`;
  await privilegedSql`DELETE FROM subject_tenant WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await sql`DELETE FROM "user" WHERE id = ${ADMIN_USER}`;
  await sql`DELETE FROM tenant WHERE id IN (${TENANT_A}, ${TENANT_B})`;
};

before(async () => {
  await cleanup();
  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT_A}, 'Firm A', 'firm-a-a4', 'mixed'),
                   (${TENANT_B}, 'Firm B', 'firm-b-a4', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${ADMIN_USER}, 'a4-admin@example.com', 'microsoft', 'microsoft:a4-admin', 'A4 Admin')`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT_A}, ${ADMIN_USER}, 'admin', true)`;
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                       VALUES (${SUBJECT_A1}, ${TENANT_A}, 'Acme Co', 'claimant'),
                              (${SUBJECT_B1}, ${TENANT_B}, 'Other Corp', 'claimant')`;
  await privilegedSql`
    INSERT INTO subject_tenant_employee (
      id, subject_tenant_id, tenant_id, email, name, invited_by_user_id
    ) VALUES (
      ${EMPLOYEE_A}, ${SUBJECT_A1}, ${TENANT_A},
      'a4-emp@example.com', 'A4 Employee', ${ADMIN_USER}
    )
  `;
});

after(async () => {
  await cleanup();
  await sql.end();
  await privilegedSql.end();
});

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

const mobileToken = async (args: {
  employeeId?: string;
  tenantId?: string;
  subjectTenantId?: string;
}): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  const key = new TextEncoder().encode(SESSION_SECRET);
  return await new SignJWT({
    tenant_id: args.tenantId ?? TENANT_A,
    subject_tenant_id: args.subjectTenantId ?? SUBJECT_A1,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(args.employeeId ?? EMPLOYEE_A)
    .setAudience(MOBILE_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + ACCESS_TOKEN_TTL_SECONDS)
    .sign(key);
};

const validBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  audio_s3_key: 's3://bucket/abc-' + Date.now() + '.m4a',
  audio_mime_type: 'audio/m4a',
  duration_ms: 5000,
  captured_at_local: Date.now(),
  ...overrides,
});

test('POST /v1/mobile/events: 401 without bearer token', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/mobile/events',
    payload: validBody(),
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /v1/mobile/events: 400 missing required fields', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/mobile/events',
    headers: { authorization: `Bearer ${await mobileToken({})}` },
    payload: { duration_ms: 1000 },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /v1/mobile/events: 201 + event row + payload voice_pending', async () => {
  const app = buildApp();
  const body = validBody();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/mobile/events',
    headers: { authorization: `Bearer ${await mobileToken({})}` },
    payload: body,
  });
  assert.equal(res.statusCode, 201);
  const j = res.json<{
    event: { id: string; tenant_id: string; subject_tenant_id: string };
  }>();
  assert.equal(j.event.tenant_id, TENANT_A);
  assert.equal(j.event.subject_tenant_id, SUBJECT_A1);

  const rows = await privilegedSql<
    { kind: string; payload: Record<string, unknown>; captured_by_user_id: string }[]
  >`
    SELECT kind, payload, captured_by_user_id FROM event WHERE id = ${j.event.id}
  `;
  assert.equal(rows[0]?.kind, 'SUPPORTING');
  assert.equal(rows[0]?.payload['source'], 'voice_pending');
  assert.equal(rows[0]?.payload['audio_s3_key'], body['audio_s3_key']);
  assert.equal(rows[0]?.captured_by_user_id, EMPLOYEE_A);

  await app.close();
});

test('POST /v1/mobile/events: 403 when subject_tenant_id mismatches binding', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/mobile/events',
    headers: { authorization: `Bearer ${await mobileToken({})}` },
    payload: validBody({ subject_tenant_id: SUBJECT_B1 }),
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('POST /v1/mobile/events: 404 when bound subject_tenant deleted', async () => {
  // Soft-delete via deleted_at; route checks `deleted_at IS NULL`. We
  // restore at the end of the test so other tests aren't affected.
  await privilegedSql`UPDATE subject_tenant SET deleted_at = NOW() WHERE id = ${SUBJECT_A1}`;
  try {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/mobile/events',
      headers: { authorization: `Bearer ${await mobileToken({})}` },
      payload: validBody(),
    });
    assert.equal(res.statusCode, 404);
    await app.close();
  } finally {
    await privilegedSql`UPDATE subject_tenant SET deleted_at = NULL WHERE id = ${SUBJECT_A1}`;
  }
});

test('POST /v1/mobile/events: Idempotency-Key returns existing row on duplicate', async () => {
  const app = buildApp();
  const body = validBody();
  const idemKey = 'idem-test-' + Date.now();
  const headers = {
    authorization: `Bearer ${await mobileToken({})}`,
    'idempotency-key': idemKey,
  };

  const first = await app.inject({
    method: 'POST',
    url: '/v1/mobile/events',
    headers,
    payload: body,
  });
  assert.equal(first.statusCode, 201);
  const firstId = first.json<{ event: { id: string } }>().event.id;

  const second = await app.inject({
    method: 'POST',
    url: '/v1/mobile/events',
    headers,
    payload: body,
  });
  assert.equal(second.statusCode, 200);
  const secondJson = second.json<{ event: { id: string }; duplicate?: boolean }>();
  assert.equal(secondJson.event.id, firstId, 'idempotency: same row returned');
  assert.equal(secondJson.duplicate, true);

  // Only one row should exist with this idempotency key.
  const rows = await privilegedSql<{ id: string }[]>`
    SELECT id FROM event WHERE idempotency_key = ${idemKey}
  `;
  assert.equal(rows.length, 1);

  await app.close();
});
