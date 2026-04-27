import crypto from 'node:crypto';
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { jwtVerify } from 'jose';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../app.js';
import { MOBILE_AUDIENCE } from '../middleware/mobile-jwt-verifier.js';

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';
process.env['SESSION_JWT_SECRET'] = SESSION_SECRET;

const TENANT_A = '00000000-0000-4000-8000-0000000f7001';
const ADMIN_USER = '00000000-0000-4000-8000-0000000f7010';
const SUBJECT_A1 = '00000000-0000-4000-8000-0000000f7021';
const EMPLOYEE_VALID = '00000000-0000-4000-8000-0000000f7030';
const EMPLOYEE_DEACTIVATED = '00000000-0000-4000-8000-0000000f7031';

const cleanup = async (): Promise<void> => {
  await privilegedSql`
    DELETE FROM mobile_session WHERE employee_id IN (
      SELECT id FROM subject_tenant_employee WHERE tenant_id = ${TENANT_A}
    )
  `;
  await privilegedSql`
    DELETE FROM magic_link_token WHERE employee_id IN (
      SELECT id FROM subject_tenant_employee WHERE tenant_id = ${TENANT_A}
    )
  `;
  await privilegedSql`DELETE FROM subject_tenant_employee WHERE tenant_id = ${TENANT_A}`;
  await privilegedSql`DELETE FROM brand_config WHERE tenant_id = ${TENANT_A}`;
  await privilegedSql`DELETE FROM subject_tenant_user WHERE subject_tenant_id IN (
    SELECT id FROM subject_tenant WHERE tenant_id = ${TENANT_A}
  )`;
  await privilegedSql`DELETE FROM subject_tenant WHERE tenant_id = ${TENANT_A}`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id = ${TENANT_A}`;
  await sql`DELETE FROM "user" WHERE id = ${ADMIN_USER}`;
  await sql`DELETE FROM tenant WHERE id = ${TENANT_A}`;
};

before(async () => {
  await cleanup();
  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT_A}, 'Firm A', 'firm-a-f7', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${ADMIN_USER}, 'f7-admin@example.com', 'microsoft', 'microsoft:f7-admin', 'F7 Admin')`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT_A}, ${ADMIN_USER}, 'admin', true)`;
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                       VALUES (${SUBJECT_A1}, ${TENANT_A}, 'Acme Co', 'claimant')`;
  await privilegedSql`
    INSERT INTO subject_tenant_employee (
      id, subject_tenant_id, tenant_id, email, name, invited_by_user_id
    ) VALUES
      (${EMPLOYEE_VALID}, ${SUBJECT_A1}, ${TENANT_A}, 'valid@example.com', 'Valid', ${ADMIN_USER}),
      (${EMPLOYEE_DEACTIVATED}, ${SUBJECT_A1}, ${TENANT_A}, 'inactive@example.com', 'Inactive', ${ADMIN_USER})
  `;
  // Mark the second employee deactivated so the redeem path 401s.
  await privilegedSql`
    UPDATE subject_tenant_employee
       SET deactivated_at = NOW()
     WHERE id = ${EMPLOYEE_DEACTIVATED}
  `;
  // Brand row so the response has non-default colors to assert on.
  await privilegedSql`
    INSERT INTO brand_config (
      tenant_id, display_name, primary_color, accent_color, logo_s3_key
    ) VALUES (
      ${TENANT_A}, 'Firm A Brand', '#aabbcc', '#ddeeff', 'firma/logo.svg'
    )
  `;
});

after(async () => {
  await cleanup();
  await sql.end();
  await privilegedSql.end();
});

interface IssuedToken {
  rawToken: string;
  tokenHash: string;
}

const issueToken = (): IssuedToken => {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  return { rawToken, tokenHash };
};

const insertToken = async (
  employeeId: string,
  expiresAt: Date,
  consumedAt: Date | null = null,
): Promise<IssuedToken> => {
  const { rawToken, tokenHash } = issueToken();
  await privilegedSql`
    INSERT INTO magic_link_token (id, employee_id, token_hash, expires_at, consumed_at)
    VALUES (${crypto.randomUUID()}, ${employeeId}, ${tokenHash}, ${expiresAt.toISOString()}::timestamptz,
            ${consumedAt === null ? null : consumedAt.toISOString()}::timestamptz)
  `;
  return { rawToken, tokenHash };
};

test('POST /v1/auth/magic-link/redeem: 200 + access_token + refresh_token + session row', async () => {
  const expires = new Date(Date.now() + 10 * 60 * 1000);
  const { rawToken } = await insertToken(EMPLOYEE_VALID, expires);

  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/magic-link/redeem',
    payload: {
      token: rawToken,
      device_fingerprint: 'device-f7-001',
      push_token: 'expo-push-001',
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    access_token: string;
    refresh_token: string;
    employee: { id: string; tenant_id: string };
    brand_config: { display_name: string; primary_color: string };
  }>();
  assert.ok(body.access_token);
  assert.ok(body.refresh_token);
  assert.equal(body.employee.id, EMPLOYEE_VALID);
  assert.equal(body.employee.tenant_id, TENANT_A);
  assert.equal(body.brand_config.display_name, 'Firm A Brand');
  assert.equal(body.brand_config.primary_color, '#aabbcc');

  // Verify access_token is a valid mobile JWT.
  const { payload } = await jwtVerify(body.access_token, new TextEncoder().encode(SESSION_SECRET), {
    audience: MOBILE_AUDIENCE,
  });
  assert.equal(payload.sub, EMPLOYEE_VALID);
  assert.equal(payload['tenant_id'], TENANT_A);
  assert.equal(payload['subject_tenant_id'], SUBJECT_A1);

  // Verify mobile_session row was inserted with the right fingerprint
  // and refresh_token hash.
  const refreshHash = crypto.createHash('sha256').update(body.refresh_token).digest('hex');
  const sessions = await privilegedSql<
    { device_fingerprint: string; push_token: string | null; expires_at: Date }[]
  >`
    SELECT device_fingerprint, push_token, expires_at FROM mobile_session
     WHERE employee_id = ${EMPLOYEE_VALID} AND refresh_token_hash = ${refreshHash}
  `;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.device_fingerprint, 'device-f7-001');
  assert.equal(sessions[0]?.push_token, 'expo-push-001');
  // 90-day window — 89-91 days from now.
  const sessExp = new Date(sessions[0]?.expires_at ?? 0).getTime();
  const expected = Date.now() + 90 * 24 * 60 * 60 * 1000;
  assert.ok(Math.abs(sessExp - expected) < 60_000);

  // Verify the magic-link token is now consumed.
  const consumed = await privilegedSql<{ consumed_at: Date | null }[]>`
    SELECT consumed_at FROM magic_link_token
     WHERE token_hash = ${crypto.createHash('sha256').update(rawToken).digest('hex')}
  `;
  assert.ok(consumed[0]?.consumed_at !== null);

  // Employee's first_seen_at + last_seen_at should be populated.
  const empCheck = await privilegedSql<
    {
      first_seen_at: Date | null;
      last_seen_at: Date | null;
    }[]
  >`
    SELECT first_seen_at, last_seen_at FROM subject_tenant_employee WHERE id = ${EMPLOYEE_VALID}
  `;
  assert.ok(empCheck[0]?.first_seen_at !== null);
  assert.ok(empCheck[0]?.last_seen_at !== null);

  await app.close();
});

test('POST /v1/auth/magic-link/redeem: 401 on expired token', async () => {
  const expired = new Date(Date.now() - 1000);
  const { rawToken } = await insertToken(EMPLOYEE_VALID, expired);

  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/magic-link/redeem',
    payload: { token: rawToken, device_fingerprint: 'device-f7-002' },
  });
  assert.equal(res.statusCode, 401);
  const body = res.json<{ error: { code: string } }>();
  assert.equal(body.error.code, 'UNAUTHENTICATED');
  await app.close();
});

test('POST /v1/auth/magic-link/redeem: 401 on already-consumed token', async () => {
  const expires = new Date(Date.now() + 10 * 60 * 1000);
  const consumed = new Date(Date.now() - 1000);
  const { rawToken } = await insertToken(EMPLOYEE_VALID, expires, consumed);

  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/magic-link/redeem',
    payload: { token: rawToken, device_fingerprint: 'device-f7-003' },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /v1/auth/magic-link/redeem: 401 on unknown token', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/magic-link/redeem',
    payload: {
      token: 'this-is-not-a-real-token-' + crypto.randomBytes(16).toString('hex'),
      device_fingerprint: 'd',
    },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /v1/auth/magic-link/redeem: 400 on missing device_fingerprint', async () => {
  const expires = new Date(Date.now() + 10 * 60 * 1000);
  const { rawToken } = await insertToken(EMPLOYEE_VALID, expires);

  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/magic-link/redeem',
    payload: { token: rawToken },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /v1/auth/magic-link/redeem: 401 on token for deactivated employee', async () => {
  const expires = new Date(Date.now() + 10 * 60 * 1000);
  const { rawToken } = await insertToken(EMPLOYEE_DEACTIVATED, expires);

  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/magic-link/redeem',
    payload: { token: rawToken, device_fingerprint: 'device-f7-004' },
  });
  assert.equal(res.statusCode, 401);
  // The token gets consumed even on the deactivated path — single-use is
  // single-use. Verify so the assertion is intentional.
  const consumed = await privilegedSql<{ consumed_at: Date | null }[]>`
    SELECT consumed_at FROM magic_link_token
     WHERE token_hash = ${crypto.createHash('sha256').update(rawToken).digest('hex')}
  `;
  assert.ok(consumed[0]?.consumed_at !== null);
  await app.close();
});
