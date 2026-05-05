import { test, after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { signSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../app.js';
import { _internals } from './compliance.js';

/**
 * P7 Theme D — compliance route tests.
 *
 * Live-DB tests use the same fixture pattern as prompt-suggestions.test.ts:
 * seed tenant + user + subject + activity fixtures, exercise the routes via
 * `app.inject()`, then teardown.
 *
 * Per the standard convention (Docker daemon unavailable in this worktree):
 * tests probe the connection in `before()` and skip the live-DB branches
 * if the probe fails, leaving the unit-level Zod assertions running
 * unconditionally. The DB-gated tests still run in CI where Postgres is
 * available.
 *
 * UUID segment: d200 — isolates from other test suites.
 */

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

// Fixture UUIDs — d200 segment
const TENANT_D2 = '00000000-0000-4000-8000-0000d2000001';
const USER_D2 = '00000000-0000-4000-8000-0000d2000002';
const SUBJECT_D2 = '00000000-0000-4000-8000-0000d2000003';
const PROJECT_D2 = '00000000-0000-4000-8000-0000d2000004';
const CLAIM_D2 = '00000000-0000-4000-8000-0000d2000005';
const ACTIVITY_D2A = '00000000-0000-4000-8000-0000d2000006';
const ACTIVITY_D2B = '00000000-0000-4000-8000-0000d2000007';

let dbAvailable = false;

const cleanup = async (): Promise<void> => {
  try {
    await privilegedSql`DELETE FROM rd_forecast WHERE tenant_id = ${TENANT_D2}`;
    await privilegedSql`DELETE FROM r_and_d_facility WHERE tenant_id = ${TENANT_D2}`;
    await privilegedSql`DELETE FROM knowledge_search_record WHERE tenant_id = ${TENANT_D2}`;
    await privilegedSql`DELETE FROM beneficial_ownership WHERE tenant_id = ${TENANT_D2}`;
    await privilegedSql`DELETE FROM activity WHERE tenant_id = ${TENANT_D2}`;
    await privilegedSql`DELETE FROM claim WHERE tenant_id = ${TENANT_D2}`;
    await privilegedSql`DELETE FROM project WHERE tenant_id = ${TENANT_D2}`;
    await privilegedSql`DELETE FROM subject_tenant WHERE tenant_id = ${TENANT_D2}`;
    await privilegedSql`DELETE FROM tenant_user WHERE tenant_id = ${TENANT_D2}`;
    await sql`DELETE FROM "user" WHERE id = ${USER_D2}`;
    await sql`DELETE FROM tenant WHERE id = ${TENANT_D2}`;
  } catch {
    // ignore — DB unreachable, cleanup is a no-op.
  }
};

before(async () => {
  try {
    await privilegedSql`SELECT 1`;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    return;
  }
  await cleanup();

  // Tenant
  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT_D2}, 'Compliance Test Firm', 'compliance-test', 'mixed')`;

  // User
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${USER_D2}, 'compliance-test@example.com', 'microsoft', 'microsoft:compliance-test', 'Compliance Tester')`;

  // Tenant-User binding
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT_D2}, ${USER_D2}, 'consultant', true)`;

  // Subject tenant (claimant entity)
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                       VALUES (${SUBJECT_D2}, ${TENANT_D2}, 'Test Claimant Pty Ltd', 'claimant')`;

  // Project
  await privilegedSql`INSERT INTO project (id, tenant_id, subject_tenant_id, name, started_at)
                       VALUES (${PROJECT_D2}, ${TENANT_D2}, ${SUBJECT_D2}, 'Test Project', NOW())`;

  // Claim
  await privilegedSql`INSERT INTO claim (id, tenant_id, subject_tenant_id, project_id, fiscal_year, stage)
                       VALUES (${CLAIM_D2}, ${TENANT_D2}, ${SUBJECT_D2}, ${PROJECT_D2}, 2025, 'activity_capture')`;

  // Activities
  await privilegedSql`INSERT INTO activity (id, tenant_id, project_id, claim_id, code, kind, title,
                                            fy_label, hypothesis_formed_at)
                       VALUES
                         (${ACTIVITY_D2A}, ${TENANT_D2}, ${PROJECT_D2}, ${CLAIM_D2},
                          'CA-01', 'core', 'Compliance Activity A',
                          'FY25', '2025-01-01T00:00:00Z'),
                         (${ACTIVITY_D2B}, ${TENANT_D2}, ${PROJECT_D2}, ${CLAIM_D2},
                          'CA-02', 'core', 'Compliance Activity B',
                          'FY25', '2025-01-15T00:00:00Z')`;
});

after(async () => {
  if (dbAvailable) await cleanup();
  try {
    await sql.end();
    await privilegedSql.end();
  } catch {
    // ignore
  }
});

const makeToken = (): Promise<string> =>
  signSession(
    {
      sub: USER_D2,
      email: 'compliance-test@example.com',
      primaryIdp: 'microsoft',
      activeTenantId: TENANT_D2,
      activeRole: 'consultant',
      availableTenants: [],
    },
    SESSION_SECRET,
    { ttlSeconds: 3600 },
  );

const skipIfNoDb = (t: { skip: (msg?: string) => void }): boolean => {
  if (!dbAvailable) {
    t.skip('Postgres not reachable — DB-gated test skipped');
    return true;
  }
  return false;
};

// ===========================================================================
// Unit-level tests — no DB required. Cover Zod schemas.
// ===========================================================================

describe('compliance: Zod input schemas', () => {
  test('BeneficialOwnershipInput validates correct input', () => {
    const r = _internals.BeneficialOwnershipInput.safeParse({
      subject_tenant_id: SUBJECT_D2,
      fy_label: 'FY25',
      owner_kind: 'individual',
      owner_name: 'Jane Smith',
      ownership_pct: 51,
      is_associate: false,
      is_foreign_related: false,
    });
    assert.equal(r.success, true);
  });

  test('BeneficialOwnershipInput rejects invalid owner_kind', () => {
    const r = _internals.BeneficialOwnershipInput.safeParse({
      subject_tenant_id: SUBJECT_D2,
      fy_label: 'FY25',
      owner_kind: 'government',
      owner_name: 'Jane Smith',
      ownership_pct: 51,
      is_associate: false,
      is_foreign_related: false,
    });
    assert.equal(r.success, false);
  });

  test('KnowledgeSearchInput validates correct input', () => {
    const r = _internals.KnowledgeSearchInput.safeParse({
      subject_tenant_id: SUBJECT_D2,
      activity_id: ACTIVITY_D2A,
      search_date: '2025-03-15',
      search_query: 'polymer degradation resistance',
      sources_consulted: ['IEEE Xplore', 'Google Scholar'],
      finding_summary: 'No prior art found for this specific approach.',
    });
    assert.equal(r.success, true);
  });

  test('ForecastInput rejects offset > 3', () => {
    const r = _internals.ForecastInput.safeParse({
      subject_tenant_id: SUBJECT_D2,
      base_fy_label: 'FY25',
      forecast_year_offset: 4,
      projected_spend_aud: 500000,
      projected_headcount: 5,
      confidence: 'medium',
    });
    assert.equal(r.success, false);
  });

  test('ForecastInput rejects invalid confidence value', () => {
    const r = _internals.ForecastInput.safeParse({
      subject_tenant_id: SUBJECT_D2,
      base_fy_label: 'FY25',
      forecast_year_offset: 1,
      projected_spend_aud: 500000,
      projected_headcount: 5,
      confidence: 'very_high',
    });
    assert.equal(r.success, false);
  });
});

// ===========================================================================
// HTTP / auth tests — auth gating runs before any SQL is touched, so these
// cases are DB-independent.
// ===========================================================================

describe('compliance: auth gating (no DB)', () => {
  const routes = [
    { method: 'POST' as const, url: '/v1/compliance/beneficial-ownership' },
    { method: 'GET' as const, url: `/v1/compliance/beneficial-ownership/${SUBJECT_D2}/FY25` },
    { method: 'POST' as const, url: '/v1/compliance/knowledge-search' },
    { method: 'POST' as const, url: '/v1/compliance/facilities' },
    { method: 'POST' as const, url: '/v1/compliance/forecast' },
    { method: 'POST' as const, url: '/v1/compliance/multi-entity-scan' },
    { method: 'GET' as const, url: `/v1/compliance/form-completeness/${SUBJECT_D2}/FY25` },
    { method: 'GET' as const, url: `/v1/compliance/at-risk-summary/${SUBJECT_D2}/FY25` },
  ];

  for (const { method, url } of routes) {
    test(`${method} ${url}: 401 without session`, async () => {
      const app = buildApp();
      const res = await app.inject({ method, url });
      assert.equal(res.statusCode, 401);
      await app.close();
    });
  }
});

// ===========================================================================
// DB-gated integration tests — exercise the full route + DB.
// ===========================================================================

describe('compliance: POST /v1/compliance/beneficial-ownership', () => {
  test('inserts BO row and returns id + generated flags', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildApp();
    const token = await makeToken();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/compliance/beneficial-ownership',
      headers: { cookie: `cpa_session=${token}` },
      payload: {
        subject_tenant_id: SUBJECT_D2,
        fy_label: 'FY25',
        owner_kind: 'individual',
        owner_name: 'Alice Test',
        ownership_pct: 75,
        is_associate: true,
        is_foreign_related: false,
      },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json<{ id: string; ta_2023_4_flag: boolean; ta_2023_5_flag: boolean }>();
    assert.ok(body.id);
    assert.equal(body.ta_2023_4_flag, true); // is_associate = true
    assert.equal(body.ta_2023_5_flag, false); // is_foreign_related = false
    await app.close();
  });

  test('rejects invalid owner_kind with 400', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildApp();
    const token = await makeToken();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/compliance/beneficial-ownership',
      headers: { cookie: `cpa_session=${token}` },
      payload: {
        subject_tenant_id: SUBJECT_D2,
        fy_label: 'FY25',
        owner_kind: 'government',
        owner_name: 'Bad Owner',
        ownership_pct: 10,
        is_associate: false,
        is_foreign_related: false,
      },
    });
    assert.equal(res.statusCode, 400);
    await app.close();
  });
});

describe('compliance: GET /v1/compliance/beneficial-ownership/:subject/:fy', () => {
  test('returns previously inserted BO rows with ta_2023_4_flag, ta_2023_5_flag', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildApp();
    const token = await makeToken();

    // Insert a row first
    await app.inject({
      method: 'POST',
      url: '/v1/compliance/beneficial-ownership',
      headers: { cookie: `cpa_session=${token}` },
      payload: {
        subject_tenant_id: SUBJECT_D2,
        fy_label: 'FY25',
        owner_kind: 'entity',
        owner_name: 'BO Get Test Corp',
        ownership_pct: 30,
        is_associate: false,
        is_foreign_related: true,
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/compliance/beneficial-ownership/${SUBJECT_D2}/FY25`,
      headers: { cookie: `cpa_session=${token}` },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{
      rows: { owner_name: string; ta_2023_4_flag: boolean; ta_2023_5_flag: boolean }[];
    }>();
    assert.ok(body.rows.length >= 1);
    // Find our specific row
    const row = body.rows.find((r) => r.owner_name === 'BO Get Test Corp');
    assert.ok(row);
    assert.equal(row.ta_2023_4_flag, false);
    assert.equal(row.ta_2023_5_flag, true);
    await app.close();
  });
});

describe('compliance: POST /v1/compliance/knowledge-search', () => {
  test('inserts knowledge search record', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildApp();
    const token = await makeToken();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/compliance/knowledge-search',
      headers: { cookie: `cpa_session=${token}` },
      payload: {
        subject_tenant_id: SUBJECT_D2,
        activity_id: ACTIVITY_D2A,
        search_date: '2025-03-10',
        search_query: 'novel composite material stress testing',
        sources_consulted: ['IEEE Xplore', 'Scopus', 'Google Patents'],
        finding_summary:
          'No existing research addresses the specific combination of factors in our hypothesis.',
      },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json<{ id: string; search_query: string }>();
    assert.ok(body.id);
    assert.equal(body.search_query, 'novel composite material stress testing');
    await app.close();
  });
});

describe('compliance: POST /v1/compliance/facilities', () => {
  test('inserts facility record', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildApp();
    const token = await makeToken();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/compliance/facilities',
      headers: { cookie: `cpa_session=${token}` },
      payload: {
        subject_tenant_id: SUBJECT_D2,
        fy_label: 'FY25',
        facility_name: 'Main R&D Laboratory',
        address: '42 Innovation Drive, Sydney NSW 2000',
        is_owned: true,
        used_for_activity_ids: [ACTIVITY_D2A, ACTIVITY_D2B],
      },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json<{ id: string; facility_name: string }>();
    assert.ok(body.id);
    assert.equal(body.facility_name, 'Main R&D Laboratory');
    await app.close();
  });
});

describe('compliance: POST /v1/compliance/forecast', () => {
  test('inserts forecast record', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildApp();
    const token = await makeToken();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/compliance/forecast',
      headers: { cookie: `cpa_session=${token}` },
      payload: {
        subject_tenant_id: SUBJECT_D2,
        base_fy_label: 'FY25',
        forecast_year_offset: 1,
        projected_spend_aud: 750000,
        projected_headcount: 8,
        confidence: 'high',
      },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json<{ id: string; projected_spend_aud: string; confidence: string }>();
    assert.ok(body.id);
    assert.equal(body.confidence, 'high');
    await app.close();
  });

  test('upserts on conflict (same subject+fy+offset)', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildApp();
    const token = await makeToken();

    // First insert
    const res1 = await app.inject({
      method: 'POST',
      url: '/v1/compliance/forecast',
      headers: { cookie: `cpa_session=${token}` },
      payload: {
        subject_tenant_id: SUBJECT_D2,
        base_fy_label: 'FY25',
        forecast_year_offset: 2,
        projected_spend_aud: 500000,
        projected_headcount: 5,
        confidence: 'medium',
      },
    });
    assert.equal(res1.statusCode, 201);

    // Second insert with same subject+fy+offset -> upsert
    const res2 = await app.inject({
      method: 'POST',
      url: '/v1/compliance/forecast',
      headers: { cookie: `cpa_session=${token}` },
      payload: {
        subject_tenant_id: SUBJECT_D2,
        base_fy_label: 'FY25',
        forecast_year_offset: 2,
        projected_spend_aud: 800000,
        projected_headcount: 10,
        confidence: 'high',
      },
    });
    assert.equal(res2.statusCode, 201);
    const body2 = res2.json<{ confidence: string }>();
    assert.equal(body2.confidence, 'high');

    // Verify only one row exists for this subject+fy+offset
    const rows = await privilegedSql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM rd_forecast
       WHERE tenant_id = ${TENANT_D2}
         AND subject_tenant_id = ${SUBJECT_D2}
         AND base_fy_label = 'FY25'
         AND forecast_year_offset = 2
    `;
    assert.equal(rows[0]?.count, '1');
    await app.close();
  });
});

describe('compliance: POST /v1/compliance/multi-entity-scan', () => {
  test('returns 202 with queued status (stub)', async () => {
    const app = buildApp();
    const token = await makeToken();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/compliance/multi-entity-scan',
      headers: { cookie: `cpa_session=${token}` },
      payload: {
        subject_tenant_id: SUBJECT_D2,
      },
    });
    // Multi-entity scan is a stub; if DB is unavailable we still get 202
    // because the route doesn't touch the DB (just validates + returns queued).
    assert.equal(res.statusCode, 202);
    const body = res.json<{ status: string; message: string }>();
    assert.equal(body.status, 'queued');
    await app.close();
  });
});

describe('compliance: GET /v1/compliance/form-completeness/:subject/:fy', () => {
  test('returns completeness check structure', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildApp();
    const token = await makeToken();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/compliance/form-completeness/${SUBJECT_D2}/FY25`,
      headers: { cookie: `cpa_session=${token}` },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{
      complete: boolean;
      checks: {
        knowledge_search: { complete: boolean; missing_activity_ids: string[] };
        beneficial_ownership: { complete: boolean; count: number };
        forecast: { complete: boolean; missing_offsets: number[] };
        facilities: { complete: boolean; count: number };
        narratives: { complete: boolean; warnings: unknown[] };
      };
    }>();
    assert.equal(typeof body.complete, 'boolean');
    assert.ok('knowledge_search' in body.checks);
    assert.ok('beneficial_ownership' in body.checks);
    assert.ok('forecast' in body.checks);
    assert.ok('facilities' in body.checks);
    assert.ok('narratives' in body.checks);
    await app.close();
  });

  test('returns incomplete status when data is missing', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildApp();
    const token = await makeToken();
    // Query for a FY that has no data seeded
    const res = await app.inject({
      method: 'GET',
      url: `/v1/compliance/form-completeness/${SUBJECT_D2}/FY30`,
      headers: { cookie: `cpa_session=${token}` },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{
      complete: boolean;
      checks: {
        beneficial_ownership: { complete: boolean; count: number };
        forecast: { complete: boolean; missing_offsets: number[] };
        facilities: { complete: boolean; count: number };
      };
    }>();
    assert.equal(body.complete, false);
    assert.equal(body.checks.beneficial_ownership.complete, false);
    assert.equal(body.checks.beneficial_ownership.count, 0);
    assert.equal(body.checks.forecast.complete, false);
    assert.deepEqual(body.checks.forecast.missing_offsets, [1, 2, 3]);
    assert.equal(body.checks.facilities.complete, false);
    assert.equal(body.checks.facilities.count, 0);
    await app.close();
  });
});

describe('compliance: GET /v1/compliance/at-risk-summary/:subject/:fy', () => {
  test('returns risk summary structure', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildApp();
    const token = await makeToken();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/compliance/at-risk-summary/${SUBJECT_D2}/FY25`,
      headers: { cookie: `cpa_session=${token}` },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{
      subject_tenant_id: string;
      fy_label: string;
      total_claimed: number;
      total_at_risk: number;
      activities: {
        activity_id: string;
        title: string;
        claimed_amount: number;
        at_risk_amount: number;
        clawback_4yr: number;
      }[];
    }>();
    assert.equal(body.subject_tenant_id, SUBJECT_D2);
    assert.equal(body.fy_label, 'FY25');
    assert.equal(typeof body.total_claimed, 'number');
    assert.equal(typeof body.total_at_risk, 'number');
    assert.ok(Array.isArray(body.activities));
    await app.close();
  });
});
