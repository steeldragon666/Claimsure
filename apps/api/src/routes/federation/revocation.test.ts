import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { signSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../../app.js';

/**
 * P9 Phase 3 — Federation share revocation tests.
 *
 * Verifies that the source tenant can revoke a share, and that:
 * - Revocation returns 200 with revoked_at
 * - Revoking an already-revoked share returns 404
 * - Target tenant cannot revoke (not the source)
 *
 * DB-gated: skips gracefully when Postgres is unreachable.
 */

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

const SOURCE_TENANT = '00000000-0000-4000-8000-000000096001';
const SOURCE_USER = '00000000-0000-4000-8000-000000096010';
const TARGET_TENANT = '00000000-0000-4000-8000-000000096002';
const TARGET_USER = '00000000-0000-4000-8000-000000096020';
const SUBJECT_TENANT = '00000000-0000-4000-8000-000000096100';
const SHARE_ID = '00000000-0000-4000-8000-000000096200';

let dbAvailable = false;

const sourceSession = (): Promise<string> =>
  signSession(
    {
      sub: SOURCE_USER,
      email: 'revoke-src@example.com',
      primaryIdp: 'microsoft',
      activeTenantId: SOURCE_TENANT,
      activeRole: 'admin',
      availableTenants: [],
    },
    SESSION_SECRET,
    { ttlSeconds: 3600 },
  );

const targetSession = (): Promise<string> =>
  signSession(
    {
      sub: TARGET_USER,
      email: 'revoke-tgt@example.com',
      primaryIdp: 'microsoft',
      activeTenantId: TARGET_TENANT,
      activeRole: 'admin',
      availableTenants: [],
    },
    SESSION_SECRET,
    { ttlSeconds: 3600 },
  );

before(async () => {
  try {
    await privilegedSql`SELECT 1`;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    return;
  }

  // Clean up
  await privilegedSql`DELETE FROM federation_audit WHERE federation_share_id = ${SHARE_ID}`;
  await privilegedSql`DELETE FROM federation_share WHERE id = ${SHARE_ID}`;
  await privilegedSql`DELETE FROM subject_tenant WHERE id = ${SUBJECT_TENANT}`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id IN (${SOURCE_TENANT}, ${TARGET_TENANT})`;
  await privilegedSql`DELETE FROM "user" WHERE id IN (${SOURCE_USER}, ${TARGET_USER})`;
  await privilegedSql`DELETE FROM tenant WHERE id IN (${SOURCE_TENANT}, ${TARGET_TENANT})`;

  await privilegedSql`
    INSERT INTO tenant (id, name, slug, primary_idp)
    VALUES (${SOURCE_TENANT}, 'Revoke Source Firm', 'revoke-source', 'mixed'),
           (${TARGET_TENANT}, 'Revoke Target Financier', 'revoke-target', 'mixed')
  `;
  await privilegedSql`
    INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
    VALUES (${SOURCE_USER}, 'revoke-src@example.com', 'microsoft', 'microsoft:revoke-src', 'Revoke Source'),
           (${TARGET_USER}, 'revoke-tgt@example.com', 'microsoft', 'microsoft:revoke-tgt', 'Revoke Target')
  `;
  await privilegedSql`
    INSERT INTO tenant_user (id, tenant_id, user_id, role)
    VALUES (gen_random_uuid(), ${SOURCE_TENANT}, ${SOURCE_USER}, 'admin'),
           (gen_random_uuid(), ${TARGET_TENANT}, ${TARGET_USER}, 'admin')
  `;
  await privilegedSql`
    INSERT INTO subject_tenant (id, tenant_id, name)
    VALUES (${SUBJECT_TENANT}, ${SOURCE_TENANT}, 'Revoke Entity')
  `;
  await privilegedSql`
    INSERT INTO federation_share (id, subject_tenant_id, source_tenant_id, target_tenant_id, granted_by_user_id)
    VALUES (${SHARE_ID}, ${SUBJECT_TENANT}, ${SOURCE_TENANT}, ${TARGET_TENANT}, ${SOURCE_USER})
  `;
});

after(async () => {
  if (!dbAvailable) return;
  try {
    await privilegedSql`DELETE FROM federation_audit WHERE federation_share_id = ${SHARE_ID}`;
    await privilegedSql`DELETE FROM federation_share WHERE id = ${SHARE_ID}`;
    await privilegedSql`DELETE FROM subject_tenant WHERE id = ${SUBJECT_TENANT}`;
    await privilegedSql`DELETE FROM tenant_user WHERE tenant_id IN (${SOURCE_TENANT}, ${TARGET_TENANT})`;
    await privilegedSql`DELETE FROM "user" WHERE id IN (${SOURCE_USER}, ${TARGET_USER})`;
    await privilegedSql`DELETE FROM tenant WHERE id IN (${SOURCE_TENANT}, ${TARGET_TENANT})`;
    await privilegedSql.end();
    await sql.end();
  } catch {
    // ignore
  }
});

const skipIfNoDb = (t: { skip: (msg?: string) => void }): boolean => {
  if (!dbAvailable) {
    t.skip('Postgres not reachable — DB-gated test skipped');
    return true;
  }
  return false;
};

describe('Federation revocation (P9.3 Task 3.6)', () => {
  test('source tenant can revoke a share', async (t) => {
    if (skipIfNoDb(t)) return;

    const app = buildApp();
    await app.ready();

    const cookie = await sourceSession();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/federation/shares/${SHARE_ID}/revoke`,
      headers: { cookie: `cpa_session=${cookie}` },
      payload: { reason: 'Engagement ended' },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json<{ revoked_at: string }>();
    assert.ok(body.revoked_at, 'Expected revoked_at in response');

    await app.close();
  });

  test('revoking an already-revoked share returns 404', async (t) => {
    if (skipIfNoDb(t)) return;

    const app = buildApp();
    await app.ready();

    const cookie = await sourceSession();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/federation/shares/${SHARE_ID}/revoke`,
      headers: { cookie: `cpa_session=${cookie}` },
      payload: {},
    });

    assert.equal(res.statusCode, 404);

    await app.close();
  });

  test('target tenant cannot revoke a share (not the source)', async (t) => {
    if (skipIfNoDb(t)) return;

    // Reset the share to un-revoked for this test
    await privilegedSql`
      UPDATE federation_share
      SET revoked_at = NULL, revoked_by_user_id = NULL, revoked_reason = NULL
      WHERE id = ${SHARE_ID}
    `;

    const app = buildApp();
    await app.ready();

    const cookie = await targetSession();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/federation/shares/${SHARE_ID}/revoke`,
      headers: { cookie: `cpa_session=${cookie}` },
      payload: {},
    });

    // RLS WITH CHECK prevents target from updating — should get 404
    assert.equal(res.statusCode, 404);

    await app.close();
  });
});
