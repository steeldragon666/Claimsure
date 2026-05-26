import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { signSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../../app.js';

/**
 * HTTP tests for GET /v1/consultant/chain/recent.
 *
 * STATUS: the audit-chain ingestion layer is not yet implemented (no
 * `audit_chain_block` table; see endpoint banner). Tests therefore
 * cover:
 *   - 401 (no session)
 *   - 400 (invalid `limit` query param)
 *   - 200 happy path returning the empty contract `{ blocks: [], height: 0 }`
 *   - 200 with custom limit (still empty, but exercises validation)
 *
 * The cross-tenant isolation test is currently a TODO — meaningless to
 * assert until there are actual rows to leak. The two-tenant fixture is
 * already seeded so the test can be enabled with just a `INSERT INTO
 * audit_chain_block ...` once the table exists.
 *
 * Tenant/user UUIDs use the `0d03` prefix (D3 = chain panel; see
 * audit-score.test.ts:11 for the `0d04` convention this mirrors).
 */

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

const TENANT_A = '00000000-0000-4000-8000-0000000d0301';
const TENANT_B = '00000000-0000-4000-8000-0000000d0302';
const ADMIN_A = '00000000-0000-4000-8000-0000000d0310';
const ADMIN_B = '00000000-0000-4000-8000-0000000d0311';

const cleanup = async (): Promise<void> => {
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await sql`DELETE FROM "user" WHERE id IN (${ADMIN_A}, ${ADMIN_B})`;
  await sql`DELETE FROM tenant WHERE id IN (${TENANT_A}, ${TENANT_B})`;
};

before(async () => {
  await cleanup();
  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT_A}, 'Firm A D03', 'firm-a-d03', 'mixed'),
                   (${TENANT_B}, 'Firm B D03', 'firm-b-d03', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${ADMIN_A}, 'd03-a@example.com', 'microsoft', 'microsoft:d03-a', 'D03 A'),
                   (${ADMIN_B}, 'd03-b@example.com', 'microsoft', 'microsoft:d03-b', 'D03 B')`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT_A}, ${ADMIN_A}, 'admin', true),
                              (gen_random_uuid(), ${TENANT_B}, ${ADMIN_B}, 'admin', true)`;
});

after(async () => {
  await cleanup();
  await sql.end();
  await privilegedSql.end();
});

const jwtFor = (userId: string, email: string, tenantId: string): Promise<string> =>
  signSession(
    {
      sub: userId,
      email,
      primaryIdp: 'microsoft',
      activeTenantId: tenantId,
      activeRole: 'admin',
      availableTenants: [],
    },
    SESSION_SECRET,
    { ttlSeconds: 3600 },
  );

const adminAJwt = (): Promise<string> => jwtFor(ADMIN_A, 'd03-a@example.com', TENANT_A);

test('GET /v1/consultant/chain/recent: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/consultant/chain/recent',
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('GET /v1/consultant/chain/recent: 400 when limit is non-numeric', async () => {
  const app = buildApp();
  const jwt = await adminAJwt();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/consultant/chain/recent?limit=abc',
    cookies: { cpa_session: jwt },
  });
  assert.equal(res.statusCode, 400);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'invalid_query');
  await app.close();
});

test('GET /v1/consultant/chain/recent: 400 when limit is zero', async () => {
  const app = buildApp();
  const jwt = await adminAJwt();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/consultant/chain/recent?limit=0',
    cookies: { cpa_session: jwt },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('GET /v1/consultant/chain/recent: 400 when limit exceeds max', async () => {
  const app = buildApp();
  const jwt = await adminAJwt();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/consultant/chain/recent?limit=999',
    cookies: { cpa_session: jwt },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('GET /v1/consultant/chain/recent: 200 returns empty contract (default limit)', async () => {
  const app = buildApp();
  const jwt = await adminAJwt();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/consultant/chain/recent',
    cookies: { cpa_session: jwt },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ blocks: unknown[]; height: number }>();
  assert.ok(Array.isArray(body.blocks));
  assert.equal(body.blocks.length, 0);
  assert.equal(body.height, 0);
  await app.close();
});

test('GET /v1/consultant/chain/recent: 200 with custom limit still returns empty', async () => {
  const app = buildApp();
  const jwt = await adminAJwt();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/consultant/chain/recent?limit=10',
    cookies: { cpa_session: jwt },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ blocks: unknown[]; height: number }>();
  assert.equal(body.blocks.length, 0);
  assert.equal(body.height, 0);
  await app.close();
});

// TODO(audit-chain): once the audit_chain_block table exists, add:
//   - INSERT seed rows owned by TENANT_A
//   - INSERT seed rows owned by TENANT_B
//   - assert: admin-A request returns only A's rows
//   - assert: limit param respected
//   - assert: height matches MAX(height) for the tenant
