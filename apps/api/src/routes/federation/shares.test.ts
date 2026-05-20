import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { signSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../../app.js';

// ---------------------------------------------------------------------------
// Fixtures — P9.3 shares namespace (prefix 000000093xxx, 3xx range)
// ---------------------------------------------------------------------------

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

const SOURCE_TENANT = '00000000-0000-4000-8000-000000093301';
const SOURCE_USER = '00000000-0000-4000-8000-000000093310';
const TARGET_TENANT = '00000000-0000-4000-8000-000000093302';
const TARGET_USER = '00000000-0000-4000-8000-000000093320';
const SUBJECT_TENANT = '00000000-0000-4000-8000-000000093300';
const SHARE_ID = '00000000-0000-4000-8000-000000093350';
const PROJECT_ID = '00000000-0000-4000-8000-000000093360';
const CLAIM_ID = '00000000-0000-4000-8000-000000093370';

let dbAvailable = false;

const targetSession = (): Promise<string> =>
  signSession(
    {
      sub: TARGET_USER,
      email: 'shares-financier@example.com',
      primaryIdp: 'microsoft',
      activeTenantId: TARGET_TENANT,
      activeRole: 'admin',
      availableTenants: [],
    },
    SESSION_SECRET,
    { ttlSeconds: 3600 },
  );

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

before(async () => {
  try {
    await privilegedSql`SELECT 1`;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    return;
  }

  // Clean up leftover fixtures (reverse dependency order)
  await privilegedSql`DELETE FROM federation_share WHERE id = ${SHARE_ID}`;
  await privilegedSql`DELETE FROM activity WHERE claim_id = ${CLAIM_ID}`;
  await privilegedSql`DELETE FROM claim WHERE id = ${CLAIM_ID}`;
  await privilegedSql`DELETE FROM project WHERE id = ${PROJECT_ID}`;
  await privilegedSql`DELETE FROM subject_tenant WHERE id = ${SUBJECT_TENANT}`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id IN (${SOURCE_TENANT}, ${TARGET_TENANT})`;
  await privilegedSql`DELETE FROM "user" WHERE id IN (${SOURCE_USER}, ${TARGET_USER})`;
  await privilegedSql`DELETE FROM tenant WHERE id IN (${SOURCE_TENANT}, ${TARGET_TENANT})`;

  // Create fixtures
  await privilegedSql`
    INSERT INTO tenant (id, name, slug, primary_idp)
    VALUES (${SOURCE_TENANT}, 'Shares Source Firm', 'shares-source-firm', 'mixed'),
           (${TARGET_TENANT}, 'Shares Target Financier', 'shares-target-financier', 'mixed')
  `;
  await privilegedSql`
    INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
    VALUES (${SOURCE_USER}, 'shares-consultant@example.com', 'microsoft', 'microsoft:shares-src', 'Shares Consultant'),
           (${TARGET_USER}, 'shares-financier@example.com', 'microsoft', 'microsoft:shares-tgt', 'Shares Financier')
  `;
  await privilegedSql`
    INSERT INTO tenant_user (id, tenant_id, user_id, role)
    VALUES (gen_random_uuid(), ${SOURCE_TENANT}, ${SOURCE_USER}, 'admin'),
           (gen_random_uuid(), ${TARGET_TENANT}, ${TARGET_USER}, 'admin')
  `;
  await privilegedSql`
    INSERT INTO subject_tenant (id, tenant_id, name)
    VALUES (${SUBJECT_TENANT}, ${SOURCE_TENANT}, 'Shares Entity Pty Ltd')
  `;
  await privilegedSql`
    INSERT INTO project (id, tenant_id, subject_tenant_id, name, started_at)
    VALUES (${PROJECT_ID}, ${SOURCE_TENANT}, ${SUBJECT_TENANT}, 'Test Project', now())
  `;
  await privilegedSql`
    INSERT INTO claim (id, tenant_id, subject_tenant_id, project_id, fiscal_year, stage)
    VALUES (${CLAIM_ID}, ${SOURCE_TENANT}, ${SUBJECT_TENANT}, ${PROJECT_ID}, 2025, 'engagement')
  `;
  // Create the federation share
  await privilegedSql`
    INSERT INTO federation_share (
      id, subject_tenant_id, source_tenant_id, target_tenant_id,
      granted_by_user_id
    )
    VALUES (
      ${SHARE_ID}, ${SUBJECT_TENANT}, ${SOURCE_TENANT}, ${TARGET_TENANT},
      ${SOURCE_USER}
    )
  `;
});

after(async () => {
  if (!dbAvailable) return;
  try {
    await privilegedSql`DELETE FROM federation_share WHERE id = ${SHARE_ID}`;
    await privilegedSql`DELETE FROM activity WHERE claim_id = ${CLAIM_ID}`;
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /v1/federation/shares', () => {
  test('returns active shares for target tenant', async (t) => {
    if (skipIfNoDb(t)) return;

    const app = buildApp();
    await app.ready();

    const cookie = await targetSession();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/federation/shares',
      headers: { cookie: `cpa_session=${cookie}` },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json<{
      shares: Array<{
        id: string;
        subject_tenant_name: string;
        source_tenant_name: string;
      }>;
    }>();
    assert.ok(Array.isArray(body.shares));
    assert.ok(body.shares.length >= 1);

    const share = body.shares.find((s) => s.id === SHARE_ID);
    assert.ok(share, 'Expected share not found');
    assert.equal(share.subject_tenant_name, 'Shares Entity Pty Ltd');
    assert.equal(share.source_tenant_name, 'Shares Source Firm');

    await app.close();
  });
});

describe('GET /v1/federation/shares/:id/claims', () => {
  test('returns claims under shared subject_tenant', async (t) => {
    if (skipIfNoDb(t)) return;

    const app = buildApp();
    await app.ready();

    const cookie = await targetSession();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/federation/shares/${SHARE_ID}/claims`,
      headers: { cookie: `cpa_session=${cookie}` },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json<{ claims: Array<{ id: string; fiscal_year: number }> }>();
    assert.ok(Array.isArray(body.claims));
    assert.ok(body.claims.length >= 1);
    assert.equal(body.claims[0].fiscal_year, 2025);

    await app.close();
  });

  test('returns 404 for non-existent share', async (t) => {
    if (skipIfNoDb(t)) return;

    const app = buildApp();
    await app.ready();

    const cookie = await targetSession();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/federation/shares/00000000-0000-4000-8000-000000000000/claims',
      headers: { cookie: `cpa_session=${cookie}` },
    });

    assert.equal(res.statusCode, 404);
    await app.close();
  });
});

describe('GET /v1/federation/shares/:id/claims/:claimId', () => {
  test('returns claim detail with activities', async (t) => {
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
    const body = res.json<{
      claim: { id: string };
      activities: Array<{ id: string }>;
      narratives: Array<{ id: string }>;
    }>();
    assert.ok(body.claim);
    assert.equal(body.claim.id, CLAIM_ID);
    assert.ok(Array.isArray(body.activities));
    assert.ok(Array.isArray(body.narratives));

    await app.close();
  });
});
