import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { signSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../../app.js';

/**
 * P9 Phase 3 — Federation audit hook tests.
 *
 * Verifies that FEDERATION_READ events are emitted to the event chain
 * when a financier reads data via a federation share.
 *
 * DB-gated: skips gracefully when Postgres is unreachable.
 */

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

const SOURCE_TENANT = '00000000-0000-4000-8000-000000095001';
const SOURCE_USER = '00000000-0000-4000-8000-000000095010';
const TARGET_TENANT = '00000000-0000-4000-8000-000000095002';
const TARGET_USER = '00000000-0000-4000-8000-000000095020';
const SUBJECT_TENANT = '00000000-0000-4000-8000-000000095100';
const PROJECT_ID = '00000000-0000-4000-8000-000000095300';
const CLAIM_ID = '00000000-0000-4000-8000-000000095400';
const SHARE_ID = '00000000-0000-4000-8000-000000095200';

let dbAvailable = false;

const targetSession = (): Promise<string> =>
  signSession(
    {
      sub: TARGET_USER,
      email: 'audit-financier@example.com',
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
  await privilegedSql`DELETE FROM event WHERE subject_tenant_id = ${SUBJECT_TENANT} AND kind = 'FEDERATION_READ'`;
  await privilegedSql`DELETE FROM federation_audit WHERE federation_share_id = ${SHARE_ID}`;
  await privilegedSql`DELETE FROM federation_share WHERE id = ${SHARE_ID}`;
  await privilegedSql`DELETE FROM claim WHERE id = ${CLAIM_ID}`;
  await privilegedSql`DELETE FROM project WHERE id = ${PROJECT_ID}`;
  await privilegedSql`DELETE FROM subject_tenant WHERE id = ${SUBJECT_TENANT}`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id IN (${SOURCE_TENANT}, ${TARGET_TENANT})`;
  await privilegedSql`DELETE FROM "user" WHERE id IN (${SOURCE_USER}, ${TARGET_USER})`;
  await privilegedSql`DELETE FROM tenant WHERE id IN (${SOURCE_TENANT}, ${TARGET_TENANT})`;

  await privilegedSql`
    INSERT INTO tenant (id, name, slug, primary_idp)
    VALUES (${SOURCE_TENANT}, 'Audit Source Firm', 'audit-source', 'mixed'),
           (${TARGET_TENANT}, 'Audit Target Financier', 'audit-target', 'mixed')
  `;
  await privilegedSql`
    INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
    VALUES (${SOURCE_USER}, 'audit-src@example.com', 'microsoft', 'microsoft:audit-src', 'Audit Source'),
           (${TARGET_USER}, 'audit-financier@example.com', 'microsoft', 'microsoft:audit-tgt', 'Audit Financier')
  `;
  await privilegedSql`
    INSERT INTO tenant_user (tenant_id, user_id, role)
    VALUES (${SOURCE_TENANT}, ${SOURCE_USER}, 'admin'),
           (${TARGET_TENANT}, ${TARGET_USER}, 'admin')
  `;
  await privilegedSql`
    INSERT INTO subject_tenant (id, tenant_id, name, abn)
    VALUES (${SUBJECT_TENANT}, ${SOURCE_TENANT}, 'Audit Entity', '33333333333')
  `;
  await privilegedSql`
    INSERT INTO project (id, tenant_id, name)
    VALUES (${PROJECT_ID}, ${SOURCE_TENANT}, 'Audit Project')
  `;
  await privilegedSql`
    INSERT INTO claim (id, tenant_id, subject_tenant_id, project_id, fiscal_year, stage)
    VALUES (${CLAIM_ID}, ${SOURCE_TENANT}, ${SUBJECT_TENANT}, ${PROJECT_ID}, 2025, 'engagement')
  `;
  await privilegedSql`
    INSERT INTO federation_share (id, subject_tenant_id, source_tenant_id, target_tenant_id, granted_by_user_id)
    VALUES (${SHARE_ID}, ${SUBJECT_TENANT}, ${SOURCE_TENANT}, ${TARGET_TENANT}, ${SOURCE_USER})
  `;
});

after(async () => {
  if (!dbAvailable) return;
  try {
    await privilegedSql`DELETE FROM event WHERE subject_tenant_id = ${SUBJECT_TENANT} AND kind = 'FEDERATION_READ'`;
    await privilegedSql`DELETE FROM federation_audit WHERE federation_share_id = ${SHARE_ID}`;
    await privilegedSql`DELETE FROM federation_share WHERE id = ${SHARE_ID}`;
    await privilegedSql`DELETE FROM claim WHERE id = ${CLAIM_ID}`;
    await privilegedSql`DELETE FROM project WHERE id = ${PROJECT_ID}`;
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

describe('Federation audit hook (P9.3 Task 3.4)', () => {
  test('emits FEDERATION_READ event on federated claim detail read', async (t) => {
    if (skipIfNoDb(t)) return;

    const app = buildApp();
    await app.ready();

    const cookie = await targetSession();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/federation/shares/${SHARE_ID}/claims/${CLAIM_ID}`,
      headers: { cookie: `cpa_session=${cookie}` },
    });

    assert.equal(res.statusCode, 200);

    // Wait briefly for the onResponse hook to complete
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Check that a FEDERATION_READ event was emitted
    const events = await privilegedSql<{ kind: string; payload: unknown }[]>`
      SELECT kind, payload FROM event
      WHERE subject_tenant_id = ${SUBJECT_TENANT}
        AND kind = 'FEDERATION_READ'
      ORDER BY received_at DESC
      LIMIT 1
    `;

    assert.ok(events.length > 0, 'Expected a FEDERATION_READ event');
    assert.equal(events[0]!.kind, 'FEDERATION_READ');

    await app.close();
  });
});
