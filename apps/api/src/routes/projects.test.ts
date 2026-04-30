import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { signSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../app.js';

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

// Per-test UUID prefixes — `0000a1XXXX` is the T-A1 namespace (P4 Swimlane A,
// Task 1). Subsequent A-tasks should pick disjoint suffixes so parallel test
// runs don't collide on the shared `audit_score_snapshot` cleanup path.
const TENANT_A = '00000000-0000-4000-8000-0000000a1001';
const TENANT_B = '00000000-0000-4000-8000-0000000a1002';
const ADMIN_USER = '00000000-0000-4000-8000-0000000a1010';
const VIEWER_USER = '00000000-0000-4000-8000-0000000a1011';
const CONSULTANT_USER = '00000000-0000-4000-8000-0000000a1012';
// Tenant-B admin — disjoint suffix so the cross-firm RLS positive-control
// test (added in the A1 follow-up commit) gets a real session bound to
// firm B without colliding with firm-A's user fixtures.
const TENANT_B_ADMIN = '00000000-0000-4000-8000-0000000a1013';
const SUBJECT_A1 = '00000000-0000-4000-8000-0000000a1021';
const SUBJECT_B1 = '00000000-0000-4000-8000-0000000a1023';

// Pre-seeded project rows used by the GET / PATCH / DELETE tests.
const PROJECT_PRESEED_A = '00000000-0000-4000-8000-0000000a1031';
const PROJECT_PRESEED_B = '00000000-0000-4000-8000-0000000a1032';
const PROJECT_PRESEED_ARCHIVED = '00000000-0000-4000-8000-0000000a1033';

const TENANT_IDS = [TENANT_A, TENANT_B] as const;

/**
 * FK-safe cleanup. Defensively clears `audit_score_snapshot` first because
 * that table FK-references `subject_tenant`, and a concurrent test run
 * leaving stale snapshot rows behind would block the subject_tenant
 * delete with a 23503. Same race we just hit in audit-score.test.ts.
 *
 * `event` rows are deleted last — they hold tenant_id + subject_tenant_id
 * FKs but no others reference them, so they come off cleanly. We use
 * privilegedSql throughout (RLS bypass) since cleanup is an out-of-band
 * audit operation.
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
            VALUES (${TENANT_A}, 'Firm A', 'firm-a-a1', 'mixed'),
                   (${TENANT_B}, 'Firm B', 'firm-b-a1', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${ADMIN_USER}, 'a1-admin@example.com', 'microsoft', 'microsoft:a1-admin', 'A1 Admin'),
                   (${VIEWER_USER}, 'a1-viewer@example.com', 'microsoft', 'microsoft:a1-viewer', 'A1 Viewer'),
                   (${CONSULTANT_USER}, 'a1-cons@example.com', 'microsoft', 'microsoft:a1-cons', 'A1 Consultant'),
                   (${TENANT_B_ADMIN}, 'a1-admin-b@example.com', 'microsoft', 'microsoft:a1-admin-b', 'A1 Admin (Firm B)')`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT_A}, ${ADMIN_USER}, 'admin', true),
                              (gen_random_uuid(), ${TENANT_A}, ${VIEWER_USER}, 'viewer', true),
                              (gen_random_uuid(), ${TENANT_A}, ${CONSULTANT_USER}, 'consultant', true),
                              (gen_random_uuid(), ${TENANT_B}, ${TENANT_B_ADMIN}, 'admin', true)`;
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                       VALUES (${SUBJECT_A1}, ${TENANT_A}, 'Acme Co', 'claimant'),
                              (${SUBJECT_B1}, ${TENANT_B}, 'Other Corp', 'claimant')`;
  // Pre-seed an active project under firm A and a cross-firm project
  // under firm B for the cross-firm 404 + RLS list-isolation tests.
  await privilegedSql`
    INSERT INTO project (id, tenant_id, subject_tenant_id, name, description, started_at)
    VALUES
      (${PROJECT_PRESEED_A}, ${TENANT_A}, ${SUBJECT_A1}, 'Preseed A', 'firm-A active',
       '2026-01-01T00:00:00Z'::timestamptz),
      (${PROJECT_PRESEED_B}, ${TENANT_B}, ${SUBJECT_B1}, 'Preseed B', 'firm-B cross',
       '2026-01-01T00:00:00Z'::timestamptz),
      (${PROJECT_PRESEED_ARCHIVED}, ${TENANT_A}, ${SUBJECT_A1}, 'Preseed Archived',
       'archived row', '2025-01-01T00:00:00Z'::timestamptz)
  `;
  await privilegedSql`UPDATE project SET archived_at = NOW() WHERE id = ${PROJECT_PRESEED_ARCHIVED}`;
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

const adminJwt = (): Promise<string> => jwtFor(ADMIN_USER, 'a1-admin@example.com', 'admin');
const viewerJwt = (): Promise<string> => jwtFor(VIEWER_USER, 'a1-viewer@example.com', 'viewer');
const consultantJwt = (): Promise<string> =>
  jwtFor(CONSULTANT_USER, 'a1-cons@example.com', 'consultant');
// Firm-B admin session — enables the cross-firm RLS positive-control test
// (firm-B session DOES see firm-B's project), distinguishing real isolation
// from "RLS silently returns nothing for everyone".
const tenantBAdminJwt = (): Promise<string> =>
  jwtFor(TENANT_B_ADMIN, 'a1-admin-b@example.com', 'admin', TENANT_B);

// Sanity: keep the TENANT_IDS aggregate alive for any future bulk-cleanup
// extension. Currently each statement spells out (TENANT_A, TENANT_B) inline
// since postgres-js's IN ($1, $2) doesn't accept array spreads cleanly.
void TENANT_IDS;

// =============================================================================
// POST /v1/projects
// =============================================================================

test('POST /v1/projects: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/projects',
    payload: {
      subject_tenant_id: SUBJECT_A1,
      name: 'New Project',
      started_at: '2026-04-01T00:00:00Z',
    },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /v1/projects: 201 + DB row + PROJECT_CREATED event written', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/projects',
    cookies: { cpa_session: await consultantJwt() },
    payload: {
      subject_tenant_id: SUBJECT_A1,
      name: 'ML Pipeline Rebuild',
      description: 'Rewrite the ingestion pipeline in Rust',
      started_at: '2026-04-01T00:00:00Z',
    },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json<{
    project: {
      id: string;
      name: string;
      description: string | null;
      tenant_id: string;
      started_at: string;
    };
  }>();
  assert.equal(body.project.name, 'ML Pipeline Rebuild');
  assert.equal(body.project.tenant_id, TENANT_A);
  assert.equal(body.project.description, 'Rewrite the ingestion pipeline in Rust');

  // Verify the project row exists in the DB.
  const projectRows = await privilegedSql<{ id: string; name: string }[]>`
    SELECT id, name FROM project WHERE id = ${body.project.id}
  `;
  assert.equal(projectRows.length, 1);
  assert.equal(projectRows[0]?.name, 'ML Pipeline Rebuild');

  // Verify a PROJECT_CREATED event landed on the chain.
  const eventRows = await privilegedSql<{ id: string; kind: string; payload: unknown }[]>`
    SELECT id, kind, payload FROM event
     WHERE subject_tenant_id = ${SUBJECT_A1}
       AND kind = 'PROJECT_CREATED'
       AND payload ->> 'project_id' = ${body.project.id}
  `;
  assert.equal(eventRows.length, 1);

  await app.close();
});

test('POST /v1/projects: 400 on invalid body (missing started_at)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/projects',
    cookies: { cpa_session: await consultantJwt() },
    payload: {
      subject_tenant_id: SUBJECT_A1,
      name: 'Missing Started',
    },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /v1/projects: 400 on invalid started_at (naive datetime)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/projects',
    cookies: { cpa_session: await consultantJwt() },
    payload: {
      subject_tenant_id: SUBJECT_A1,
      name: 'Naive',
      started_at: '2026-04-01 00:00:00',
    },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /v1/projects: 403 for viewer role', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/projects',
    cookies: { cpa_session: await viewerJwt() },
    payload: {
      subject_tenant_id: SUBJECT_A1,
      name: 'Should Fail',
      started_at: '2026-04-01T00:00:00Z',
    },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('POST /v1/projects: 404 cross-firm subject_tenant', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/projects',
    cookies: { cpa_session: await adminJwt() },
    payload: {
      subject_tenant_id: SUBJECT_B1,
      name: 'Cross Firm',
      started_at: '2026-04-01T00:00:00Z',
    },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('POST /v1/projects: 400 when ended_at is before started_at (Fix #2 client-side)', async () => {
  // Schema-level guard: CreateProjectBody.refine() rejects an inverted
  // date range before the route handler runs.
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/projects',
    cookies: { cpa_session: await consultantJwt() },
    payload: {
      subject_tenant_id: SUBJECT_A1,
      name: 'Inverted Range',
      started_at: '2026-01-01T00:00:00Z',
      ended_at: '2025-12-31T00:00:00Z',
    },
  });
  assert.equal(res.statusCode, 400);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'invalid_body');
  await app.close();
});

// =============================================================================
// GET /v1/projects
// =============================================================================

test('GET /v1/projects: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/v1/projects' });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('GET /v1/projects: returns active firm-A rows only (RLS filters firm-B)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/projects',
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    projects: Array<{ id: string; tenant_id: string; archived_at: string | null }>;
  }>();
  assert.ok(body.projects.length >= 1);
  // RLS isolates firm-B; archived_at IS NULL filters preseed-archived.
  assert.ok(body.projects.every((p) => p.tenant_id === TENANT_A));
  assert.ok(!body.projects.some((p) => p.id === PROJECT_PRESEED_B));
  assert.ok(!body.projects.some((p) => p.id === PROJECT_PRESEED_ARCHIVED));
  await app.close();
});

test('GET /v1/projects: positive-control — firm-B session DOES see firm-B project (Fix #4)', async () => {
  // Counterpart to the firm-A isolation test above. Without this, a bug
  // where RLS silently returns nothing-for-everyone would still pass the
  // "firm-A doesn't see firm-B" check. Here we confirm the firm-B session
  // returns its own row (and only its own row).
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/projects?subject_tenant_id=${SUBJECT_B1}`,
    cookies: { cpa_session: await tenantBAdminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ projects: Array<{ id: string; tenant_id: string }> }>();
  assert.ok(body.projects.some((p) => p.id === PROJECT_PRESEED_B));
  assert.ok(body.projects.every((p) => p.tenant_id === TENANT_B));
  // Belt + braces: firm-B session must NOT see firm-A's preseed.
  assert.ok(!body.projects.some((p) => p.id === PROJECT_PRESEED_A));
  await app.close();
});

test('GET /v1/projects?subject_tenant_id=...: filters to that claimant', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/projects?subject_tenant_id=${SUBJECT_A1}`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ projects: Array<{ subject_tenant_id: string }> }>();
  assert.ok(body.projects.length >= 1);
  assert.ok(body.projects.every((p) => p.subject_tenant_id === SUBJECT_A1));
  await app.close();
});

test('GET /v1/projects: 400 on invalid query (non-uuid subject_tenant_id)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/projects?subject_tenant_id=not-a-uuid',
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

// =============================================================================
// GET /v1/projects?status= filter — Task 4.1.
//
// status=active (default) returns only rows with archived_at IS NULL,
// status=archived returns only rows with archived_at IS NOT NULL, and
// status=all returns both. Default of 'active' preserves backwards
// compatibility — callers that already issue GET /v1/projects expect
// the active-only list and don't pass the param.
// =============================================================================

test('GET /v1/projects?status=active: returns only non-archived rows (default)', async () => {
  // PROJECT_PRESEED_A is active, PROJECT_PRESEED_ARCHIVED is archived.
  // Without ?status= we get the same shape as the explicit ?status=active.
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/projects?status=active',
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ projects: Array<{ id: string; archived_at: string | null }> }>();
  assert.ok(body.projects.some((p) => p.id === PROJECT_PRESEED_A));
  assert.ok(!body.projects.some((p) => p.id === PROJECT_PRESEED_ARCHIVED));
  // Spot-check: every row in this view must have archived_at IS NULL.
  assert.ok(body.projects.every((p) => p.archived_at === null));
  await app.close();
});

test('GET /v1/projects?status=archived: returns only archived rows', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/projects?status=archived',
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ projects: Array<{ id: string; archived_at: string | null }> }>();
  assert.ok(body.projects.some((p) => p.id === PROJECT_PRESEED_ARCHIVED));
  assert.ok(!body.projects.some((p) => p.id === PROJECT_PRESEED_A));
  // Every row must carry a non-null archived_at.
  assert.ok(body.projects.every((p) => p.archived_at !== null));
  await app.close();
});

test('GET /v1/projects?status=all: returns both archived and active rows', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/projects?status=all',
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ projects: Array<{ id: string; archived_at: string | null }> }>();
  // Both fixtures must appear.
  assert.ok(body.projects.some((p) => p.id === PROJECT_PRESEED_A));
  assert.ok(body.projects.some((p) => p.id === PROJECT_PRESEED_ARCHIVED));
  await app.close();
});

test('GET /v1/projects/:id: detail returns the project', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/projects/${PROJECT_PRESEED_A}`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ project: { id: string; name: string } }>();
  assert.equal(body.project.id, PROJECT_PRESEED_A);
  assert.equal(body.project.name, 'Preseed A');
  await app.close();
});

test('GET /v1/projects/:id: 404 cross-firm', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/projects/${PROJECT_PRESEED_B}`,
    cookies: { cpa_session: await adminJwt() }, // session in firm A
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

// =============================================================================
// PATCH /v1/projects/:id
// =============================================================================

test('PATCH /v1/projects/:id: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/projects/${PROJECT_PRESEED_A}`,
    payload: { name: 'Renamed' },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('PATCH /v1/projects/:id: 200 + PROJECT_UPDATED event with fields_changed', async () => {
  // Seed a fresh project row so this test owns its event-chain mutation.
  const PROJECT_FOR_PATCH = '00000000-0000-4000-8000-0000000a1041';
  await privilegedSql`
    INSERT INTO project (id, tenant_id, subject_tenant_id, name, started_at)
    VALUES (${PROJECT_FOR_PATCH}, ${TENANT_A}, ${SUBJECT_A1}, 'Old Name',
            '2026-01-15T00:00:00Z'::timestamptz)
  `;
  try {
    const app = buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${PROJECT_FOR_PATCH}`,
      cookies: { cpa_session: await consultantJwt() },
      payload: { name: 'New Name', description: 'Now with description' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{ project: { id: string; name: string; description: string | null } }>();
    assert.equal(body.project.name, 'New Name');
    assert.equal(body.project.description, 'Now with description');

    // Verify a PROJECT_UPDATED event landed and carries the field diff.
    const eventRows = await privilegedSql<
      { payload: { fields_changed: Record<string, unknown> } }[]
    >`
      SELECT payload FROM event
       WHERE subject_tenant_id = ${SUBJECT_A1}
         AND kind = 'PROJECT_UPDATED'
         AND payload ->> 'project_id' = ${PROJECT_FOR_PATCH}
    `;
    assert.equal(eventRows.length, 1);
    const fieldsChanged = eventRows[0]!.payload.fields_changed;
    assert.ok('name' in fieldsChanged);
    assert.ok('description' in fieldsChanged);

    await app.close();
  } finally {
    await privilegedSql`DELETE FROM event WHERE payload ->> 'project_id' = ${PROJECT_FOR_PATCH}`;
    await privilegedSql`DELETE FROM project WHERE id = ${PROJECT_FOR_PATCH}`;
  }
});

test('PATCH /v1/projects/:id: 400 on extra unknown key', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/projects/${PROJECT_PRESEED_A}`,
    cookies: { cpa_session: await consultantJwt() },
    payload: { name: 'Renamed', not_a_real_column: true },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('PATCH /v1/projects/:id: 403 for viewer role', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/projects/${PROJECT_PRESEED_A}`,
    cookies: { cpa_session: await viewerJwt() },
    payload: { name: 'Renamed' },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('PATCH /v1/projects/:id: 404 cross-firm', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/projects/${PROJECT_PRESEED_B}`,
    cookies: { cpa_session: await adminJwt() },
    payload: { name: 'Renamed' },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('PATCH /v1/projects/:id: 400 when ended_at < existing started_at (Fix #2 server-side)', async () => {
  // Server-side cross-field guard. The PATCH supplies only ended_at, so
  // the schema's self-refine cannot catch this — the route handler must
  // combine the patch value with the existing row.
  const PROJECT_FOR_RANGE_1 = '00000000-0000-4000-8000-0000000a1061';
  await privilegedSql`
    INSERT INTO project (id, tenant_id, subject_tenant_id, name, started_at, ended_at)
    VALUES (${PROJECT_FOR_RANGE_1}, ${TENANT_A}, ${SUBJECT_A1}, 'Range Test 1',
            '2024-01-01T00:00:00Z'::timestamptz, NULL)
  `;
  try {
    const app = buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${PROJECT_FOR_RANGE_1}`,
      cookies: { cpa_session: await consultantJwt() },
      payload: { ended_at: '2023-01-01T00:00:00Z' },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json<{ error: string }>();
    assert.equal(body.error, 'invalid_range');
    await app.close();
  } finally {
    await privilegedSql`DELETE FROM project WHERE id = ${PROJECT_FOR_RANGE_1}`;
  }
});

test('PATCH /v1/projects/:id: 400 when started_at > existing ended_at (Fix #2 server-side)', async () => {
  // Mirror of the previous test, this time the patch supplies only
  // started_at and we check it against the existing ended_at.
  const PROJECT_FOR_RANGE_2 = '00000000-0000-4000-8000-0000000a1062';
  await privilegedSql`
    INSERT INTO project (id, tenant_id, subject_tenant_id, name, started_at, ended_at)
    VALUES (${PROJECT_FOR_RANGE_2}, ${TENANT_A}, ${SUBJECT_A1}, 'Range Test 2',
            '2024-01-01T00:00:00Z'::timestamptz, '2024-12-31T00:00:00Z'::timestamptz)
  `;
  try {
    const app = buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${PROJECT_FOR_RANGE_2}`,
      cookies: { cpa_session: await consultantJwt() },
      payload: { started_at: '2025-01-01T00:00:00Z' },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json<{ error: string }>();
    assert.equal(body.error, 'invalid_range');
    await app.close();
  } finally {
    await privilegedSql`DELETE FROM project WHERE id = ${PROJECT_FOR_RANGE_2}`;
  }
});

// =============================================================================
// DELETE /v1/projects/:id (soft delete)
// =============================================================================

test('DELETE /v1/projects/:id: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'DELETE',
    url: `/v1/projects/${PROJECT_PRESEED_A}`,
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('DELETE /v1/projects/:id: 200 sets archived_at + writes PROJECT_ARCHIVED', async () => {
  // Seed a fresh project so this test owns its event-chain mutation.
  const PROJECT_FOR_DELETE = '00000000-0000-4000-8000-0000000a1051';
  await privilegedSql`
    INSERT INTO project (id, tenant_id, subject_tenant_id, name, started_at)
    VALUES (${PROJECT_FOR_DELETE}, ${TENANT_A}, ${SUBJECT_A1}, 'To Archive',
            '2026-01-15T00:00:00Z'::timestamptz)
  `;
  try {
    const app = buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/projects/${PROJECT_FOR_DELETE}`,
      cookies: { cpa_session: await consultantJwt() },
      payload: { reason: 'merged into Project X' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{ project: { id: string; archived_at: string | null } }>();
    assert.equal(body.project.id, PROJECT_FOR_DELETE);
    assert.ok(body.project.archived_at !== null, 'archived_at should be set');

    // Verify the row's archived_at is now non-null.
    const rows = await privilegedSql<{ archived_at: Date | null }[]>`
      SELECT archived_at FROM project WHERE id = ${PROJECT_FOR_DELETE}
    `;
    assert.ok(rows[0]?.archived_at !== null);

    // Verify a PROJECT_ARCHIVED event landed with the reason captured.
    const eventRows = await privilegedSql<{ payload: { reason?: string } }[]>`
      SELECT payload FROM event
       WHERE subject_tenant_id = ${SUBJECT_A1}
         AND kind = 'PROJECT_ARCHIVED'
         AND payload ->> 'project_id' = ${PROJECT_FOR_DELETE}
    `;
    assert.equal(eventRows.length, 1);
    assert.equal(eventRows[0]?.payload.reason, 'merged into Project X');

    await app.close();
  } finally {
    await privilegedSql`DELETE FROM event WHERE payload ->> 'project_id' = ${PROJECT_FOR_DELETE}`;
    await privilegedSql`DELETE FROM project WHERE id = ${PROJECT_FOR_DELETE}`;
  }
});

test('DELETE /v1/projects/:id: 403 for viewer role', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'DELETE',
    url: `/v1/projects/${PROJECT_PRESEED_A}`,
    cookies: { cpa_session: await viewerJwt() },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('DELETE /v1/projects/:id: 404 cross-firm', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'DELETE',
    url: `/v1/projects/${PROJECT_PRESEED_B}`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('DELETE /v1/projects/:id: 400 on invalid body (extra key)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'DELETE',
    url: `/v1/projects/${PROJECT_PRESEED_A}`,
    cookies: { cpa_session: await consultantJwt() },
    payload: { reason: 'ok', extra_key: 'nope' },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

// Bridge to A2: archived projects are read-only via PATCH. Once A1 lands
// this is the contract that downstream activity routes will rely on
// (no writes against an archived parent project).
test('PATCH /v1/projects/:id: 409 when project already archived', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/projects/${PROJECT_PRESEED_ARCHIVED}`,
    cookies: { cpa_session: await consultantJwt() },
    payload: { name: 'Try to rename archived' },
  });
  assert.equal(res.statusCode, 409);
  await app.close();
});
