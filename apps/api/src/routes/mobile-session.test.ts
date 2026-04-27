import crypto from 'node:crypto';
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { jwtVerify } from 'jose';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../app.js';
import { MOBILE_AUDIENCE } from '../middleware/mobile-jwt-verifier.js';

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';
process.env['SESSION_JWT_SECRET'] = SESSION_SECRET;

const TENANT_A = '00000000-0000-4000-8000-0000000f8001';
const ADMIN_USER = '00000000-0000-4000-8000-0000000f8010';
const SUBJECT_A1 = '00000000-0000-4000-8000-0000000f8021';
const EMPLOYEE = '00000000-0000-4000-8000-0000000f8030';
const DEVICE_FP = 'device-f8-fingerprint-001';

const cleanup = async (): Promise<void> => {
  await privilegedSql`
    DELETE FROM mobile_session WHERE employee_id IN (
      SELECT id FROM subject_tenant_employee WHERE tenant_id = ${TENANT_A}
    )
  `;
  await privilegedSql`DELETE FROM subject_tenant_employee WHERE tenant_id = ${TENANT_A}`;
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
            VALUES (${TENANT_A}, 'Firm A', 'firm-a-f8', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${ADMIN_USER}, 'f8-admin@example.com', 'microsoft', 'microsoft:f8-admin', 'F8 Admin')`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT_A}, ${ADMIN_USER}, 'admin', true)`;
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                       VALUES (${SUBJECT_A1}, ${TENANT_A}, 'Acme Co', 'claimant')`;
  await privilegedSql`
    INSERT INTO subject_tenant_employee (
      id, subject_tenant_id, tenant_id, email, name, invited_by_user_id
    ) VALUES (
      ${EMPLOYEE}, ${SUBJECT_A1}, ${TENANT_A},
      'f8-employee@example.com', 'F8 Employee', ${ADMIN_USER}
    )
  `;
});

after(async () => {
  await cleanup();
  await sql.end();
  await privilegedSql.end();
});

interface SeededSession {
  sessionId: string;
  rawRefresh: string;
  refreshHash: string;
}

const seedSession = async (opts: {
  expiresAt: Date;
  deviceFingerprint?: string;
  revokedAt?: Date | null;
}): Promise<SeededSession> => {
  const rawRefresh = crypto.randomBytes(32).toString('base64url');
  const refreshHash = crypto.createHash('sha256').update(rawRefresh).digest('hex');
  const id = crypto.randomUUID();
  await privilegedSql`
    INSERT INTO mobile_session (
      id, employee_id, device_fingerprint, refresh_token_hash, expires_at, revoked_at
    ) VALUES (
      ${id}, ${EMPLOYEE},
      ${opts.deviceFingerprint ?? DEVICE_FP},
      ${refreshHash},
      ${opts.expiresAt.toISOString()}::timestamptz,
      ${
        opts.revokedAt === undefined || opts.revokedAt === null
          ? null
          : opts.revokedAt.toISOString()
      }::timestamptz
    )
  `;
  return { sessionId: id, rawRefresh, refreshHash };
};

test('POST /v1/auth/refresh: 200 + new tokens + session row updated', async () => {
  const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const seeded = await seedSession({ expiresAt: future });

  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/refresh',
    payload: {
      refresh_token: seeded.rawRefresh,
      device_fingerprint: DEVICE_FP,
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ access_token: string; refresh_token: string }>();
  assert.ok(body.access_token);
  assert.ok(body.refresh_token);
  assert.notEqual(body.refresh_token, seeded.rawRefresh, 'refresh should rotate');

  // Access token verifies under aud='mobile' with the right claims.
  const { payload } = await jwtVerify(body.access_token, new TextEncoder().encode(SESSION_SECRET), {
    audience: MOBILE_AUDIENCE,
  });
  assert.equal(payload.sub, EMPLOYEE);
  assert.equal(payload['tenant_id'], TENANT_A);
  assert.equal(payload['subject_tenant_id'], SUBJECT_A1);

  // Mobile_session row was updated: new hash + extended expiry.
  const newHash = crypto.createHash('sha256').update(body.refresh_token).digest('hex');
  const sessionRows = await privilegedSql<{ refresh_token_hash: string; expires_at: Date }[]>`
    SELECT refresh_token_hash, expires_at FROM mobile_session WHERE id = ${seeded.sessionId}
  `;
  assert.equal(sessionRows[0]?.refresh_token_hash, newHash);
  const newExp = new Date(sessionRows[0]?.expires_at ?? 0).getTime();
  const expected90 = Date.now() + 90 * 24 * 60 * 60 * 1000;
  assert.ok(Math.abs(newExp - expected90) < 60_000);

  // Old refresh hash no longer maps to a session.
  const oldLookup = await privilegedSql<{ id: string }[]>`
    SELECT id FROM mobile_session WHERE refresh_token_hash = ${seeded.refreshHash}
  `;
  assert.equal(oldLookup.length, 0);

  await app.close();
});

test('POST /v1/auth/refresh: 401 on expired session', async () => {
  const past = new Date(Date.now() - 1000);
  const seeded = await seedSession({ expiresAt: past });

  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/refresh',
    payload: {
      refresh_token: seeded.rawRefresh,
      device_fingerprint: DEVICE_FP,
    },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /v1/auth/refresh: 401 on revoked session', async () => {
  const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const revokedAt = new Date(Date.now() - 1000);
  const seeded = await seedSession({ expiresAt: future, revokedAt });

  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/refresh',
    payload: {
      refresh_token: seeded.rawRefresh,
      device_fingerprint: DEVICE_FP,
    },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /v1/auth/refresh: 403 on device fingerprint mismatch', async () => {
  const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const seeded = await seedSession({ expiresAt: future });

  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/refresh',
    payload: {
      refresh_token: seeded.rawRefresh,
      device_fingerprint: 'a-different-device',
    },
  });
  assert.equal(res.statusCode, 403);
  const body = res.json<{ error: { code: string } }>();
  assert.equal(body.error.code, 'DEVICE_MISMATCH');
  await app.close();
});

test('POST /v1/auth/refresh: 401 on unknown refresh token', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/refresh',
    payload: {
      refresh_token: 'not-a-real-refresh-' + crypto.randomBytes(16).toString('hex'),
      device_fingerprint: DEVICE_FP,
    },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /v1/auth/refresh: 400 on missing device_fingerprint', async () => {
  const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const seeded = await seedSession({ expiresAt: future });

  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/refresh',
    payload: { refresh_token: seeded.rawRefresh },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});
