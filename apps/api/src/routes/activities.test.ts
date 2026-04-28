import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { signSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../app.js';

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

// Per-test UUID prefixes — `0000a3XXXX` is the T-A3 namespace (P4 Swimlane A,
// Task 3, activity routes). Disjoint from T-A1 / T-A2 so parallel test runs
// don't collide on the shared cleanup paths.
const TENANT_A = '00000000-0000-4000-8000-0000000a3001';
const TENANT_B = '00000000-0000-4000-8000-0000000a3002';
const ADMIN_USER = '00000000-0000-4000-8000-0000000a3010';
const VIEWER_USER = '00000000-0000-4000-8000-0000000a3011';
const CONSULTANT_USER = '00000000-0000-4000-8000-0000000a3012';
// Tenant-B admin — same convention as A1 / A2's cross-firm RLS positive control.
const TENANT_B_ADMIN = '00000000-0000-4000-8000-0000000a3013';
const SUBJECT_A1 = '00000000-0000-4000-8000-0000000a3021';
const SUBJECT_A2 = '00000000-0000-4000-8000-0000000a3022';
const SUBJECT_B1 = '00000000-0000-4000-8000-0000000a3023';

// Pre-seeded project / claim rows used by the GET / PATCH tests.
// Naming: PROJECT_A_OPEN sits under SUBJECT_A1 and is active; CLAIM_A_OPEN
// is its engagement-stage claim; CLAIM_A_SUBMITTED is the submitted-claim
// gate; CLAIM_A_AUDIT is audit_defence (locked-stage gate); the B-tenant
// fixtures power the cross-firm RLS positive control.
const PROJECT_A_OPEN = '00000000-0000-4000-8000-0000000a3031';
const PROJECT_A_ARCHIVED = '00000000-0000-4000-8000-0000000a3032';
const PROJECT_B_OPEN = '00000000-0000-4000-8000-0000000a3033';
// Project under SUBJECT_A2 — used to exercise project-claim mismatch.
const PROJECT_A2_OPEN = '00000000-0000-4000-8000-0000000a3034';

const CLAIM_A_OPEN = '00000000-0000-4000-8000-0000000a3041';
const CLAIM_A_SUBMITTED = '00000000-0000-4000-8000-0000000a3042';
const CLAIM_A_AUDIT = '00000000-0000-4000-8000-0000000a3043';
const CLAIM_B_OPEN = '00000000-0000-4000-8000-0000000a3044';
// Claim under SUBJECT_A2 (different claimant) for the project-claim
// mismatch test.
const CLAIM_A2_OPEN = '00000000-0000-4000-8000-0000000a3045';

// Pre-seeded activity rows — used by GET detail / PATCH tests + as the
// "pre-existing activities for gap-fill" fixture in the POST test.
const ACTIVITY_PRESEED_CA01 = '00000000-0000-4000-8000-0000000a3051';
const ACTIVITY_PRESEED_CA03 = '00000000-0000-4000-8000-0000000a3052';
const ACTIVITY_B_PRESEED = '00000000-0000-4000-8000-0000000a3053';
// Activity under CLAIM_A_AUDIT (locked-stage parent) — used to exercise
// the PATCH 409 claim_locked path.
const ACTIVITY_PRESEED_LOCKED = '00000000-0000-4000-8000-0000000a3054';

const TENANT_IDS = [TENANT_A, TENANT_B] as const;

/**
 * FK-safe cleanup. activity → claim/project; events FK to tenant +
 * subject_tenant. Defensively clears `audit_score_snapshot` first
 * because it FK-references subject_tenant.
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
            VALUES (${TENANT_A}, 'Firm A', 'firm-a-a3', 'mixed'),
                   (${TENANT_B}, 'Firm B', 'firm-b-a3', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${ADMIN_USER}, 'a3-admin@example.com', 'microsoft', 'microsoft:a3-admin', 'A3 Admin'),
                   (${VIEWER_USER}, 'a3-viewer@example.com', 'microsoft', 'microsoft:a3-viewer', 'A3 Viewer'),
                   (${CONSULTANT_USER}, 'a3-cons@example.com', 'microsoft', 'microsoft:a3-cons', 'A3 Consultant'),
                   (${TENANT_B_ADMIN}, 'a3-admin-b@example.com', 'microsoft', 'microsoft:a3-admin-b', 'A3 Admin (Firm B)')`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT_A}, ${ADMIN_USER}, 'admin', true),
                              (gen_random_uuid(), ${TENANT_A}, ${VIEWER_USER}, 'viewer', true),
                              (gen_random_uuid(), ${TENANT_A}, ${CONSULTANT_USER}, 'consultant', true),
                              (gen_random_uuid(), ${TENANT_B}, ${TENANT_B_ADMIN}, 'admin', true)`;
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                       VALUES (${SUBJECT_A1}, ${TENANT_A}, 'A3 Acme Co', 'claimant'),
                              (${SUBJECT_A2}, ${TENANT_A}, 'A3 Beta Ltd', 'claimant'),
                              (${SUBJECT_B1}, ${TENANT_B}, 'A3 Other Corp', 'claimant')`;
  await privilegedSql`
    INSERT INTO project (id, tenant_id, subject_tenant_id, name, started_at)
    VALUES
      (${PROJECT_A_OPEN}, ${TENANT_A}, ${SUBJECT_A1}, 'A3 Project Open',
       '2026-01-01T00:00:00Z'::timestamptz),
      (${PROJECT_A_ARCHIVED}, ${TENANT_A}, ${SUBJECT_A1}, 'A3 Project Archived',
       '2025-01-01T00:00:00Z'::timestamptz),
      (${PROJECT_A2_OPEN}, ${TENANT_A}, ${SUBJECT_A2}, 'A3 Project A2',
       '2026-01-01T00:00:00Z'::timestamptz),
      (${PROJECT_B_OPEN}, ${TENANT_B}, ${SUBJECT_B1}, 'A3 Project B',
       '2026-01-01T00:00:00Z'::timestamptz)
  `;
  await privilegedSql`UPDATE project SET archived_at = NOW() WHERE id = ${PROJECT_A_ARCHIVED}`;
  await privilegedSql`
    INSERT INTO claim (id, tenant_id, subject_tenant_id, fiscal_year, stage)
    VALUES
      (${CLAIM_A_OPEN}, ${TENANT_A}, ${SUBJECT_A1}, 2026, 'engagement'),
      (${CLAIM_A_SUBMITTED}, ${TENANT_A}, ${SUBJECT_A1}, 2024, 'submitted'),
      (${CLAIM_A_AUDIT}, ${TENANT_A}, ${SUBJECT_A1}, 2023, 'audit_defence'),
      (${CLAIM_A2_OPEN}, ${TENANT_A}, ${SUBJECT_A2}, 2026, 'engagement'),
      (${CLAIM_B_OPEN}, ${TENANT_B}, ${SUBJECT_B1}, 2026, 'engagement')
  `;
  // Pre-seed CA-01 and CA-03 under CLAIM_A_OPEN — gap-fill test asserts
  // that the next CA code is CA-02 (not CA-04).
  await privilegedSql`
    INSERT INTO activity (id, tenant_id, project_id, claim_id, code, kind, title)
    VALUES
      (${ACTIVITY_PRESEED_CA01}, ${TENANT_A}, ${PROJECT_A_OPEN}, ${CLAIM_A_OPEN},
       'CA-01', 'core', 'Preseed CA-01'),
      (${ACTIVITY_PRESEED_CA03}, ${TENANT_A}, ${PROJECT_A_OPEN}, ${CLAIM_A_OPEN},
       'CA-03', 'core', 'Preseed CA-03'),
      (${ACTIVITY_B_PRESEED}, ${TENANT_B}, ${PROJECT_B_OPEN}, ${CLAIM_B_OPEN},
       'CA-01', 'core', 'Firm B preseed'),
      (${ACTIVITY_PRESEED_LOCKED}, ${TENANT_A}, ${PROJECT_A_OPEN}, ${CLAIM_A_AUDIT},
       'CA-01', 'core', 'Locked-claim activity')
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

const adminJwt = (): Promise<string> => jwtFor(ADMIN_USER, 'a3-admin@example.com', 'admin');
const viewerJwt = (): Promise<string> => jwtFor(VIEWER_USER, 'a3-viewer@example.com', 'viewer');
const consultantJwt = (): Promise<string> =>
  jwtFor(CONSULTANT_USER, 'a3-cons@example.com', 'consultant');
const tenantBAdminJwt = (): Promise<string> =>
  jwtFor(TENANT_B_ADMIN, 'a3-admin-b@example.com', 'admin', TENANT_B);

void TENANT_IDS;

// =============================================================================
// POST /v1/activities
// =============================================================================

test('POST /v1/activities: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/activities',
    payload: {
      project_id: PROJECT_A_OPEN,
      claim_id: CLAIM_A_OPEN,
      kind: 'core',
      title: 'New core activity',
    },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /v1/activities: 201 with auto-generated CA-02 (gap-fill against preseeded CA-01 + CA-03)', async () => {
  // The preseed inserted CA-01 and CA-03 under CLAIM_A_OPEN (skipping
  // CA-02). The route should ask nextActivityCode for the next core
  // code, get CA-02 (gap-fill), and insert it.
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/activities',
    cookies: { cpa_session: await consultantJwt() },
    payload: {
      project_id: PROJECT_A_OPEN,
      claim_id: CLAIM_A_OPEN,
      kind: 'core',
      title: 'Gap-filled core',
      hypothesis: 'We hypothesise the gap will be filled with CA-02',
    },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json<{
    activity: {
      id: string;
      code: string;
      kind: string;
      title: string;
      tenant_id: string;
      hypothesis: string | null;
    };
  }>();
  assert.equal(body.activity.code, 'CA-02');
  assert.equal(body.activity.kind, 'core');
  assert.equal(body.activity.tenant_id, TENANT_A);
  assert.equal(body.activity.hypothesis, 'We hypothesise the gap will be filled with CA-02');

  // Verify the activity row is in the DB.
  const rows = await privilegedSql<{ id: string; code: string }[]>`
    SELECT id, code FROM activity WHERE id = ${body.activity.id}
  `;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.code, 'CA-02');

  // Verify ACTIVITY_CREATED event landed with the expected payload shape.
  const eventRows = await privilegedSql<
    {
      payload: {
        activity_id: string;
        code: string;
        kind: string;
        title: string;
        project_id: string;
        claim_id: string;
      };
    }[]
  >`
    SELECT payload FROM event
     WHERE subject_tenant_id = ${SUBJECT_A1}
       AND kind = 'ACTIVITY_CREATED'
       AND payload ->> 'activity_id' = ${body.activity.id}
  `;
  assert.equal(eventRows.length, 1);
  assert.equal(eventRows[0]!.payload.code, 'CA-02');
  assert.equal(eventRows[0]!.payload.kind, 'core');
  assert.equal(eventRows[0]!.payload.title, 'Gap-filled core');

  // Cleanup so the gap is restored for the mixed-kinds test below.
  await privilegedSql`DELETE FROM event WHERE payload ->> 'activity_id' = ${body.activity.id}`;
  await privilegedSql`DELETE FROM activity WHERE id = ${body.activity.id}`;
  await app.close();
});

test('POST /v1/activities: 201 with SA-01 even when CA-01 already exists (kinds independent)', async () => {
  // CA-01 / CA-03 are preseeded; this request asks for kind=supporting,
  // so the route should resolve SA-01 (not SA-02) — kinds are
  // independent sequences per nextActivityCode's contract.
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/activities',
    cookies: { cpa_session: await consultantJwt() },
    payload: {
      project_id: PROJECT_A_OPEN,
      claim_id: CLAIM_A_OPEN,
      kind: 'supporting',
      title: 'First supporting activity',
    },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json<{ activity: { id: string; code: string; kind: string } }>();
  assert.equal(body.activity.code, 'SA-01');
  assert.equal(body.activity.kind, 'supporting');

  await privilegedSql`DELETE FROM event WHERE payload ->> 'activity_id' = ${body.activity.id}`;
  await privilegedSql`DELETE FROM activity WHERE id = ${body.activity.id}`;
  await app.close();
});

test('POST /v1/activities: 400 on invalid body (missing kind)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/activities',
    cookies: { cpa_session: await consultantJwt() },
    payload: {
      project_id: PROJECT_A_OPEN,
      claim_id: CLAIM_A_OPEN,
      title: 'No kind',
    },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /v1/activities: 403 for viewer role', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/activities',
    cookies: { cpa_session: await viewerJwt() },
    payload: {
      project_id: PROJECT_A_OPEN,
      claim_id: CLAIM_A_OPEN,
      kind: 'core',
      title: 'Viewer cannot create',
    },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('POST /v1/activities: 404 cross-firm project', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/activities',
    cookies: { cpa_session: await adminJwt() },
    payload: {
      project_id: PROJECT_B_OPEN,
      claim_id: CLAIM_A_OPEN,
      kind: 'core',
      title: 'Cross-firm project',
    },
  });
  assert.equal(res.statusCode, 404);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'project_not_found');
  await app.close();
});

test('POST /v1/activities: 404 cross-firm claim', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/activities',
    cookies: { cpa_session: await adminJwt() },
    payload: {
      project_id: PROJECT_A_OPEN,
      claim_id: CLAIM_B_OPEN,
      kind: 'core',
      title: 'Cross-firm claim',
    },
  });
  assert.equal(res.statusCode, 404);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'claim_not_found');
  await app.close();
});

test('POST /v1/activities: 409 archived project', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/activities',
    cookies: { cpa_session: await consultantJwt() },
    payload: {
      project_id: PROJECT_A_ARCHIVED,
      claim_id: CLAIM_A_OPEN,
      kind: 'core',
      title: 'Try archived parent',
    },
  });
  assert.equal(res.statusCode, 409);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'project_archived');
  await app.close();
});

test('POST /v1/activities: 409 submitted claim', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/activities',
    cookies: { cpa_session: await consultantJwt() },
    payload: {
      project_id: PROJECT_A_OPEN,
      claim_id: CLAIM_A_SUBMITTED,
      kind: 'core',
      title: 'Try submitted claim',
    },
  });
  assert.equal(res.statusCode, 409);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'claim_locked');
  await app.close();
});

test('POST /v1/activities: 409 audit_defence claim', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/activities',
    cookies: { cpa_session: await consultantJwt() },
    payload: {
      project_id: PROJECT_A_OPEN,
      claim_id: CLAIM_A_AUDIT,
      kind: 'core',
      title: 'Try audit_defence claim',
    },
  });
  assert.equal(res.statusCode, 409);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'claim_locked');
  await app.close();
});

test('POST /v1/activities: 409 project/claim claimant mismatch', async () => {
  // PROJECT_A_OPEN belongs to SUBJECT_A1; CLAIM_A2_OPEN belongs to
  // SUBJECT_A2. Both visible under firm-A's RLS, but the activity
  // would orphan to the wrong claimant — route surfaces 409.
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/activities',
    cookies: { cpa_session: await consultantJwt() },
    payload: {
      project_id: PROJECT_A_OPEN,
      claim_id: CLAIM_A2_OPEN,
      kind: 'core',
      title: 'Wrong claimant',
    },
  });
  assert.equal(res.statusCode, 409);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'project_claim_mismatch');
  await app.close();
});

// =============================================================================
// GET /v1/activities
// =============================================================================

test('GET /v1/activities: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/v1/activities' });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('GET /v1/activities?claim_id=...: returns rows in code order, RLS filters firm-B', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/activities?claim_id=${CLAIM_A_OPEN}`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ activities: Array<{ id: string; code: string; tenant_id: string }> }>();
  // Preseed has CA-01 + CA-03 under CLAIM_A_OPEN; in code order: CA-01, CA-03.
  assert.equal(body.activities.length, 2);
  assert.equal(body.activities[0]?.code, 'CA-01');
  assert.equal(body.activities[1]?.code, 'CA-03');
  assert.ok(body.activities.every((a) => a.tenant_id === TENANT_A));
  // RLS isolates firm-B's preseed.
  assert.ok(!body.activities.some((a) => a.id === ACTIVITY_B_PRESEED));
  await app.close();
});

test('GET /v1/activities: positive-control — firm-B session DOES see firm-B activity (cross-firm RLS)', async () => {
  // Counterpart to the firm-A isolation test above — proves RLS isn't
  // silently returning nothing for everyone.
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/activities?claim_id=${CLAIM_B_OPEN}`,
    cookies: { cpa_session: await tenantBAdminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ activities: Array<{ id: string; tenant_id: string }> }>();
  assert.ok(body.activities.some((a) => a.id === ACTIVITY_B_PRESEED));
  assert.ok(body.activities.every((a) => a.tenant_id === TENANT_B));
  // Belt + braces: firm-B session must NOT see firm-A's preseeds.
  assert.ok(!body.activities.some((a) => a.id === ACTIVITY_PRESEED_CA01));
  await app.close();
});

test('GET /v1/activities: 400 on invalid query (non-uuid claim_id)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/activities?claim_id=not-a-uuid',
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('GET /v1/activities/:id: detail returns the activity', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/activities/${ACTIVITY_PRESEED_CA01}`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ activity: { id: string; code: string } }>();
  assert.equal(body.activity.id, ACTIVITY_PRESEED_CA01);
  assert.equal(body.activity.code, 'CA-01');
  await app.close();
});

test('GET /v1/activities/:id: 404 cross-firm', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/activities/${ACTIVITY_B_PRESEED}`,
    cookies: { cpa_session: await adminJwt() }, // session in firm A
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

// =============================================================================
// PATCH /v1/activities/:id
// =============================================================================

test('PATCH /v1/activities/:id: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/activities/${ACTIVITY_PRESEED_CA01}`,
    payload: { title: 'Renamed' },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('PATCH /v1/activities/:id: 200 + ACTIVITY_UPDATED event with fields_changed diff', async () => {
  // Seed a fresh activity row so this test owns its event-chain mutation.
  const ACTIVITY_FOR_PATCH = '00000000-0000-4000-8000-0000000a3061';
  await privilegedSql`
    INSERT INTO activity (id, tenant_id, project_id, claim_id, code, kind, title, description)
    VALUES (${ACTIVITY_FOR_PATCH}, ${TENANT_A}, ${PROJECT_A_OPEN}, ${CLAIM_A_OPEN},
            'CA-50', 'core', 'Old Title', 'Old description')
  `;
  // Defensively clear any prior ACTIVITY_UPDATED events for this activity
  // so the assertion below is unambiguous (per A2 fix #4 pattern).
  await privilegedSql`
    DELETE FROM event WHERE payload ->> 'activity_id' = ${ACTIVITY_FOR_PATCH}
  `;
  try {
    const app = buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/activities/${ACTIVITY_FOR_PATCH}`,
      cookies: { cpa_session: await consultantJwt() },
      payload: {
        title: 'New Title',
        hypothesis: 'New hypothesis',
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{ activity: { title: string; hypothesis: string | null } }>();
    assert.equal(body.activity.title, 'New Title');
    assert.equal(body.activity.hypothesis, 'New hypothesis');

    const eventRows = await privilegedSql<
      {
        payload: {
          activity_id: string;
          fields_changed: Record<string, { from: unknown; to: unknown }>;
        };
      }[]
    >`
      SELECT payload FROM event
       WHERE kind = 'ACTIVITY_UPDATED'
         AND payload ->> 'activity_id' = ${ACTIVITY_FOR_PATCH}
    `;
    assert.equal(eventRows.length, 1);
    const fc = eventRows[0]!.payload.fields_changed;
    assert.ok('title' in fc);
    assert.ok('hypothesis' in fc);
    assert.equal(fc['title']?.from, 'Old Title');
    assert.equal(fc['title']?.to, 'New Title');
    assert.equal(fc['hypothesis']?.from, null);
    assert.equal(fc['hypothesis']?.to, 'New hypothesis');

    await app.close();
  } finally {
    await privilegedSql`DELETE FROM event WHERE payload ->> 'activity_id' = ${ACTIVITY_FOR_PATCH}`;
    await privilegedSql`DELETE FROM activity WHERE id = ${ACTIVITY_FOR_PATCH}`;
  }
});

test('PATCH /v1/activities/:id: 200 no-op (empty body) returns row, no event', async () => {
  // Defensive: clear any prior ACTIVITY_UPDATED for this preseed.
  await privilegedSql`
    DELETE FROM event WHERE payload ->> 'activity_id' = ${ACTIVITY_PRESEED_CA01}
  `;
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/activities/${ACTIVITY_PRESEED_CA01}`,
    cookies: { cpa_session: await consultantJwt() },
    payload: {},
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ activity: { id: string; code: string } }>();
  assert.equal(body.activity.id, ACTIVITY_PRESEED_CA01);

  const eventRows = await privilegedSql<{ id: string }[]>`
    SELECT id FROM event
     WHERE kind = 'ACTIVITY_UPDATED'
       AND payload ->> 'activity_id' = ${ACTIVITY_PRESEED_CA01}
  `;
  assert.equal(eventRows.length, 0);
  await app.close();
});

test('PATCH /v1/activities/:id: 200 same-value patch (title -> existing title) emits NO event', async () => {
  // The diff-driven event suppression: even though the patch supplies a
  // value, if it matches the current row no field actually changed and no
  // ACTIVITY_UPDATED should land.
  const ACTIVITY_FOR_NOOP = '00000000-0000-4000-8000-0000000a3062';
  await privilegedSql`
    INSERT INTO activity (id, tenant_id, project_id, claim_id, code, kind, title)
    VALUES (${ACTIVITY_FOR_NOOP}, ${TENANT_A}, ${PROJECT_A_OPEN}, ${CLAIM_A_OPEN},
            'CA-51', 'core', 'Stable Title')
  `;
  await privilegedSql`
    DELETE FROM event WHERE payload ->> 'activity_id' = ${ACTIVITY_FOR_NOOP}
  `;
  try {
    const app = buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/activities/${ACTIVITY_FOR_NOOP}`,
      cookies: { cpa_session: await consultantJwt() },
      payload: { title: 'Stable Title' },
    });
    assert.equal(res.statusCode, 200);

    const eventRows = await privilegedSql<{ id: string }[]>`
      SELECT id FROM event
       WHERE kind = 'ACTIVITY_UPDATED'
         AND payload ->> 'activity_id' = ${ACTIVITY_FOR_NOOP}
    `;
    assert.equal(eventRows.length, 0);
    await app.close();
  } finally {
    await privilegedSql`DELETE FROM event WHERE payload ->> 'activity_id' = ${ACTIVITY_FOR_NOOP}`;
    await privilegedSql`DELETE FROM activity WHERE id = ${ACTIVITY_FOR_NOOP}`;
  }
});

test('PATCH /v1/activities/:id: 200 partial-same — fields_changed contains only changed keys', async () => {
  // Mixed diff: one field changes, one stays identical. The `recordIfChanged`
  // helper SHOULD only emit the actually-changed key in fields_changed —
  // unchanged columns must not pollute the audit chain even when they
  // appeared in the patch payload. A future refactor that accidentally
  // includes unchanged fields would render false changes downstream
  // (assurance report renderer reads this map verbatim).
  const ACTIVITY_FOR_PARTIAL = '00000000-0000-4000-8000-0000000a3063';
  await privilegedSql`
    INSERT INTO activity (id, tenant_id, project_id, claim_id, code, kind, title, description)
    VALUES (${ACTIVITY_FOR_PARTIAL}, ${TENANT_A}, ${PROJECT_A_OPEN}, ${CLAIM_A_OPEN},
            'CA-52', 'core', 'Original', 'KeepThis')
  `;
  await privilegedSql`
    DELETE FROM event WHERE payload ->> 'activity_id' = ${ACTIVITY_FOR_PARTIAL}
  `;
  try {
    const app = buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/activities/${ACTIVITY_FOR_PARTIAL}`,
      cookies: { cpa_session: await consultantJwt() },
      payload: { title: 'Updated', description: 'KeepThis' },
    });
    assert.equal(res.statusCode, 200);

    const eventRows = await privilegedSql<
      {
        payload: {
          activity_id: string;
          fields_changed: Record<string, { from: unknown; to: unknown }>;
        };
      }[]
    >`
      SELECT payload FROM event
       WHERE kind = 'ACTIVITY_UPDATED'
         AND payload ->> 'activity_id' = ${ACTIVITY_FOR_PARTIAL}
    `;
    assert.equal(eventRows.length, 1, 'exactly one ACTIVITY_UPDATED event');
    const fieldsChanged = eventRows[0]!.payload.fields_changed;
    // Lock the contract: only `title` is in fields_changed, NOT `description`.
    assert.deepEqual(Object.keys(fieldsChanged).sort(), ['title']);
    assert.deepEqual(fieldsChanged['title'], { from: 'Original', to: 'Updated' });
    await app.close();
  } finally {
    await privilegedSql`DELETE FROM event WHERE payload ->> 'activity_id' = ${ACTIVITY_FOR_PARTIAL}`;
    await privilegedSql`DELETE FROM activity WHERE id = ${ACTIVITY_FOR_PARTIAL}`;
  }
});

test('PATCH /v1/activities/:id: 400 on extra unknown key (.strict())', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/activities/${ACTIVITY_PRESEED_CA01}`,
    cookies: { cpa_session: await consultantJwt() },
    payload: { title: 'Renamed', not_a_real_column: true },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('PATCH /v1/activities/:id: 403 for viewer role', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/activities/${ACTIVITY_PRESEED_CA01}`,
    cookies: { cpa_session: await viewerJwt() },
    payload: { title: 'Renamed' },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('PATCH /v1/activities/:id: 404 cross-firm', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/activities/${ACTIVITY_B_PRESEED}`,
    cookies: { cpa_session: await adminJwt() }, // session in firm A
    payload: { title: 'Cross-firm patch' },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('PATCH /v1/activities/:id: 409 when parent claim is in audit_defence (locked stage)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/activities/${ACTIVITY_PRESEED_LOCKED}`,
    cookies: { cpa_session: await consultantJwt() },
    payload: { title: 'Try editing locked-claim activity' },
  });
  assert.equal(res.statusCode, 409);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'claim_locked');
  await app.close();
});
