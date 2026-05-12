/**
 * Tests for the claim-workflow routes (Tasks 2.2-2.5):
 *   - POST /v1/claims/:id/workflow/initialize
 *   - POST /v1/claims/:id/workflow/step/:n/agree
 *   - POST /v1/claims/:id/workflow/step/:n/reopen
 *   - GET  /v1/claims/:id/workflow
 *
 * Fixture strategy mirrors `narrative.test.ts` / `artefact-links.test.ts`:
 * pin a disjoint UUID prefix (c66xx for the claim-wizard P-batch) and tear
 * down between tests. RLS is exercised by mismatched-tenant requests
 * returning 404, never 403.
 */

import { test, after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { signSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../app.js';

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

// `c66xx` namespace — claim-wizard route batch 2.2-2.5. Disjoint from
// narrative.test.ts (`c55xx`), artefact-links.test.ts (`a4xx`), etc.
const TENANT_A = '00000000-0000-4000-8000-0000000c6601';
const TENANT_B = '00000000-0000-4000-8000-0000000c6602';
const ADMIN_USER = '00000000-0000-4000-8000-0000000c6610';
const VIEWER_USER = '00000000-0000-4000-8000-0000000c6611';
const CONSULTANT_USER = '00000000-0000-4000-8000-0000000c6612';
const TENANT_B_ADMIN = '00000000-0000-4000-8000-0000000c6613';

const SUBJECT_A = '00000000-0000-4000-8000-0000000c6620';
const SUBJECT_B = '00000000-0000-4000-8000-0000000c6621';
const PROJECT_A = '00000000-0000-4000-8000-0000000c6630';
const PROJECT_B = '00000000-0000-4000-8000-0000000c6631';
const CLAIM_A = '00000000-0000-4000-8000-0000000c6640';
const CLAIM_A2 = '00000000-0000-4000-8000-0000000c6641';
const CLAIM_LEGACY = '00000000-0000-4000-8000-0000000c6642';
const CLAIM_B = '00000000-0000-4000-8000-0000000c6643';
const CLAIM_UNKNOWN = '00000000-0000-4000-8000-0000000c66ff';

const cleanup = async (): Promise<void> => {
  await privilegedSql`DELETE FROM event WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM activity WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM claim WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM project WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM subject_tenant WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await sql`DELETE FROM "user" WHERE id IN (${ADMIN_USER}, ${VIEWER_USER}, ${CONSULTANT_USER}, ${TENANT_B_ADMIN})`;
  await sql`DELETE FROM tenant WHERE id IN (${TENANT_A}, ${TENANT_B})`;
};

before(async () => {
  await cleanup();
  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT_A}, 'Firm C66A', 'firm-c66a', 'mixed'),
                   (${TENANT_B}, 'Firm C66B', 'firm-c66b', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${ADMIN_USER}, 'c66-admin@example.com', 'microsoft', 'microsoft:c66-admin', 'C66 Admin'),
                   (${VIEWER_USER}, 'c66-viewer@example.com', 'microsoft', 'microsoft:c66-viewer', 'C66 Viewer'),
                   (${CONSULTANT_USER}, 'c66-cons@example.com', 'microsoft', 'microsoft:c66-cons', 'C66 Consultant'),
                   (${TENANT_B_ADMIN}, 'c66-admin-b@example.com', 'microsoft', 'microsoft:c66-admin-b', 'C66 Admin (Firm B)')`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT_A}, ${ADMIN_USER}, 'admin', true),
                              (gen_random_uuid(), ${TENANT_A}, ${VIEWER_USER}, 'viewer', true),
                              (gen_random_uuid(), ${TENANT_A}, ${CONSULTANT_USER}, 'consultant', true),
                              (gen_random_uuid(), ${TENANT_B}, ${TENANT_B_ADMIN}, 'admin', true)`;
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                       VALUES (${SUBJECT_A}, ${TENANT_A}, 'C66 Subject A', 'claimant'),
                              (${SUBJECT_B}, ${TENANT_B}, 'C66 Subject B', 'claimant')`;
  await privilegedSql`
    INSERT INTO project (id, tenant_id, subject_tenant_id, name, started_at)
    VALUES
      (${PROJECT_A}, ${TENANT_A}, ${SUBJECT_A}, 'C66 Project A',
       '2024-07-01T00:00:00Z'::timestamptz),
      (${PROJECT_B}, ${TENANT_B}, ${SUBJECT_B}, 'C66 Project B',
       '2024-07-01T00:00:00Z'::timestamptz)
  `;
});

beforeEach(async () => {
  // Reset claim rows between tests so each test starts from a known state.
  // We re-insert from scratch to keep the workflow_state nullable assertions
  // crisp (no cross-test pollution).
  await privilegedSql`DELETE FROM event WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM activity WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM claim WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`
    INSERT INTO claim (id, tenant_id, subject_tenant_id, project_id, fiscal_year, stage, workflow_state)
    VALUES
      (${CLAIM_A}, ${TENANT_A}, ${SUBJECT_A}, ${PROJECT_A}, 2025, 'engagement', NULL),
      (${CLAIM_A2}, ${TENANT_A}, ${SUBJECT_A}, ${PROJECT_A}, 2026, 'engagement', NULL),
      (${CLAIM_LEGACY}, ${TENANT_A}, ${SUBJECT_A}, ${PROJECT_A}, 2024, 'engagement', NULL),
      (${CLAIM_B}, ${TENANT_B}, ${SUBJECT_B}, ${PROJECT_B}, 2025, 'engagement', NULL)
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

const adminJwt = (): Promise<string> => jwtFor(ADMIN_USER, 'c66-admin@example.com', 'admin');
const viewerJwt = (): Promise<string> => jwtFor(VIEWER_USER, 'c66-viewer@example.com', 'viewer');
const consultantJwt = (): Promise<string> =>
  jwtFor(CONSULTANT_USER, 'c66-cons@example.com', 'consultant');
const tenantBAdminJwt = (): Promise<string> =>
  jwtFor(TENANT_B_ADMIN, 'c66-admin-b@example.com', 'admin', TENANT_B);

// Helper: directly set a claim's workflow_state via privilegedSql for tests
// that need a pre-initialized claim without going through the route.
const setWorkflowState = async (claimId: string, state: unknown): Promise<void> => {
  await privilegedSql`
    UPDATE claim
       SET workflow_state = ${JSON.stringify(state)}::text::jsonb,
           updated_at     = NOW()
     WHERE id = ${claimId}
  `;
};

// Helper: seed a single EXPERIMENT event so canAdvance(1, ...) returns ok=true.
// Mirrors the minimum classified-event input the wizard's step-1 gate counts.
const seedClassifiedEvent = async (args: {
  tenantId: string;
  subjectTenantId: string;
  projectId: string;
}): Promise<void> => {
  await privilegedSql`
    INSERT INTO event (
      id, tenant_id, subject_tenant_id, project_id, kind, payload,
      prev_hash, hash, captured_at, captured_by_user_id
    ) VALUES (
      gen_random_uuid(), ${args.tenantId}, ${args.subjectTenantId}, ${args.projectId},
      'EXPERIMENT', '{"text":"c66 seed evidence"}'::jsonb,
      NULL, ${'c66'.padEnd(64, 'a')},
      '2025-01-01T00:00:00Z'::timestamptz, ${CONSULTANT_USER}
    )
  `;
};

// =============================================================================
// POST /v1/claims/:id/workflow/initialize
// =============================================================================

test('POST /workflow/initialize: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_A}/workflow/initialize`,
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /workflow/initialize: 403 for viewer role', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_A}/workflow/initialize`,
    cookies: { cpa_session: await viewerJwt() },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('POST /workflow/initialize: 400 on non-UUID claim id', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/not-a-uuid/workflow/initialize`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /workflow/initialize: 200 on fresh claim sets initialized_at + null steps', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_A}/workflow/initialize`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    workflow_state: {
      initialized_at: string;
      steps: Record<'1' | '2' | '3' | '4' | '5', unknown>;
    };
  }>();
  assert.match(body.workflow_state.initialized_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(body.workflow_state.steps['1'], null);
  assert.equal(body.workflow_state.steps['2'], null);
  assert.equal(body.workflow_state.steps['3'], null);
  assert.equal(body.workflow_state.steps['4'], null);
  assert.equal(body.workflow_state.steps['5'], null);
  await app.close();
});

test('POST /workflow/initialize: 409 on second call (already initialized)', async () => {
  const app = buildApp();
  const first = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_A}/workflow/initialize`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(first.statusCode, 200);

  const second = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_A}/workflow/initialize`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(second.statusCode, 409);
  await app.close();
});

test('POST /workflow/initialize: 409 for cross-firm claim (RLS conceals it)', async () => {
  // Admin of Tenant B can't initialize a Tenant A claim.
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_A}/workflow/initialize`,
    cookies: { cpa_session: await tenantBAdminJwt() },
  });
  // The route conflates "not found" with "already initialized" into a
  // single 409 — see the route's handler comment. RLS hides the row.
  assert.equal(res.statusCode, 409);
  await app.close();
});

test('POST /workflow/initialize: 409 on unknown claim id', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_UNKNOWN}/workflow/initialize`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(res.statusCode, 409);
  await app.close();
});

// =============================================================================
// POST /v1/claims/:id/workflow/step/:n/agree
// =============================================================================

test('POST /workflow/step/:n/agree: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_A}/workflow/step/1/agree`,
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /workflow/step/:n/agree: 403 for viewer role', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_A}/workflow/step/1/agree`,
    cookies: { cpa_session: await viewerJwt() },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('POST /workflow/step/:n/agree: 400 on invalid step (6)', async () => {
  await setWorkflowState(CLAIM_A, {
    initialized_at: '2025-01-01T00:00:00.000Z',
    steps: { '1': null, '2': null, '3': null, '4': null, '5': null },
  });
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_A}/workflow/step/6/agree`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /workflow/step/:n/agree: 400 on non-numeric step', async () => {
  await setWorkflowState(CLAIM_A, {
    initialized_at: '2025-01-01T00:00:00.000Z',
    steps: { '1': null, '2': null, '3': null, '4': null, '5': null },
  });
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_A}/workflow/step/abc/agree`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /workflow/step/:n/agree: 404 on unknown claim', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_UNKNOWN}/workflow/step/1/agree`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('POST /workflow/step/:n/agree: 400 on legacy (not-wizard) claim', async () => {
  // CLAIM_LEGACY has workflow_state = NULL; route must reject as not_a_wizard_claim.
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_LEGACY}/workflow/step/1/agree`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(res.statusCode, 400);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'not_a_wizard_claim');
  await app.close();
});

test('POST /workflow/step/:n/agree: 409 when canAdvance returns ok=false (step 1, no events)', async () => {
  await setWorkflowState(CLAIM_A, {
    initialized_at: '2025-01-01T00:00:00.000Z',
    steps: { '1': null, '2': null, '3': null, '4': null, '5': null },
  });
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_A}/workflow/step/1/agree`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(res.statusCode, 409);
  const body = res.json<{ error: string; message: string }>();
  assert.equal(body.error, 'cannot_advance');
  assert.ok(body.message.length > 0);
  await app.close();
});

test('POST /workflow/step/:n/agree: 200 when canAdvance ok (step 1 with classified event)', async () => {
  await setWorkflowState(CLAIM_A, {
    initialized_at: '2025-01-01T00:00:00.000Z',
    steps: { '1': null, '2': null, '3': null, '4': null, '5': null },
  });
  await seedClassifiedEvent({
    tenantId: TENANT_A,
    subjectTenantId: SUBJECT_A,
    projectId: PROJECT_A,
  });
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_A}/workflow/step/1/agree`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    workflow_state: {
      steps: { '1': { agreed_at: string; agreed_by: string } | null };
    };
  }>();
  assert.ok(body.workflow_state.steps['1']);
  assert.equal(body.workflow_state.steps['1'].agreed_by, CONSULTANT_USER);
  assert.match(body.workflow_state.steps['1'].agreed_at, /^\d{4}-\d{2}-\d{2}T/);
  await app.close();
});

// =============================================================================
// POST /v1/claims/:id/workflow/step/:n/reopen
// =============================================================================

test('POST /workflow/step/:n/reopen: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_A}/workflow/step/2/reopen`,
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /workflow/step/:n/reopen: 403 for viewer role', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_A}/workflow/step/2/reopen`,
    cookies: { cpa_session: await viewerJwt() },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('POST /workflow/step/:n/reopen: 200 clears agreed_at on the named step', async () => {
  const stateWithStep2Agreed = {
    initialized_at: '2025-01-01T00:00:00.000Z',
    steps: {
      '1': { agreed_at: '2025-01-02T00:00:00.000Z', agreed_by: CONSULTANT_USER },
      '2': { agreed_at: '2025-01-03T00:00:00.000Z', agreed_by: CONSULTANT_USER },
      '3': { agreed_at: '2025-01-04T00:00:00.000Z', agreed_by: CONSULTANT_USER },
      '4': null,
      '5': null,
    },
  };
  await setWorkflowState(CLAIM_A, stateWithStep2Agreed);

  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_A}/workflow/step/2/reopen`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    workflow_state: {
      steps: Record<'1' | '2' | '3' | '4' | '5', unknown>;
    };
  }>();
  assert.equal(body.workflow_state.steps['2'], null);
  // No cascade per Q5.b — downstream step 3 keeps its timestamp.
  assert.ok(body.workflow_state.steps['3']);
  // Upstream step 1 also preserved.
  assert.ok(body.workflow_state.steps['1']);
  await app.close();
});

test('POST /workflow/step/:n/reopen: 200 idempotent on already-null step', async () => {
  await setWorkflowState(CLAIM_A, {
    initialized_at: '2025-01-01T00:00:00.000Z',
    steps: { '1': null, '2': null, '3': null, '4': null, '5': null },
  });
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_A}/workflow/step/2/reopen`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ workflow_state: { steps: Record<string, unknown> } }>();
  assert.equal(body.workflow_state.steps['2'], null);
  await app.close();
});

test('POST /workflow/step/:n/reopen: 400 on invalid step', async () => {
  await setWorkflowState(CLAIM_A, {
    initialized_at: '2025-01-01T00:00:00.000Z',
    steps: { '1': null, '2': null, '3': null, '4': null, '5': null },
  });
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_A}/workflow/step/7/reopen`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /workflow/step/:n/reopen: 404 on unknown claim', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_UNKNOWN}/workflow/step/2/reopen`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

// =============================================================================
// GET /v1/claims/:id/workflow
// =============================================================================

test('GET /workflow: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/claims/${CLAIM_A}/workflow`,
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('GET /workflow: 200 returns state + derived canAdvance for all 5 steps', async () => {
  await setWorkflowState(CLAIM_A, {
    initialized_at: '2025-01-01T00:00:00.000Z',
    steps: { '1': null, '2': null, '3': null, '4': null, '5': null },
  });
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/claims/${CLAIM_A}/workflow`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    workflow_state: { initialized_at: string };
    derived: {
      canAdvance: Record<'1' | '2' | '3' | '4' | '5', { ok: true } | { ok: false; reason: string }>;
    };
  }>();
  assert.equal(body.workflow_state.initialized_at, '2025-01-01T00:00:00.000Z');
  // No classified events → step 1 cannot advance.
  assert.equal(body.derived.canAdvance['1'].ok, false);
  // Step 5 is always terminal.
  assert.equal(body.derived.canAdvance['5'].ok, false);
  // Each entry is { ok: true } | { ok: false, reason }.
  for (const n of ['1', '2', '3', '4', '5'] as const) {
    const entry = body.derived.canAdvance[n];
    assert.ok(entry.ok === true || (entry.ok === false && typeof entry.reason === 'string'));
  }
  await app.close();
});

test('GET /workflow: 400 if claim has NULL workflow_state (legacy)', async () => {
  // CLAIM_LEGACY has workflow_state = NULL.
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/claims/${CLAIM_LEGACY}/workflow`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(res.statusCode, 400);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'not_a_wizard_claim');
  await app.close();
});

test('GET /workflow: 404 on unknown claim', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/claims/${CLAIM_UNKNOWN}/workflow`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('GET /workflow: admin role also works (not just consultant)', async () => {
  await setWorkflowState(CLAIM_A, {
    initialized_at: '2025-01-01T00:00:00.000Z',
    steps: { '1': null, '2': null, '3': null, '4': null, '5': null },
  });
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/claims/${CLAIM_A}/workflow`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  await app.close();
});
