import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { signSession } from '@cpa/auth';

/**
 * A-endpoints — expenditure mapping/apportionment/unmap integration tests.
 *
 * Separate from expenditures.test.ts (reclassify suite) to avoid
 * env-stub conflicts (reclassify sets EXPENDITURE_CLASSIFIER_IMPL=stub
 * at module load, which we don't need here).
 *
 * UUID namespace 0e1 to avoid collisions with the b3a reclassify fixtures.
 *
 * Coverage matrix:
 *   - GET  /v1/claims/:id/expenditures         — 401, list all, filter=unmapped, filter=mapped, RLS isolation
 *   - POST /v1/expenditures/:id/map             — 200, cross-claim 404, idempotent
 *   - POST /v1/expenditures/:id/apportion       — 200, validation 400s
 *   - POST /v1/expenditures/:id/unmap            — 200, 400 when not mapped
 *   - Voided expenditure 409 across all mutation routes
 */

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

const { sql, privilegedSql } = await import('@cpa/db/client');
const { buildApp } = await import('../app.js');

// Namespace 0e1... for expenditure-mapping fixtures.
const TENANT = '00000000-0000-4000-8000-0000000e1001';
const OTHER_TENANT = '00000000-0000-4000-8000-0000000e1002';
const USER = '00000000-0000-4000-8000-0000000e1010';
const SUBJECT = '00000000-0000-4000-8000-0000000e1021';
const OTHER_SUBJECT = '00000000-0000-4000-8000-0000000e1022';
const PROJECT = '00000000-0000-4000-8000-0000000e1031';
const CLAIM = '00000000-0000-4000-8000-0000000e1041';
const OTHER_CLAIM = '00000000-0000-4000-8000-0000000e1042';
const ACTIVITY_CA = '00000000-0000-4000-8000-0000000e1051';
const ACTIVITY_SA = '00000000-0000-4000-8000-0000000e1052';
const ACTIVITY_OTHER_CLAIM = '00000000-0000-4000-8000-0000000e1053';
const E1 = '00000000-0000-4000-8000-0000000e1061'; // unmapped
const E2 = '00000000-0000-4000-8000-0000000e1062'; // pre-mapped to ACTIVITY_CA
const E3 = '00000000-0000-4000-8000-0000000e1063'; // pre-apportioned across both
const E_VOIDED = '00000000-0000-4000-8000-0000000e1064'; // voided
const E_OTHER_TENANT = '00000000-0000-4000-8000-0000000e1065'; // RLS control

const cleanup = async (): Promise<void> => {
  await privilegedSql`DELETE FROM event WHERE tenant_id IN (${TENANT}, ${OTHER_TENANT})`;
  await privilegedSql`DELETE FROM expenditure WHERE tenant_id IN (${TENANT}, ${OTHER_TENANT})`;
  await privilegedSql`DELETE FROM activity WHERE tenant_id IN (${TENANT}, ${OTHER_TENANT})`;
  await privilegedSql`DELETE FROM claim WHERE tenant_id IN (${TENANT}, ${OTHER_TENANT})`;
  await privilegedSql`DELETE FROM project WHERE tenant_id IN (${TENANT}, ${OTHER_TENANT})`;
  await privilegedSql`DELETE FROM subject_tenant WHERE tenant_id IN (${TENANT}, ${OTHER_TENANT})`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id IN (${TENANT}, ${OTHER_TENANT})`;
  await sql`DELETE FROM "user" WHERE id = ${USER}`;
  await sql`DELETE FROM tenant WHERE id IN (${TENANT}, ${OTHER_TENANT})`;
};

before(async () => {
  await cleanup();
  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT}, 'Firm A Exp', 'firm-a-exp', 'mixed'),
                   (${OTHER_TENANT}, 'Firm B Exp', 'firm-b-exp', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${USER}, 'user-exp@example.com', 'microsoft', 'ms:exp', 'Exp User')`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                      VALUES (gen_random_uuid(), ${TENANT}, ${USER}, 'admin', true)`;
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                      VALUES (${SUBJECT}, ${TENANT}, 'Test Claimant', 'claimant'),
                             (${OTHER_SUBJECT}, ${OTHER_TENANT}, 'Other Tenant Claimant', 'claimant')`;
  await privilegedSql`INSERT INTO project (id, tenant_id, subject_tenant_id, name, started_at)
                      VALUES (${PROJECT}, ${TENANT}, ${SUBJECT}, 'Test Project', now())`;
  await privilegedSql`INSERT INTO claim (id, tenant_id, subject_tenant_id, project_id, fiscal_year, stage)
                      VALUES (${CLAIM}, ${TENANT}, ${SUBJECT}, ${PROJECT}, 2026, 'engagement'),
                             (${OTHER_CLAIM}, ${TENANT}, ${SUBJECT}, ${PROJECT}, 2025, 'engagement')`;
  // Activities — first two in CLAIM, third in OTHER_CLAIM (for cross-claim 404 test).
  await privilegedSql`INSERT INTO activity (id, tenant_id, project_id, claim_id, kind, code, name, hypothesis, technical_uncertainty, expected_outcome)
                      VALUES (${ACTIVITY_CA}, ${TENANT}, ${PROJECT}, ${CLAIM}, 'core', 'CA-001', 'Activity One', 'h', 'u', 'o'),
                             (${ACTIVITY_SA}, ${TENANT}, ${PROJECT}, ${CLAIM}, 'supporting', 'SA-001', 'Supporting', 'h', 'u', 'o'),
                             (${ACTIVITY_OTHER_CLAIM}, ${TENANT}, ${PROJECT}, ${OTHER_CLAIM}, 'core', 'CA-002', 'Other Claim Activity', 'h', 'u', 'o')`;
  // Expenditures
  await privilegedSql`INSERT INTO expenditure (id, tenant_id, subject_tenant_id, claim_id, source, vendor_name, expenditure_date, total_amount, currency)
                      VALUES (${E1},        ${TENANT}, ${SUBJECT}, ${CLAIM}, 'manual', 'Vendor 1', '2026-04-01', 100.00, 'AUD'),
                             (${E2},        ${TENANT}, ${SUBJECT}, ${CLAIM}, 'manual', 'Vendor 2', '2026-04-02', 200.00, 'AUD'),
                             (${E3},        ${TENANT}, ${SUBJECT}, ${CLAIM}, 'manual', 'Vendor 3', '2026-04-03', 300.00, 'AUD'),
                             (${E_VOIDED},  ${TENANT}, ${SUBJECT}, ${CLAIM}, 'manual', 'Voided',   '2026-04-04', 400.00, 'AUD'),
                             (${E_OTHER_TENANT}, ${OTHER_TENANT}, ${OTHER_SUBJECT}, NULL, 'manual', 'Cross Tenant', '2026-04-05', 500.00, 'AUD')`;
  await privilegedSql`UPDATE expenditure SET voided_at = now() WHERE id = ${E_VOIDED}`;
  // Seed chain events: E2 pre-mapped to ACTIVITY_CA, E3 pre-apportioned 60/40.
  // Use direct INSERT (not insertEventWithChain) — we only need the rows, not the hash chain integrity.
  await privilegedSql`
    INSERT INTO event (id, tenant_id, subject_tenant_id, kind, payload, hash, captured_at, received_at)
    VALUES
      (gen_random_uuid(), ${TENANT}, ${SUBJECT}, 'EXPENDITURE_MAPPED',
       jsonb_build_object('expenditure_id', ${E2}, 'activity_id', ${ACTIVITY_CA}, 'activity_code', 'CA-001', 'activity_title', 'Activity One'),
       encode(sha256('seed-e2'::bytea), 'hex'), now(), now()),
      (gen_random_uuid(), ${TENANT}, ${SUBJECT}, 'EXPENDITURE_APPORTIONED',
       jsonb_build_object('expenditure_id', ${E3}, 'allocations',
         jsonb_build_array(
           jsonb_build_object('activity_id', ${ACTIVITY_CA}, 'activity_code', 'CA-001', 'activity_title', 'Activity One', 'percentage', 60),
           jsonb_build_object('activity_id', ${ACTIVITY_SA}, 'activity_code', 'SA-001', 'activity_title', 'Supporting', 'percentage', 40))),
       encode(sha256('seed-e3'::bytea), 'hex'), now(), now())
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
      sub: USER,
      email: 'user-exp@example.com',
      primaryIdp: 'microsoft',
      activeTenantId: TENANT,
      activeRole: 'admin',
      availableTenants: [
        { tenantId: TENANT, name: 'Firm A Exp', slug: 'firm-a-exp', role: 'admin' },
      ],
    },
    SESSION_SECRET,
    { ttlSeconds: 3600 },
  );

// ---------------------------------------------------------------------------
// GET /v1/claims/:id/expenditures
// ---------------------------------------------------------------------------

test('GET /v1/claims/:id/expenditures: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: `/v1/claims/${CLAIM}/expenditures` });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('GET /v1/claims/:id/expenditures: returns all 4 with correct current_mapping', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/claims/${CLAIM}/expenditures`,
    cookies: { cpa_session: await userJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    expenditures: Array<{ id: string; current_mapping: { kind: string } | null }>;
  }>();
  // 4 rows: E1, E2, E3, E_VOIDED (all in CLAIM)
  assert.equal(body.expenditures.length, 4);
  const e1 = body.expenditures.find((e) => e.id === E1);
  const e2 = body.expenditures.find((e) => e.id === E2);
  const e3 = body.expenditures.find((e) => e.id === E3);
  assert.equal(e1?.current_mapping, null);
  assert.equal(e2?.current_mapping?.kind, 'single');
  assert.equal(e3?.current_mapping?.kind, 'apportioned');
  await app.close();
});

test('GET /v1/claims/:id/expenditures?filter=unmapped: returns only E1 + E_VOIDED', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/claims/${CLAIM}/expenditures?filter=unmapped`,
    cookies: { cpa_session: await userJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ expenditures: Array<{ id: string }> }>();
  const ids = body.expenditures.map((e) => e.id).sort();
  assert.deepEqual(ids, [E1, E_VOIDED].sort());
  await app.close();
});

test('GET /v1/claims/:id/expenditures?filter=mapped: returns E2 + E3', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/claims/${CLAIM}/expenditures?filter=mapped`,
    cookies: { cpa_session: await userJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ expenditures: Array<{ id: string }> }>();
  const ids = body.expenditures.map((e) => e.id).sort();
  assert.deepEqual(ids, [E2, E3].sort());
  await app.close();
});

test('GET /v1/claims/:id/expenditures: RLS isolation — other tenant invisible', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/claims/${CLAIM}/expenditures`,
    cookies: { cpa_session: await userJwt() },
  });
  const body = res.json<{ expenditures: Array<{ id: string }> }>();
  const ids = body.expenditures.map((e) => e.id);
  assert.ok(!ids.includes(E_OTHER_TENANT), 'cross-tenant expenditure must not appear');
  await app.close();
});

// ---------------------------------------------------------------------------
// POST /v1/expenditures/:id/map
// ---------------------------------------------------------------------------

test('POST /v1/expenditures/:id/map: 200, emits EXPENDITURE_MAPPED', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/expenditures/${E1}/map`,
    cookies: { cpa_session: await userJwt() },
    payload: { activity_id: ACTIVITY_SA },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ event: { kind: string; payload: { activity_id: string } } }>();
  assert.equal(body.event.kind, 'EXPENDITURE_MAPPED');
  assert.equal(body.event.payload.activity_id, ACTIVITY_SA);
  await app.close();
});

test('POST /v1/expenditures/:id/map: 404 when activity in different claim', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/expenditures/${E1}/map`,
    cookies: { cpa_session: await userJwt() },
    payload: { activity_id: ACTIVITY_OTHER_CLAIM },
  });
  assert.equal(res.statusCode, 404);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'activity_not_in_claim');
  await app.close();
});

test('POST /v1/expenditures/:id/map: idempotent re-map returns existing event', async () => {
  const app = buildApp();
  // E2 is already mapped to ACTIVITY_CA in the seed.
  const res = await app.inject({
    method: 'POST',
    url: `/v1/expenditures/${E2}/map`,
    cookies: { cpa_session: await userJwt() },
    payload: { activity_id: ACTIVITY_CA },
  });
  assert.equal(res.statusCode, 200);
  // No new event should have been inserted; verify by counting MAPPED events for E2.
  const evCount = await privilegedSql<{ count: string }[]>`
    SELECT count(*) FROM event WHERE kind = 'EXPENDITURE_MAPPED' AND (payload->>'expenditure_id') = ${E2}
  `;
  assert.equal(evCount[0]?.count, '1', 'no duplicate event written');
  await app.close();
});

// ---------------------------------------------------------------------------
// POST /v1/expenditures/:id/apportion
// ---------------------------------------------------------------------------

test('POST /v1/expenditures/:id/apportion: 200, emits EXPENDITURE_APPORTIONED', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/expenditures/${E1}/apportion`,
    cookies: { cpa_session: await userJwt() },
    payload: {
      allocations: [
        { activity_id: ACTIVITY_CA, percentage: 70 },
        { activity_id: ACTIVITY_SA, percentage: 30 },
      ],
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ event: { kind: string; payload: { allocations: unknown[] } } }>();
  assert.equal(body.event.kind, 'EXPENDITURE_APPORTIONED');
  assert.equal(body.event.payload.allocations.length, 2);
  await app.close();
});

test('POST /v1/expenditures/:id/apportion: 400 on validation errors', async () => {
  const app = buildApp();
  const cases = [
    // sum ≠ 100
    [
      { activity_id: ACTIVITY_CA, percentage: 50 },
      { activity_id: ACTIVITY_SA, percentage: 30 },
    ],
    // pct = 0
    [
      { activity_id: ACTIVITY_CA, percentage: 100 },
      { activity_id: ACTIVITY_SA, percentage: 0 },
    ],
    // duplicate activity
    [
      { activity_id: ACTIVITY_CA, percentage: 50 },
      { activity_id: ACTIVITY_CA, percentage: 50 },
    ],
    // empty array
    [],
  ];
  for (const allocations of cases) {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/expenditures/${E1}/apportion`,
      cookies: { cpa_session: await userJwt() },
      payload: { allocations },
    });
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(allocations)}`);
  }
  await app.close();
});

// ---------------------------------------------------------------------------
// POST /v1/expenditures/:id/unmap
// ---------------------------------------------------------------------------

test('POST /v1/expenditures/:id/unmap: 200, emits EXPENDITURE_UNMAPPED', async () => {
  const app = buildApp();
  // E2 is mapped in the seed.
  const res = await app.inject({
    method: 'POST',
    url: `/v1/expenditures/${E2}/unmap`,
    cookies: { cpa_session: await userJwt() },
    payload: { reason: 'wrong activity' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    event: { kind: string; payload: { prior_activity_id?: string; reason?: string } };
  }>();
  assert.equal(body.event.kind, 'EXPENDITURE_UNMAPPED');
  assert.equal(body.event.payload.prior_activity_id, ACTIVITY_CA);
  assert.equal(body.event.payload.reason, 'wrong activity');
  await app.close();
});

test('POST /v1/expenditures/:id/unmap: 400 when not currently mapped', async () => {
  const app = buildApp();
  // E1 has never been mapped (in the seed — the map test above may have mapped it,
  // but this is an integration test file run top-to-bottom; if the map test ran first
  // E1 is mapped. Use a fresh expenditure or accept that test ordering matters.
  // Since node:test runs in definition order by default and the map test mapped E1 to
  // ACTIVITY_SA, we need to unmap it first or use a different expenditure.
  // To keep this test independent, we verify against E_OTHER_TENANT which has no
  // mapping events — but it's cross-tenant. Instead, just test with the expected
  // error shape. E1 might be mapped from the earlier POST map test — this test needs
  // to account for that. We'll create a new expenditure lookup by using a nonexistent
  // UUID that won't have any mapping events... but that 404s.
  //
  // Simplest approach: unmap E1 first (if mapped), then try again.
  // But for a clean integration test: just call unmap on E1, which the POST map test
  // may have mapped. If it was mapped, first unmap succeeds; second unmap gets 400.
  const first = await app.inject({
    method: 'POST',
    url: `/v1/expenditures/${E1}/unmap`,
    cookies: { cpa_session: await userJwt() },
    payload: {},
  });
  // If E1 was mapped by the prior test, first call succeeds (200).
  // If not mapped, first call gets 400. Either way, the second call must 400.
  if (first.statusCode === 200) {
    const second = await app.inject({
      method: 'POST',
      url: `/v1/expenditures/${E1}/unmap`,
      cookies: { cpa_session: await userJwt() },
      payload: {},
    });
    assert.equal(second.statusCode, 400);
    const body = second.json<{ error: string }>();
    assert.equal(body.error, 'nothing_to_unmap');
  } else {
    assert.equal(first.statusCode, 400);
    const body = first.json<{ error: string }>();
    assert.equal(body.error, 'nothing_to_unmap');
  }
  await app.close();
});

// ---------------------------------------------------------------------------
// Voided expenditure — 409 across all mutation routes
// ---------------------------------------------------------------------------

test('POST any mutation on voided expenditure → 409', async () => {
  const app = buildApp();
  const routes = [
    { url: `/v1/expenditures/${E_VOIDED}/map`, payload: { activity_id: ACTIVITY_CA } },
    {
      url: `/v1/expenditures/${E_VOIDED}/apportion`,
      payload: {
        allocations: [
          { activity_id: ACTIVITY_CA, percentage: 60 },
          { activity_id: ACTIVITY_SA, percentage: 40 },
        ],
      },
    },
    { url: `/v1/expenditures/${E_VOIDED}/unmap`, payload: {} },
  ];
  for (const r of routes) {
    const res = await app.inject({
      method: 'POST',
      url: r.url,
      cookies: { cpa_session: await userJwt() },
      payload: r.payload,
    });
    assert.equal(res.statusCode, 409, `expected 409 on ${r.url}`);
    const body = res.json<{ error: string }>();
    assert.equal(body.error, 'expenditure_voided');
  }
  await app.close();
});
