import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { signSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../../app.js';

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

// Namespace 0d4000... for D4 KPI tests.
const TENANT_A = '00000000-0000-4000-8000-00000d400001';
const TENANT_B = '00000000-0000-4000-8000-00000d400002';
const USER_A = '00000000-0000-4000-8000-00000d400010';

// One subject per claim — `claim_subject_tenant_fiscal_year_unique` enforces
// one claim per claimant per FY, so three claims under tenant A need three
// distinct subject_tenants.
const SUBJECT_A1 = '00000000-0000-4000-8000-00000d400021';
const SUBJECT_A2 = '00000000-0000-4000-8000-00000d400022';
const SUBJECT_A3 = '00000000-0000-4000-8000-00000d400023';
const SUBJECT_B1 = '00000000-0000-4000-8000-00000d400024';

// Two active claims in TENANT_A (one with chain block, one without — to
// exercise both atRisk + chain coverage).
const CLAIM_A1 = '00000000-0000-4000-8000-00000d400031';
const CLAIM_A2 = '00000000-0000-4000-8000-00000d400032';
// One submitted claim in TENANT_A — must NOT count as active.
const CLAIM_A_SEALED = '00000000-0000-4000-8000-00000d400033';
// One active claim in TENANT_B — must be invisible to USER_A (cross-tenant).
const CLAIM_B1 = '00000000-0000-4000-8000-00000d400034';

// One project per active activity (activity.project_id is NOT NULL).
const PROJECT_A1 = '00000000-0000-4000-8000-00000d40003a';
const PROJECT_A2 = '00000000-0000-4000-8000-00000d40003b';
const PROJECT_B1 = '00000000-0000-4000-8000-00000d40003c';

const ACTIVITY_A1_WITH_HYP = '00000000-0000-4000-8000-00000d400041';
const ACTIVITY_A2_NO_HYP = '00000000-0000-4000-8000-00000d400042';
const ACTIVITY_B1 = '00000000-0000-4000-8000-00000d400043';

const EVENT_BLOCK_A1 = '00000000-0000-4000-8000-00000d400051';
const EVENT_BLOCK_B1 = '00000000-0000-4000-8000-00000d400052';

const FY = 2026;

const cleanup = async (): Promise<void> => {
  // FK chain: events -> activities -> claims/projects -> subject_tenants
  //           -> tenant_user -> user -> tenant.
  await privilegedSql`DELETE FROM event WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM activity WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM claim WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM project WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM subject_tenant WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM "user" WHERE id = ${USER_A}`;
  await privilegedSql`DELETE FROM tenant WHERE id IN (${TENANT_A}, ${TENANT_B})`;
};

before(async () => {
  await cleanup();
  await privilegedSql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT_A}, 'Firm A KPI', 'firm-a-kpi-c', 'mixed'),
                   (${TENANT_B}, 'Firm B KPI', 'firm-b-kpi-c', 'mixed')`;
  await privilegedSql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${USER_A}, 'user-a-kpi@example.com', 'microsoft', 'ms:kpi-a', 'KPI User A')`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role)
                      VALUES (gen_random_uuid(), ${TENANT_A}, ${USER_A}, 'admin')`;
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name)
                      VALUES (${SUBJECT_A1}, ${TENANT_A}, 'Claimant A1'),
                             (${SUBJECT_A2}, ${TENANT_A}, 'Claimant A2'),
                             (${SUBJECT_A3}, ${TENANT_A}, 'Claimant A3'),
                             (${SUBJECT_B1}, ${TENANT_B}, 'Claimant B1')`;

  // TENANT_A: two active claims + one sealed. One claim per claimant per FY
  // (claim_subject_tenant_fiscal_year_unique constraint).
  await privilegedSql`
    INSERT INTO claim (id, tenant_id, subject_tenant_id, fiscal_year, stage)
    VALUES
      (${CLAIM_A1},        ${TENANT_A}, ${SUBJECT_A1}, ${FY},   'review'),
      (${CLAIM_A2},        ${TENANT_A}, ${SUBJECT_A2}, ${FY},   'activity_capture'),
      (${CLAIM_A_SEALED},  ${TENANT_A}, ${SUBJECT_A3}, ${FY},   'submitted')
  `;
  // TENANT_B: one active claim — RLS must hide it from USER_A.
  await privilegedSql`
    INSERT INTO claim (id, tenant_id, subject_tenant_id, fiscal_year, stage)
    VALUES (${CLAIM_B1}, ${TENANT_B}, ${SUBJECT_B1}, ${FY}, 'review')
  `;

  // Project rows — activity.project_id is NOT NULL.
  await privilegedSql`
    INSERT INTO project (id, tenant_id, subject_tenant_id, name, started_at)
    VALUES
      (${PROJECT_A1}, ${TENANT_A}, ${SUBJECT_A1}, 'Project A1', '2025-07-01T00:00:00Z'),
      (${PROJECT_A2}, ${TENANT_A}, ${SUBJECT_A2}, 'Project A2', '2025-07-01T00:00:00Z'),
      (${PROJECT_B1}, ${TENANT_B}, ${SUBJECT_B1}, 'Project B1', '2025-07-01T00:00:00Z')
  `;

  // CLAIM_A1: activity WITH hypothesis (not at-risk) + chain block event.
  await privilegedSql`
    INSERT INTO activity (id, tenant_id, project_id, claim_id, code, kind, title, hypothesis, fy_label, hypothesis_formed_at)
    VALUES (${ACTIVITY_A1_WITH_HYP}, ${TENANT_A}, ${PROJECT_A1}, ${CLAIM_A1},
            'CA-01', 'core', 'Activity A1', 'Hypothesis present', 'FY26', '2025-08-01T00:00:00Z')
  `;
  // CLAIM_A2: activity WITHOUT hypothesis (at-risk) + NO chain block.
  await privilegedSql`
    INSERT INTO activity (id, tenant_id, project_id, claim_id, code, kind, title, hypothesis, fy_label, hypothesis_formed_at)
    VALUES (${ACTIVITY_A2_NO_HYP}, ${TENANT_A}, ${PROJECT_A2}, ${CLAIM_A2},
            'CA-02', 'core', 'Activity A2', NULL, 'FY26', '2025-08-01T00:00:00Z')
  `;
  // CLAIM_B1: activity + chain block — must be invisible to USER_A.
  await privilegedSql`
    INSERT INTO activity (id, tenant_id, project_id, claim_id, code, kind, title, hypothesis, fy_label, hypothesis_formed_at)
    VALUES (${ACTIVITY_B1}, ${TENANT_B}, ${PROJECT_B1}, ${CLAIM_B1},
            'CA-01', 'core', 'Activity B1', 'Other tenant hypothesis', 'FY26', '2025-08-01T00:00:00Z')
  `;

  // Chain block for CLAIM_A1 (via activity_id pointer in payload).
  await privilegedSql`
    INSERT INTO event (id, tenant_id, subject_tenant_id, kind, payload, hash, captured_at, received_at, captured_by_user_id)
    VALUES
      (${EVENT_BLOCK_A1}, ${TENANT_A}, ${SUBJECT_A1}, 'ARTEFACT_LINKED',
        ${{ activity_id: ACTIVITY_A1_WITH_HYP, raw_text: 'A1 block' }},
        encode(sha256('a1-block'::bytea), 'hex'),
        '2026-05-15T10:00:00Z', now(), ${USER_A}),
      (${EVENT_BLOCK_B1}, ${TENANT_B}, ${SUBJECT_B1}, 'ARTEFACT_LINKED',
        ${{ activity_id: ACTIVITY_B1, raw_text: 'B1 block — must be invisible' }},
        encode(sha256('b1-block'::bytea), 'hex'),
        '2026-05-15T10:00:00Z', now(), ${USER_A})
  `;
});

after(async () => {
  await cleanup();
  await sql.end();
  await privilegedSql.end();
});

const userJwt = (): Promise<string> =>
  signSession(
    {
      sub: USER_A,
      email: 'user-a-kpi@example.com',
      primaryIdp: 'microsoft',
      activeTenantId: TENANT_A,
      activeRole: 'admin',
      availableTenants: [
        { tenantId: TENANT_A, name: 'Firm A KPI', slug: 'firm-a-kpi-c', role: 'admin' },
      ],
    },
    SESSION_SECRET,
    { ttlSeconds: 3600 },
  );

test('GET /v1/consultant/kpis: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/v1/consultant/kpis?fy=FY26' });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('GET /v1/consultant/kpis: 400 when fy is missing or invalid', async () => {
  const app = buildApp();
  const cookie = await userJwt();
  const noFy = await app.inject({
    method: 'GET',
    url: '/v1/consultant/kpis',
    cookies: { cpa_session: cookie },
  });
  assert.equal(noFy.statusCode, 400);

  const garbage = await app.inject({
    method: 'GET',
    url: '/v1/consultant/kpis?fy=notayear',
    cookies: { cpa_session: cookie },
  });
  assert.equal(garbage.statusCode, 400);
  await app.close();
});

test('GET /v1/consultant/kpis: happy path counts tenant-A claims/events for FY26', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/consultant/kpis?fy=FY26',
    cookies: { cpa_session: await userJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    activeClaims: number;
    evidenceIndexed: number;
    atRisk: number;
    chainCoveragePct: number;
    deltas: {
      activeClaimsVsLastFy: number | null;
      evidenceIndexedPctYoY: number | null;
      atRiskVsYesterday: number | null;
      chainCoveragePtsYoY: number | null;
    };
  }>();

  // Two active claims (A1 review, A2 activity_capture). CLAIM_A_SEALED is in
  // 'submitted' which is NOT in STATUS_TO_STAGES.active.
  assert.equal(body.activeClaims, 2, 'two active claims under tenant A');
  // One chain-block event linked to an activity in tenant A.
  assert.equal(body.evidenceIndexed, 1, 'one evidence block under tenant A');
  // CLAIM_A2 has an activity with NULL hypothesis -> at-risk.
  assert.equal(body.atRisk, 1, 'one at-risk claim under tenant A');
  // CLAIM_A1 has 1 block; CLAIM_A2 has 0. Coverage = 1/2 = 50%.
  assert.equal(body.chainCoveragePct, 50, '1/2 claims covered');
  // Daily snapshot job not yet implemented -> null.
  assert.equal(body.deltas.atRiskVsYesterday, null);
  await app.close();
});

test('GET /v1/consultant/kpis: empty deltas when prior FY has no data', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/consultant/kpis?fy=FY26',
    cookies: { cpa_session: await userJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    deltas: {
      activeClaimsVsLastFy: number | null;
      evidenceIndexedPctYoY: number | null;
      chainCoveragePtsYoY: number | null;
    };
  }>();

  // No FY25 data was seeded.
  // activeClaimsVsLastFy = current - 0 = current count (not null per contract).
  assert.equal(body.deltas.activeClaimsVsLastFy, 2);
  // evidenceIndexedPctYoY: prior = 0, must be null (avoid divide-by-zero).
  assert.equal(body.deltas.evidenceIndexedPctYoY, null);
  // chainCoveragePtsYoY: prior had no active claims, must be null.
  assert.equal(body.deltas.chainCoveragePtsYoY, null);
  await app.close();
});

test('GET /v1/consultant/kpis: RLS isolates tenant B claim from tenant A caller', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/consultant/kpis?fy=FY26',
    cookies: { cpa_session: await userJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ activeClaims: number; evidenceIndexed: number }>();

  // If RLS were broken, activeClaims would be 3 (A1+A2+B1) and
  // evidenceIndexed would be 2 (A1's block + B1's block). It must be
  // exactly the tenant-A figures.
  assert.equal(body.activeClaims, 2, 'tenant B claim is invisible');
  assert.equal(body.evidenceIndexed, 1, "tenant B's block is invisible");
  await app.close();
});
