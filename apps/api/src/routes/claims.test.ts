import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { signSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../app.js';

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

// Per-test UUID prefixes — `0000a2XXXX` is the T-A2 namespace (P4 Swimlane A,
// Task 2, claim routes). Disjoint from T-A1's `0000a1XXXX` so parallel test
// runs don't collide on shared cleanup paths (audit_score_snapshot, etc.).
const TENANT_A = '00000000-0000-4000-8000-0000000a2001';
const TENANT_B = '00000000-0000-4000-8000-0000000a2002';
const ADMIN_USER = '00000000-0000-4000-8000-0000000a2010';
const VIEWER_USER = '00000000-0000-4000-8000-0000000a2011';
const CONSULTANT_USER = '00000000-0000-4000-8000-0000000a2012';
// Tenant-B admin — same convention as A1's cross-firm RLS positive control.
const TENANT_B_ADMIN = '00000000-0000-4000-8000-0000000a2013';
const SUBJECT_A1 = '00000000-0000-4000-8000-0000000a2021';
const SUBJECT_A2 = '00000000-0000-4000-8000-0000000a2022';
const SUBJECT_B1 = '00000000-0000-4000-8000-0000000a2023';

// Pre-seeded claim rows used by the GET / PATCH tests.
const CLAIM_PRESEED_A_ENGAGEMENT = '00000000-0000-4000-8000-0000000a2031';
const CLAIM_PRESEED_A_REVIEW = '00000000-0000-4000-8000-0000000a2032';
const CLAIM_PRESEED_A_SUBMITTED = '00000000-0000-4000-8000-0000000a2033';
const CLAIM_PRESEED_B = '00000000-0000-4000-8000-0000000a2034';
// Project fixtures for the Task 4.2 ?project_id= filter tests. Two
// projects under firm A — one tagged on CLAIM_PRESEED_A_ENGAGEMENT,
// the other untagged so we can assert the filter excludes it.
const PROJECT_A_TAGGED = '00000000-0000-4000-8000-0000000a2041';
const PROJECT_A_OTHER = '00000000-0000-4000-8000-0000000a2042';

const TENANT_IDS = [TENANT_A, TENANT_B] as const;

/**
 * FK-safe cleanup. Defensively clears `audit_score_snapshot` first because
 * that table FK-references `subject_tenant`, then `event` (FK references
 * tenant + subject_tenant but nothing references it back), then activity
 * (FK references claim), then claim, then subject_tenant_user/subject_tenant,
 * then tenant_user/user/tenant.
 */
const cleanup = async (): Promise<void> => {
  await privilegedSql`
    DELETE FROM audit_score_snapshot
     WHERE subject_tenant_id IN (
       SELECT id FROM subject_tenant WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})
     )
  `;
  await privilegedSql`
    DELETE FROM event
     WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})
  `;
  await privilegedSql`DELETE FROM activity WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM claim WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM project WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM subject_tenant_user WHERE subject_tenant_id IN (
    SELECT id FROM subject_tenant WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})
  )`;
  await privilegedSql`DELETE FROM subject_tenant WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await sql`DELETE FROM "user" WHERE id IN (${ADMIN_USER}, ${VIEWER_USER}, ${CONSULTANT_USER}, ${TENANT_B_ADMIN})`;
  await sql`DELETE FROM tenant WHERE id IN (${TENANT_A}, ${TENANT_B})`;
};

before(async () => {
  await cleanup();

  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT_A}, 'Firm A', 'firm-a-a2', 'mixed'),
                   (${TENANT_B}, 'Firm B', 'firm-b-a2', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${ADMIN_USER}, 'a2-admin@example.com', 'microsoft', 'microsoft:a2-admin', 'A2 Admin'),
                   (${VIEWER_USER}, 'a2-viewer@example.com', 'microsoft', 'microsoft:a2-viewer', 'A2 Viewer'),
                   (${CONSULTANT_USER}, 'a2-cons@example.com', 'microsoft', 'microsoft:a2-cons', 'A2 Consultant'),
                   (${TENANT_B_ADMIN}, 'a2-admin-b@example.com', 'microsoft', 'microsoft:a2-admin-b', 'A2 Admin (Firm B)')`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT_A}, ${ADMIN_USER}, 'admin', true),
                              (gen_random_uuid(), ${TENANT_A}, ${VIEWER_USER}, 'viewer', true),
                              (gen_random_uuid(), ${TENANT_A}, ${CONSULTANT_USER}, 'consultant', true),
                              (gen_random_uuid(), ${TENANT_B}, ${TENANT_B_ADMIN}, 'admin', true)`;
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                       VALUES (${SUBJECT_A1}, ${TENANT_A}, 'A2 Acme Co', 'claimant'),
                              (${SUBJECT_A2}, ${TENANT_A}, 'A2 Beta Ltd', 'claimant'),
                              (${SUBJECT_B1}, ${TENANT_B}, 'A2 Other Corp', 'claimant')`;
  // Project fixtures for the Task 4.2 project_id filter tests.
  await privilegedSql`
    INSERT INTO project (id, tenant_id, subject_tenant_id, name, started_at)
    VALUES
      (${PROJECT_A_TAGGED}, ${TENANT_A}, ${SUBJECT_A1}, 'A2 Tagged Project',
       '2024-01-01T00:00:00Z'::timestamptz),
      (${PROJECT_A_OTHER}, ${TENANT_A}, ${SUBJECT_A1}, 'A2 Other Project',
       '2024-01-01T00:00:00Z'::timestamptz)
  `;
  // Pre-seed claim rows for GET / PATCH tests:
  // - engagement: the canonical starting stage; tagged with PROJECT_A_TAGGED
  //   so the project_id filter test has a non-empty positive case.
  // - review: a mid-pipeline stage (used to test backward transitions)
  // - submitted: a terminal stage (used to test cannot_revert + ausindustry_ref gating)
  // - cross-firm B: used to test 404 cross-firm
  await privilegedSql`
    INSERT INTO claim (id, tenant_id, subject_tenant_id, fiscal_year, stage, project_id)
    VALUES
      (${CLAIM_PRESEED_A_ENGAGEMENT}, ${TENANT_A}, ${SUBJECT_A1}, 2024, 'engagement', ${PROJECT_A_TAGGED}),
      (${CLAIM_PRESEED_A_REVIEW}, ${TENANT_A}, ${SUBJECT_A2}, 2024, 'review', NULL),
      (${CLAIM_PRESEED_A_SUBMITTED}, ${TENANT_A}, ${SUBJECT_A1}, 2023, 'submitted', NULL),
      (${CLAIM_PRESEED_B}, ${TENANT_B}, ${SUBJECT_B1}, 2024, 'engagement', NULL)
  `;
});

after(async () => {
  await cleanup();
  await sql.end();
  await privilegedSql.end();
});

const jwtFor = (
  userId: string,
  email: string,
  role: 'admin' | 'consultant' | 'viewer',
  tenantId: string = TENANT_A,
): Promise<string> =>
  signSession(
    {
      sub: userId,
      email,
      primaryIdp: 'microsoft',
      activeTenantId: tenantId,
      activeRole: role,
      availableTenants: [],
    },
    SESSION_SECRET,
    { ttlSeconds: 3600 },
  );

const adminJwt = (): Promise<string> => jwtFor(ADMIN_USER, 'a2-admin@example.com', 'admin');
const viewerJwt = (): Promise<string> => jwtFor(VIEWER_USER, 'a2-viewer@example.com', 'viewer');
const consultantJwt = (): Promise<string> =>
  jwtFor(CONSULTANT_USER, 'a2-cons@example.com', 'consultant');
const tenantBAdminJwt = (): Promise<string> =>
  jwtFor(TENANT_B_ADMIN, 'a2-admin-b@example.com', 'admin', TENANT_B);

void TENANT_IDS;

// =============================================================================
// POST /v1/claims
// =============================================================================

test('POST /v1/claims: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/claims',
    payload: { subject_tenant_id: SUBJECT_A1, fiscal_year: 2025 },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /v1/claims: 201 + DB row, default stage = engagement, no event written', async () => {
  // Distinct FY to avoid the unique (subject_tenant_id, fiscal_year) collision
  // with preseed rows.
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/claims',
    cookies: { cpa_session: await consultantJwt() },
    payload: { subject_tenant_id: SUBJECT_A1, fiscal_year: 2026 },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json<{
    claim: {
      id: string;
      tenant_id: string;
      subject_tenant_id: string;
      fiscal_year: number;
      stage: string;
    };
  }>();
  assert.equal(body.claim.tenant_id, TENANT_A);
  assert.equal(body.claim.subject_tenant_id, SUBJECT_A1);
  assert.equal(body.claim.fiscal_year, 2026);
  // Default stage is 'engagement' even when the body omits it.
  assert.equal(body.claim.stage, 'engagement');

  // POST /v1/claims does NOT emit a CLAIM_CREATED event (no such kind in
  // the chain — the first event is CLAIM_STAGE_ADVANCED on first advance).
  const eventRows = await privilegedSql<{ id: string }[]>`
    SELECT id FROM event
     WHERE subject_tenant_id = ${SUBJECT_A1}
       AND payload ->> 'claim_id' = ${body.claim.id}
  `;
  assert.equal(eventRows.length, 0);

  // Cleanup so the unique constraint doesn't trip the next run.
  await privilegedSql`DELETE FROM claim WHERE id = ${body.claim.id}`;
  await app.close();
});

test('POST /v1/claims: writes workflow_state transactionally — is_wizard_claim=true and GET /workflow is 200 immediately', async () => {
  // Fix 1 (Phase 7.1 race): workflow_state is set inside the same INSERT
  // as the claim row, so GET /v1/claims/:id/workflow returns 200 (not 404)
  // on the very next request. Previously a follow-on initializeWorkflow
  // call ran client-side; if it failed silently the wizard 404'd.
  const app = buildApp();
  const session = await consultantJwt();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/claims',
    cookies: { cpa_session: session },
    payload: { subject_tenant_id: SUBJECT_A2, fiscal_year: 2029 },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json<{ claim: { id: string; is_wizard_claim: boolean } }>();
  // Every newly-created claim is a wizard claim from the moment it lands.
  assert.equal(body.claim.is_wizard_claim, true);

  // GET /workflow must succeed immediately — no race window.
  const wfRes = await app.inject({
    method: 'GET',
    url: `/v1/claims/${body.claim.id}/workflow`,
    cookies: { cpa_session: session },
  });
  assert.equal(wfRes.statusCode, 200);
  const wfBody = wfRes.json<{
    workflow_state: { initialized_at: string; steps: Record<string, unknown> };
  }>();
  assert.equal(typeof wfBody.workflow_state.initialized_at, 'string');
  assert.equal(wfBody.workflow_state.steps['1'], null);
  assert.equal(wfBody.workflow_state.steps['5'], null);

  await privilegedSql`DELETE FROM claim WHERE id = ${body.claim.id}`;
  await app.close();
});

test('POST /v1/claims: 201 + explicit stage honoured', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/claims',
    cookies: { cpa_session: await consultantJwt() },
    payload: { subject_tenant_id: SUBJECT_A2, fiscal_year: 2026, stage: 'review' },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json<{ claim: { id: string; stage: string } }>();
  assert.equal(body.claim.stage, 'review');

  await privilegedSql`DELETE FROM claim WHERE id = ${body.claim.id}`;
  await app.close();
});

test('POST /v1/claims: 409 on duplicate (subject_tenant_id, fiscal_year)', async () => {
  // The preseed already has a claim for SUBJECT_A1 / 2024 (engagement).
  // A second POST for that pair should hit the UNIQUE constraint and
  // surface as a 409 with error: 'duplicate'.
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/claims',
    cookies: { cpa_session: await consultantJwt() },
    payload: { subject_tenant_id: SUBJECT_A1, fiscal_year: 2024 },
  });
  assert.equal(res.statusCode, 409);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'duplicate');
  await app.close();
});

test('POST /v1/claims: 400 on invalid body (missing fiscal_year)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/claims',
    cookies: { cpa_session: await consultantJwt() },
    payload: { subject_tenant_id: SUBJECT_A1 },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /v1/claims: 403 for viewer role', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/claims',
    cookies: { cpa_session: await viewerJwt() },
    payload: { subject_tenant_id: SUBJECT_A1, fiscal_year: 2027 },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('POST /v1/claims: 404 cross-firm subject_tenant', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/claims',
    cookies: { cpa_session: await adminJwt() },
    payload: { subject_tenant_id: SUBJECT_B1, fiscal_year: 2025 },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

// =============================================================================
// GET /v1/claims
// =============================================================================

test('GET /v1/claims: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/v1/claims' });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('GET /v1/claims: returns firm-A rows only (RLS filters firm-B)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/claims',
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    claims: Array<{ id: string; tenant_id: string }>;
  }>();
  assert.ok(body.claims.length >= 3);
  assert.ok(body.claims.every((c) => c.tenant_id === TENANT_A));
  assert.ok(!body.claims.some((c) => c.id === CLAIM_PRESEED_B));
  await app.close();
});

test('GET /v1/claims: positive-control — firm-B session DOES see firm-B claim (cross-firm RLS)', async () => {
  // Counterpart to the firm-A isolation test above. Without this, a bug
  // where RLS silently returns nothing-for-everyone would still pass the
  // "firm-A doesn't see firm-B" check.
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/claims',
    cookies: { cpa_session: await tenantBAdminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ claims: Array<{ id: string; tenant_id: string }> }>();
  assert.ok(body.claims.some((c) => c.id === CLAIM_PRESEED_B));
  assert.ok(body.claims.every((c) => c.tenant_id === TENANT_B));
  // Belt + braces: firm-B session must NOT see firm-A's preseeds.
  assert.ok(!body.claims.some((c) => c.id === CLAIM_PRESEED_A_ENGAGEMENT));
  await app.close();
});

test('GET /v1/claims?subject_tenant_id=...: filters to one claimant', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/claims?subject_tenant_id=${SUBJECT_A1}`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ claims: Array<{ subject_tenant_id: string }> }>();
  assert.ok(body.claims.length >= 1);
  assert.ok(body.claims.every((c) => c.subject_tenant_id === SUBJECT_A1));
  await app.close();
});

test('GET /v1/claims?stage=review: filters to one stage', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/claims?stage=review',
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ claims: Array<{ id: string; stage: string }> }>();
  assert.ok(body.claims.every((c) => c.stage === 'review'));
  assert.ok(body.claims.some((c) => c.id === CLAIM_PRESEED_A_REVIEW));
  await app.close();
});

test('GET /v1/claims?fiscal_year=2024: filters to one FY', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/claims?fiscal_year=2024',
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ claims: Array<{ id: string; fiscal_year: number }> }>();
  assert.ok(body.claims.length >= 2);
  assert.ok(body.claims.every((c) => c.fiscal_year === 2024));
  await app.close();
});

test('GET /v1/claims: 400 on invalid query (non-uuid subject_tenant_id)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/claims?subject_tenant_id=not-a-uuid',
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

// =============================================================================
// GET /v1/claims?project_id= filter — Task 4.2.
//
// Uses the denormalised claim.project_id FK landed by P5 swimlane A
// Task 1.1. Direct WHERE predicate; the indexed
// claim_project_id_idx makes this fast even with thousands of claims
// per firm.
// =============================================================================

test('GET /v1/claims?project_id=X: narrows to claims tagged with that project', async () => {
  // CLAIM_PRESEED_A_ENGAGEMENT is tagged with PROJECT_A_TAGGED; the
  // others (REVIEW, SUBMITTED, cross-firm B) are not tagged. Filter
  // must include only the tagged one.
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/claims?project_id=${PROJECT_A_TAGGED}`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ claims: Array<{ id: string }> }>();
  assert.equal(body.claims.length, 1);
  assert.equal(body.claims[0]?.id, CLAIM_PRESEED_A_ENGAGEMENT);
  await app.close();
});

test('GET /v1/claims?project_id=Y: returns empty list when project has no claims', async () => {
  // PROJECT_A_OTHER exists but no claim is tagged with it.
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/claims?project_id=${PROJECT_A_OTHER}`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ claims: unknown[] }>();
  assert.equal(body.claims.length, 0);
  await app.close();
});

test('GET /v1/claims?project_id=not-a-uuid: 400', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/claims?project_id=not-a-uuid',
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 400);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'invalid_query');
  await app.close();
});

test('GET /v1/claims/:id: detail returns the claim + counts', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/claims/${CLAIM_PRESEED_A_ENGAGEMENT}`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    claim: { id: string; stage: string };
    counts: { activity_count: number; mapped_line_count: number; total_expenditure: number };
  }>();
  assert.equal(body.claim.id, CLAIM_PRESEED_A_ENGAGEMENT);
  assert.equal(body.claim.stage, 'engagement');
  // No activities seeded for this claim — count should be 0.
  assert.equal(body.counts.activity_count, 0);
  // mapped_line_count + total_expenditure are stubbed (Swimlane B work).
  assert.equal(body.counts.mapped_line_count, 0);
  assert.equal(body.counts.total_expenditure, 0);
  await app.close();
});

test('GET /v1/claims/:id: 404 cross-firm', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/claims/${CLAIM_PRESEED_B}`,
    cookies: { cpa_session: await adminJwt() }, // session in firm A
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

// =============================================================================
// PATCH /v1/claims/:id/stage
// =============================================================================

test('PATCH /v1/claims/:id/stage: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/claims/${CLAIM_PRESEED_A_ENGAGEMENT}/stage`,
    payload: { to_stage: 'activity_capture' },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('PATCH /v1/claims/:id/stage: 200 forward by consultant + CLAIM_STAGE_ADVANCED event', async () => {
  // Seed a fresh claim row so this test owns its event-chain mutation.
  const CLAIM_FOR_FORWARD = '00000000-0000-4000-8000-0000000a2041';
  await privilegedSql`
    INSERT INTO claim (id, tenant_id, subject_tenant_id, fiscal_year, stage)
    VALUES (${CLAIM_FOR_FORWARD}, ${TENANT_A}, ${SUBJECT_A1}, 2027, 'engagement')
  `;
  try {
    const app = buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/claims/${CLAIM_FOR_FORWARD}/stage`,
      cookies: { cpa_session: await consultantJwt() },
      payload: { to_stage: 'activity_capture' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{ claim: { stage: string } }>();
    assert.equal(body.claim.stage, 'activity_capture');

    // Verify a CLAIM_STAGE_ADVANCED event landed and carries the from/to pair.
    const eventRows = await privilegedSql<
      { payload: { from_stage: string; to_stage: string; claim_id: string } }[]
    >`
      SELECT payload FROM event
       WHERE subject_tenant_id = ${SUBJECT_A1}
         AND kind = 'CLAIM_STAGE_ADVANCED'
         AND payload ->> 'claim_id' = ${CLAIM_FOR_FORWARD}
    `;
    assert.equal(eventRows.length, 1);
    assert.equal(eventRows[0]!.payload.from_stage, 'engagement');
    assert.equal(eventRows[0]!.payload.to_stage, 'activity_capture');

    await app.close();
  } finally {
    await privilegedSql`DELETE FROM event WHERE payload ->> 'claim_id' = ${CLAIM_FOR_FORWARD}`;
    await privilegedSql`DELETE FROM claim WHERE id = ${CLAIM_FOR_FORWARD}`;
  }
});

test('PATCH /v1/claims/:id/stage: 200 backward by admin + CLAIM_STAGE_ADVANCED event', async () => {
  // Seed a claim at 'review' so admin can revert it backward to
  // 'activity_capture'. Consultants cannot do this (next test).
  const CLAIM_FOR_BACKWARD = '00000000-0000-4000-8000-0000000a2042';
  await privilegedSql`
    INSERT INTO claim (id, tenant_id, subject_tenant_id, fiscal_year, stage)
    VALUES (${CLAIM_FOR_BACKWARD}, ${TENANT_A}, ${SUBJECT_A1}, 2028, 'review')
  `;
  try {
    const app = buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/claims/${CLAIM_FOR_BACKWARD}/stage`,
      cookies: { cpa_session: await adminJwt() },
      payload: { to_stage: 'activity_capture' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{ claim: { stage: string } }>();
    assert.equal(body.claim.stage, 'activity_capture');

    const eventRows = await privilegedSql<{ payload: { from_stage: string; to_stage: string } }[]>`
      SELECT payload FROM event
       WHERE kind = 'CLAIM_STAGE_ADVANCED'
         AND payload ->> 'claim_id' = ${CLAIM_FOR_BACKWARD}
    `;
    assert.equal(eventRows.length, 1);
    assert.equal(eventRows[0]!.payload.from_stage, 'review');
    assert.equal(eventRows[0]!.payload.to_stage, 'activity_capture');

    await app.close();
  } finally {
    await privilegedSql`DELETE FROM event WHERE payload ->> 'claim_id' = ${CLAIM_FOR_BACKWARD}`;
    await privilegedSql`DELETE FROM claim WHERE id = ${CLAIM_FOR_BACKWARD}`;
  }
});

test('PATCH /v1/claims/:id/stage: 403 backward by consultant', async () => {
  // Consultants cannot revert backward (only admins can). The route
  // surfaces validateStageTransition's `role_required` reason as 403.
  const CLAIM_FOR_CONS_BACK = '00000000-0000-4000-8000-0000000a2043';
  await privilegedSql`
    INSERT INTO claim (id, tenant_id, subject_tenant_id, fiscal_year, stage)
    VALUES (${CLAIM_FOR_CONS_BACK}, ${TENANT_A}, ${SUBJECT_A1}, 2029, 'review')
  `;
  try {
    const app = buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/claims/${CLAIM_FOR_CONS_BACK}/stage`,
      cookies: { cpa_session: await consultantJwt() },
      payload: { to_stage: 'activity_capture' },
    });
    assert.equal(res.statusCode, 403);
    const body = res.json<{ error: string }>();
    assert.equal(body.error, 'forbidden');
    await app.close();
  } finally {
    await privilegedSql`DELETE FROM event WHERE payload ->> 'claim_id' = ${CLAIM_FOR_CONS_BACK}`;
    await privilegedSql`DELETE FROM claim WHERE id = ${CLAIM_FOR_CONS_BACK}`;
  }
});

test('PATCH /v1/claims/:id/stage: 200 no-op when from === to (idempotent, no event)', async () => {
  // Defensive: clear any stray events from previous tests so the
  // "no event written" assertion below is unambiguous.
  await privilegedSql`
    DELETE FROM event
    WHERE payload->>'claim_id' = ${CLAIM_PRESEED_A_ENGAGEMENT}
  `;

  // Seeded preseed-engagement row sits at 'engagement'. Asking it to
  // advance to 'engagement' is a no-op — the route returns 200 with the
  // current row and emits no event (avoids ledger pollution on retries).
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/claims/${CLAIM_PRESEED_A_ENGAGEMENT}/stage`,
    cookies: { cpa_session: await consultantJwt() },
    payload: { to_stage: 'engagement' },
  });
  assert.equal(res.statusCode, 200);

  // No CLAIM_STAGE_ADVANCED event for this claim.
  const eventRows = await privilegedSql<{ id: string }[]>`
    SELECT id FROM event
     WHERE kind = 'CLAIM_STAGE_ADVANCED'
       AND payload ->> 'claim_id' = ${CLAIM_PRESEED_A_ENGAGEMENT}
  `;
  assert.equal(eventRows.length, 0);
  await app.close();
});

test('PATCH /v1/claims/:id/stage: 409 cannot revert from submitted (admin)', async () => {
  // The preseed-submitted row sits at 'submitted'. Even an admin cannot
  // revert it — submitted is terminal (corrections happen via audit_defence).
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/claims/${CLAIM_PRESEED_A_SUBMITTED}/stage`,
    cookies: { cpa_session: await adminJwt() },
    payload: { to_stage: 'review' },
  });
  assert.equal(res.statusCode, 409);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'cannot_revert_from_submitted');
  await app.close();
});

test('PATCH /v1/claims/:id/stage: 200 submitted advance auto-stamps submitted_at', async () => {
  // Advancing to 'submitted' auto-stamps submitted_at + submitted_by_user_id.
  const CLAIM_FOR_SUBMIT_STAMP = '00000000-0000-4000-8000-0000000a2044';
  await privilegedSql`
    INSERT INTO claim (id, tenant_id, subject_tenant_id, fiscal_year, stage)
    VALUES (${CLAIM_FOR_SUBMIT_STAMP}, ${TENANT_A}, ${SUBJECT_A1}, 2030, 'review')
  `;
  try {
    const app = buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/claims/${CLAIM_FOR_SUBMIT_STAMP}/stage`,
      cookies: { cpa_session: await consultantJwt() },
      payload: { to_stage: 'submitted' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{
      claim: { stage: string; submitted_at: string | null; submitted_by_user_id: string | null };
    }>();
    assert.equal(body.claim.stage, 'submitted');
    assert.ok(body.claim.submitted_at !== null, 'submitted_at should be auto-stamped');
    assert.equal(body.claim.submitted_by_user_id, CONSULTANT_USER);

    await app.close();
  } finally {
    await privilegedSql`DELETE FROM event WHERE payload ->> 'claim_id' = ${CLAIM_FOR_SUBMIT_STAMP}`;
    await privilegedSql`DELETE FROM claim WHERE id = ${CLAIM_FOR_SUBMIT_STAMP}`;
  }
});

test('PATCH /v1/claims/:id/stage: 403 for viewer role', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/claims/${CLAIM_PRESEED_A_ENGAGEMENT}/stage`,
    cookies: { cpa_session: await viewerJwt() },
    payload: { to_stage: 'activity_capture' },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('PATCH /v1/claims/:id/stage: 404 cross-firm', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/claims/${CLAIM_PRESEED_B}/stage`,
    cookies: { cpa_session: await adminJwt() },
    payload: { to_stage: 'activity_capture' },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('PATCH /v1/claims/:id/stage: 400 on invalid body', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/claims/${CLAIM_PRESEED_A_ENGAGEMENT}/stage`,
    cookies: { cpa_session: await consultantJwt() },
    payload: { to_stage: 'not-a-real-stage' },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

// =============================================================================
// PATCH /v1/claims/:id (submission flag)
// =============================================================================

test('PATCH /v1/claims/:id: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/claims/${CLAIM_PRESEED_A_SUBMITTED}`,
    payload: { ausindustry_reference: 'AI-2024-12345' },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('PATCH /v1/claims/:id: 200 sets ausindustry_reference + submitted_at + emits CLAIM_SUBMITTED', async () => {
  // Seed a claim already at 'submitted' (the gate) but with no
  // ausindustry_reference yet. The PATCH supplies both fields, so the
  // route emits CLAIM_SUBMITTED.
  const CLAIM_FOR_SUBMIT_FLAG = '00000000-0000-4000-8000-0000000a2051';
  await privilegedSql`
    INSERT INTO claim (id, tenant_id, subject_tenant_id, fiscal_year, stage)
    VALUES (${CLAIM_FOR_SUBMIT_FLAG}, ${TENANT_A}, ${SUBJECT_A1}, 2031, 'submitted')
  `;
  try {
    const app = buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/claims/${CLAIM_FOR_SUBMIT_FLAG}`,
      cookies: { cpa_session: await consultantJwt() },
      payload: {
        ausindustry_reference: 'AI-2031-99999',
        submitted_at: '2031-04-01T00:00:00Z',
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{
      claim: {
        ausindustry_reference: string | null;
        submitted_at: string | null;
      };
    }>();
    assert.equal(body.claim.ausindustry_reference, 'AI-2031-99999');
    assert.ok(body.claim.submitted_at !== null);

    // Verify CLAIM_SUBMITTED event landed.
    const eventRows = await privilegedSql<{ payload: { ausindustry_reference: string } }[]>`
      SELECT payload FROM event
       WHERE kind = 'CLAIM_SUBMITTED'
         AND payload ->> 'claim_id' = ${CLAIM_FOR_SUBMIT_FLAG}
    `;
    assert.equal(eventRows.length, 1);
    assert.equal(eventRows[0]!.payload.ausindustry_reference, 'AI-2031-99999');

    await app.close();
  } finally {
    await privilegedSql`DELETE FROM event WHERE payload ->> 'claim_id' = ${CLAIM_FOR_SUBMIT_FLAG}`;
    await privilegedSql`DELETE FROM claim WHERE id = ${CLAIM_FOR_SUBMIT_FLAG}`;
  }
});

test('PATCH /v1/claims/:id: 409 ausindustry_reference set when stage !== submitted', async () => {
  // The preseed-engagement row is at 'engagement'. Setting
  // ausindustry_reference should be rejected with 409 invalid_state
  // because the regulator-issued ID is only meaningful post-submission.
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/claims/${CLAIM_PRESEED_A_ENGAGEMENT}`,
    cookies: { cpa_session: await consultantJwt() },
    payload: { ausindustry_reference: 'AI-2024-PREMATURE' },
  });
  assert.equal(res.statusCode, 409);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'invalid_state');
  await app.close();
});

test('PATCH /v1/claims/:id: 200 submitted_at-only patch (no event because no aus ref)', async () => {
  // Seed a claim at 'submitted' with no ausindustry_reference. PATCH only
  // submitted_at. Both ausindustry_reference and submitted_at must be
  // populated for CLAIM_SUBMITTED to emit, so this should be a 200 with
  // no event written.
  const CLAIM_FOR_PARTIAL = '00000000-0000-4000-8000-0000000a2052';
  await privilegedSql`
    INSERT INTO claim (id, tenant_id, subject_tenant_id, fiscal_year, stage)
    VALUES (${CLAIM_FOR_PARTIAL}, ${TENANT_A}, ${SUBJECT_A1}, 2032, 'submitted')
  `;
  try {
    const app = buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/claims/${CLAIM_FOR_PARTIAL}`,
      cookies: { cpa_session: await consultantJwt() },
      payload: { submitted_at: '2032-04-01T00:00:00Z' },
    });
    assert.equal(res.statusCode, 200);

    const eventRows = await privilegedSql<{ id: string }[]>`
      SELECT id FROM event
       WHERE kind = 'CLAIM_SUBMITTED'
         AND payload ->> 'claim_id' = ${CLAIM_FOR_PARTIAL}
    `;
    assert.equal(eventRows.length, 0);
    await app.close();
  } finally {
    await privilegedSql`DELETE FROM event WHERE payload ->> 'claim_id' = ${CLAIM_FOR_PARTIAL}`;
    await privilegedSql`DELETE FROM claim WHERE id = ${CLAIM_FOR_PARTIAL}`;
  }
});

test('PATCH /v1/claims/:id: 400 on extra unknown key', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/claims/${CLAIM_PRESEED_A_SUBMITTED}`,
    cookies: { cpa_session: await consultantJwt() },
    payload: { ausindustry_reference: 'AI-X', not_a_real_column: true },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('PATCH /v1/claims/:id: 403 for viewer role', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/claims/${CLAIM_PRESEED_A_SUBMITTED}`,
    cookies: { cpa_session: await viewerJwt() },
    payload: { ausindustry_reference: 'AI-Y' },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('PATCH /v1/claims/:id: 404 cross-firm', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/claims/${CLAIM_PRESEED_B}`,
    cookies: { cpa_session: await adminJwt() },
    payload: { ausindustry_reference: 'AI-CROSSFIRM' },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});
