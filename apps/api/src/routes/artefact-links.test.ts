import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { signSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../app.js';
import { getActivityArtefacts } from '../lib/activity-artefacts.js';

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

// Per-test UUID prefixes — `0000a4XXXX` is the T-A4 namespace (P4 Swimlane A,
// Task 4, artefact-link routes). Disjoint from T-A1 / T-A2 / T-A3 so parallel
// test runs don't collide on the shared cleanup paths.
const TENANT_A = '00000000-0000-4000-8000-0000000a4001';
const TENANT_B = '00000000-0000-4000-8000-0000000a4002';
const ADMIN_USER = '00000000-0000-4000-8000-0000000a4010';
const VIEWER_USER = '00000000-0000-4000-8000-0000000a4011';
const CONSULTANT_USER = '00000000-0000-4000-8000-0000000a4012';
// Tenant-B admin — same convention as A1 / A2 / A3's cross-firm RLS positive control.
const TENANT_B_ADMIN = '00000000-0000-4000-8000-0000000a4013';

const SUBJECT_A1 = '00000000-0000-4000-8000-0000000a4021';
const SUBJECT_B1 = '00000000-0000-4000-8000-0000000a4022';

const EMPLOYEE_A1 = '00000000-0000-4000-8000-0000000a4090';
const EMPLOYEE_B1 = '00000000-0000-4000-8000-0000000a4091';

const PROJECT_A_OPEN = '00000000-0000-4000-8000-0000000a4031';
const PROJECT_B_OPEN = '00000000-0000-4000-8000-0000000a4032';

const CLAIM_A_OPEN = '00000000-0000-4000-8000-0000000a4041';
const CLAIM_A_AUDIT = '00000000-0000-4000-8000-0000000a4042';
const CLAIM_B_OPEN = '00000000-0000-4000-8000-0000000a4043';

// Activities — one open (link/unlink target), one under a locked claim.
const ACTIVITY_A_OPEN = '00000000-0000-4000-8000-0000000a4051';
const ACTIVITY_A_LOCKED = '00000000-0000-4000-8000-0000000a4052';
const ACTIVITY_B_OPEN = '00000000-0000-4000-8000-0000000a4053';

// Artefact fixtures — one of each kind, on each tenant.
const MEDIA_A = '00000000-0000-4000-8000-0000000a4061';
const MEDIA_B = '00000000-0000-4000-8000-0000000a4062';
// We seed the cross-firm artefact-event with prev_hash=NULL/hash=...
// directly via privilegedSql so we don't have to drag the chain helper
// in here. The id is the artefact_id we'll try to link.
const EVENT_ARTEFACT_A = '00000000-0000-4000-8000-0000000a4063';
const EVENT_ARTEFACT_B = '00000000-0000-4000-8000-0000000a4064';
const EXPENDITURE_A = '00000000-0000-4000-8000-0000000a4065';
const EXPENDITURE_B = '00000000-0000-4000-8000-0000000a4066';
const TIME_ENTRY_A = '00000000-0000-4000-8000-0000000a4067';
const TIME_ENTRY_B = '00000000-0000-4000-8000-0000000a4068';

/**
 * FK-safe cleanup. Strict order: chain events, artefact tables that
 * may FK to event, then activity → claim/project, then employees,
 * subject_tenant rows, tenant memberships, users, tenants. Defensively
 * clears `audit_score_snapshot` first because it FK-references
 * subject_tenant.
 */
const cleanup = async (): Promise<void> => {
  await privilegedSql`
    DELETE FROM audit_score_snapshot
     WHERE subject_tenant_id IN (
       SELECT id FROM subject_tenant WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})
     )
  `;
  // Some downstream rows FK to event.id (media_artefact.event_id); null
  // those out first to allow event deletion. Don't lean on cascade.
  await privilegedSql`
    UPDATE media_artefact SET event_id = NULL
     WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})
  `;
  await privilegedSql`DELETE FROM event WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM time_entry WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM expenditure_line WHERE expenditure_id IN (${EXPENDITURE_A}, ${EXPENDITURE_B})`;
  await privilegedSql`DELETE FROM expenditure WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM media_artefact WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM activity WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM claim WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM project WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`
    DELETE FROM subject_tenant_employee WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})
  `;
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
            VALUES (${TENANT_A}, 'Firm A', 'firm-a-a4', 'mixed'),
                   (${TENANT_B}, 'Firm B', 'firm-b-a4', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${ADMIN_USER}, 'a4-admin@example.com', 'microsoft', 'microsoft:a4-admin', 'A4 Admin'),
                   (${VIEWER_USER}, 'a4-viewer@example.com', 'microsoft', 'microsoft:a4-viewer', 'A4 Viewer'),
                   (${CONSULTANT_USER}, 'a4-cons@example.com', 'microsoft', 'microsoft:a4-cons', 'A4 Consultant'),
                   (${TENANT_B_ADMIN}, 'a4-admin-b@example.com', 'microsoft', 'microsoft:a4-admin-b', 'A4 Admin (Firm B)')`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT_A}, ${ADMIN_USER}, 'admin', true),
                              (gen_random_uuid(), ${TENANT_A}, ${VIEWER_USER}, 'viewer', true),
                              (gen_random_uuid(), ${TENANT_A}, ${CONSULTANT_USER}, 'consultant', true),
                              (gen_random_uuid(), ${TENANT_B}, ${TENANT_B_ADMIN}, 'admin', true)`;
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                       VALUES (${SUBJECT_A1}, ${TENANT_A}, 'A4 Acme Co', 'claimant'),
                              (${SUBJECT_B1}, ${TENANT_B}, 'A4 Other Corp', 'claimant')`;
  await privilegedSql`
    INSERT INTO subject_tenant_employee (id, subject_tenant_id, tenant_id, email, name, invited_by_user_id)
    VALUES
      (${EMPLOYEE_A1}, ${SUBJECT_A1}, ${TENANT_A}, 'a4-emp-a@example.com', 'A4 Emp A', ${ADMIN_USER}),
      (${EMPLOYEE_B1}, ${SUBJECT_B1}, ${TENANT_B}, 'a4-emp-b@example.com', 'A4 Emp B', ${ADMIN_USER})
  `;
  await privilegedSql`
    INSERT INTO project (id, tenant_id, subject_tenant_id, name, started_at)
    VALUES
      (${PROJECT_A_OPEN}, ${TENANT_A}, ${SUBJECT_A1}, 'A4 Project Open',
       '2026-01-01T00:00:00Z'::timestamptz),
      (${PROJECT_B_OPEN}, ${TENANT_B}, ${SUBJECT_B1}, 'A4 Project B',
       '2026-01-01T00:00:00Z'::timestamptz)
  `;
  await privilegedSql`
    INSERT INTO claim (id, tenant_id, subject_tenant_id, fiscal_year, stage)
    VALUES
      (${CLAIM_A_OPEN}, ${TENANT_A}, ${SUBJECT_A1}, 2026, 'engagement'),
      (${CLAIM_A_AUDIT}, ${TENANT_A}, ${SUBJECT_A1}, 2023, 'audit_defence'),
      (${CLAIM_B_OPEN}, ${TENANT_B}, ${SUBJECT_B1}, 2026, 'engagement')
  `;
  await privilegedSql`
    INSERT INTO activity (id, tenant_id, project_id, claim_id, code, kind, title)
    VALUES
      (${ACTIVITY_A_OPEN}, ${TENANT_A}, ${PROJECT_A_OPEN}, ${CLAIM_A_OPEN},
       'CA-01', 'core', 'A4 Activity A Open'),
      (${ACTIVITY_A_LOCKED}, ${TENANT_A}, ${PROJECT_A_OPEN}, ${CLAIM_A_AUDIT},
       'CA-02', 'core', 'A4 Activity A Locked'),
      (${ACTIVITY_B_OPEN}, ${TENANT_B}, ${PROJECT_B_OPEN}, ${CLAIM_B_OPEN},
       'CA-01', 'core', 'A4 Activity B Open')
  `;

  // Artefact fixtures — minimal valid rows of each kind in each tenant.
  const FAKE_SHA = 'a4'.padEnd(64, '0');
  await privilegedSql`
    INSERT INTO media_artefact (
      id, tenant_id, subject_tenant_id, uploaded_by_employee_id,
      s3_key, content_hash, mime_type, size_bytes
    ) VALUES
      (${MEDIA_A}, ${TENANT_A}, ${SUBJECT_A1}, ${EMPLOYEE_A1},
       's3://a4/media-a', ${'a' + FAKE_SHA.slice(1)}, 'image/jpeg', 1024),
      (${MEDIA_B}, ${TENANT_B}, ${SUBJECT_B1}, ${EMPLOYEE_B1},
       's3://a4/media-b', ${'b' + FAKE_SHA.slice(1)}, 'image/jpeg', 1024)
  `;

  // Standalone events for the 'event' artefact_kind. We seed these as
  // ARTEFACT_LINKED-irrelevant rows (kind='SUPPORTING', employee captured)
  // so they don't pollute the chain we'll build during the test. We
  // sidestep the chain helper for fixtures — the assertions below filter
  // on `kind=ARTEFACT_LINKED` / `ARTEFACT_UNLINKED`, so SUPPORTING fixtures
  // are inert. Hashes are arbitrary unique 64-char hex placeholders;
  // verifyChain isn't run in this test file.
  await privilegedSql`
    INSERT INTO event (
      id, tenant_id, subject_tenant_id, project_id, kind, payload,
      prev_hash, hash, captured_at, captured_by_employee_id
    ) VALUES
      (${EVENT_ARTEFACT_A}, ${TENANT_A}, ${SUBJECT_A1}, ${PROJECT_A_OPEN}, 'SUPPORTING',
       '{"raw_text":"a4 fixture event A"}'::jsonb,
       NULL, ${'a4'.padEnd(64, 'a')},
       '2026-04-01T10:00:00Z'::timestamptz, ${EMPLOYEE_A1}),
      (${EVENT_ARTEFACT_B}, ${TENANT_B}, ${SUBJECT_B1}, ${PROJECT_B_OPEN}, 'SUPPORTING',
       '{"raw_text":"a4 fixture event B"}'::jsonb,
       NULL, ${'a4'.padEnd(64, 'b')},
       '2026-04-01T10:00:00Z'::timestamptz, ${EMPLOYEE_B1})
  `;

  await privilegedSql`
    INSERT INTO expenditure (
      id, tenant_id, subject_tenant_id, source, vendor_name,
      expenditure_date, total_amount, currency
    ) VALUES
      (${EXPENDITURE_A}, ${TENANT_A}, ${SUBJECT_A1}, 'xero_invoice', 'A4 Vendor A',
       '2026-03-15', '500.00', 'AUD'),
      (${EXPENDITURE_B}, ${TENANT_B}, ${SUBJECT_B1}, 'xero_invoice', 'A4 Vendor B',
       '2026-03-15', '500.00', 'AUD')
  `;

  await privilegedSql`
    INSERT INTO time_entry (
      id, tenant_id, subject_tenant_id, employee_id, source,
      started_at, ended_at, duration_minutes, is_rd
    ) VALUES
      (${TIME_ENTRY_A}, ${TENANT_A}, ${SUBJECT_A1}, ${EMPLOYEE_A1}, 'manual',
       '2026-04-25T09:00:00Z'::timestamptz, '2026-04-25T11:00:00Z'::timestamptz,
       120, true),
      (${TIME_ENTRY_B}, ${TENANT_B}, ${SUBJECT_B1}, ${EMPLOYEE_B1}, 'manual',
       '2026-04-25T09:00:00Z'::timestamptz, '2026-04-25T11:00:00Z'::timestamptz,
       120, true)
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

const adminJwt = (): Promise<string> => jwtFor(ADMIN_USER, 'a4-admin@example.com', 'admin');
const viewerJwt = (): Promise<string> => jwtFor(VIEWER_USER, 'a4-viewer@example.com', 'viewer');
const consultantJwt = (): Promise<string> =>
  jwtFor(CONSULTANT_USER, 'a4-cons@example.com', 'consultant');
const tenantBAdminJwt = (): Promise<string> =>
  jwtFor(TENANT_B_ADMIN, 'a4-admin-b@example.com', 'admin', TENANT_B);

// Helper: clear ARTEFACT_LINKED / ARTEFACT_UNLINKED events for a given
// activity_id so each test starts from a clean slate. We don't drop the
// fixture media/expenditure/etc. rows.
//
// Tenant-scoped for symmetry with the file's other DELETEs (lines 73-78);
// cross-test isolation works today via disjoint UUID prefixes regardless,
// but the explicit `tenant_id IN (...)` makes the contract clear.
const clearLinkEvents = async (activityId: string): Promise<void> => {
  await privilegedSql`
    DELETE FROM event
     WHERE kind IN ('ARTEFACT_LINKED', 'ARTEFACT_UNLINKED')
       AND payload ->> 'activity_id' = ${activityId}
       AND tenant_id IN (${TENANT_A}, ${TENANT_B})
  `;
};

// =============================================================================
// POST /v1/activities/:id/artefact-links
// =============================================================================

test('POST artefact-links: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/activities/${ACTIVITY_A_OPEN}/artefact-links`,
    payload: { artefact_kind: 'media', artefact_id: MEDIA_A },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST artefact-links: 403 for viewer role', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/activities/${ACTIVITY_A_OPEN}/artefact-links`,
    cookies: { cpa_session: await viewerJwt() },
    payload: { artefact_kind: 'media', artefact_id: MEDIA_A },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('POST artefact-links: 400 on invalid body (missing artefact_id)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/activities/${ACTIVITY_A_OPEN}/artefact-links`,
    cookies: { cpa_session: await consultantJwt() },
    payload: { artefact_kind: 'media' },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST artefact-links: 400 on invalid body (extra key)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/activities/${ACTIVITY_A_OPEN}/artefact-links`,
    cookies: { cpa_session: await consultantJwt() },
    payload: {
      artefact_kind: 'media',
      artefact_id: MEDIA_A,
      not_a_real_key: true,
    },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST artefact-links: 400 on unknown artefact_kind', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/activities/${ACTIVITY_A_OPEN}/artefact-links`,
    cookies: { cpa_session: await consultantJwt() },
    payload: { artefact_kind: 'invoice', artefact_id: EXPENDITURE_A },
  });
  // 'invoice' isn't in the artefactKind enum (we use 'expenditure'); rejected.
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST artefact-links: 201 + ARTEFACT_LINKED event for media kind', async () => {
  await clearLinkEvents(ACTIVITY_A_OPEN);
  try {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/activities/${ACTIVITY_A_OPEN}/artefact-links`,
      cookies: { cpa_session: await consultantJwt() },
      payload: {
        artefact_kind: 'media',
        artefact_id: MEDIA_A,
        link_reason: 'photo of the test rig',
      },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json<{
      event_id: string;
      activity_id: string;
      artefact_kind: string;
      artefact_id: string;
      link_reason: string | null;
    }>();
    assert.equal(body.activity_id, ACTIVITY_A_OPEN);
    assert.equal(body.artefact_kind, 'media');
    assert.equal(body.artefact_id, MEDIA_A);
    assert.equal(body.link_reason, 'photo of the test rig');

    // Verify the event landed with the expected payload shape.
    const eventRows = await privilegedSql<
      {
        kind: string;
        payload: {
          activity_id: string;
          artefact_kind: string;
          artefact_id: string;
          link_reason?: string;
        };
      }[]
    >`
      SELECT kind, payload FROM event WHERE id = ${body.event_id}
    `;
    assert.equal(eventRows.length, 1);
    assert.equal(eventRows[0]?.kind, 'ARTEFACT_LINKED');
    assert.equal(eventRows[0]?.payload.artefact_kind, 'media');
    assert.equal(eventRows[0]?.payload.artefact_id, MEDIA_A);
    assert.equal(eventRows[0]?.payload.link_reason, 'photo of the test rig');
    await app.close();
  } finally {
    await clearLinkEvents(ACTIVITY_A_OPEN);
  }
});

test('POST artefact-links: 201 for event kind (no link_reason)', async () => {
  await clearLinkEvents(ACTIVITY_A_OPEN);
  try {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/activities/${ACTIVITY_A_OPEN}/artefact-links`,
      cookies: { cpa_session: await consultantJwt() },
      payload: { artefact_kind: 'event', artefact_id: EVENT_ARTEFACT_A },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json<{ artefact_kind: string; link_reason: string | null }>();
    assert.equal(body.artefact_kind, 'event');
    assert.equal(body.link_reason, null);
    await app.close();
  } finally {
    await clearLinkEvents(ACTIVITY_A_OPEN);
  }
});

test('POST artefact-links: 201 for expenditure kind', async () => {
  await clearLinkEvents(ACTIVITY_A_OPEN);
  try {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/activities/${ACTIVITY_A_OPEN}/artefact-links`,
      cookies: { cpa_session: await consultantJwt() },
      payload: { artefact_kind: 'expenditure', artefact_id: EXPENDITURE_A },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json<{ artefact_kind: string }>();
    assert.equal(body.artefact_kind, 'expenditure');
    await app.close();
  } finally {
    await clearLinkEvents(ACTIVITY_A_OPEN);
  }
});

test('POST artefact-links: 201 for time_entry kind', async () => {
  await clearLinkEvents(ACTIVITY_A_OPEN);
  try {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/activities/${ACTIVITY_A_OPEN}/artefact-links`,
      cookies: { cpa_session: await consultantJwt() },
      payload: { artefact_kind: 'time_entry', artefact_id: TIME_ENTRY_A },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json<{ artefact_kind: string }>();
    assert.equal(body.artefact_kind, 'time_entry');
    await app.close();
  } finally {
    await clearLinkEvents(ACTIVITY_A_OPEN);
  }
});

test('POST artefact-links: 404 cross-firm activity_id', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/activities/${ACTIVITY_B_OPEN}/artefact-links`,
    cookies: { cpa_session: await adminJwt() }, // session in firm A
    payload: { artefact_kind: 'media', artefact_id: MEDIA_A },
  });
  assert.equal(res.statusCode, 404);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'activity_not_found');
  await app.close();
});

test('POST artefact-links: 404 cross-firm artefact_id (firm-A activity, firm-B media)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/activities/${ACTIVITY_A_OPEN}/artefact-links`,
    cookies: { cpa_session: await adminJwt() },
    payload: { artefact_kind: 'media', artefact_id: MEDIA_B },
  });
  assert.equal(res.statusCode, 404);
  const body = res.json<{ error: string; kind: string; artefact_id: string }>();
  assert.equal(body.error, 'artefact_not_found');
  assert.equal(body.kind, 'media');
  assert.equal(body.artefact_id, MEDIA_B);
  await app.close();
});

test('POST artefact-links: 404 cross-firm artefact_id (event kind)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/activities/${ACTIVITY_A_OPEN}/artefact-links`,
    cookies: { cpa_session: await adminJwt() },
    payload: { artefact_kind: 'event', artefact_id: EVENT_ARTEFACT_B },
  });
  assert.equal(res.statusCode, 404);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'artefact_not_found');
  await app.close();
});

test('POST artefact-links: 404 cross-firm artefact_id (expenditure kind)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/activities/${ACTIVITY_A_OPEN}/artefact-links`,
    cookies: { cpa_session: await adminJwt() },
    payload: { artefact_kind: 'expenditure', artefact_id: EXPENDITURE_B },
  });
  assert.equal(res.statusCode, 404);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'artefact_not_found');
  await app.close();
});

test('POST artefact-links: 404 cross-firm artefact_id (time_entry kind)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/activities/${ACTIVITY_A_OPEN}/artefact-links`,
    cookies: { cpa_session: await adminJwt() },
    payload: { artefact_kind: 'time_entry', artefact_id: TIME_ENTRY_B },
  });
  assert.equal(res.statusCode, 404);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'artefact_not_found');
  await app.close();
});

test('POST artefact-links: 409 on locked claim (audit_defence)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/activities/${ACTIVITY_A_LOCKED}/artefact-links`,
    cookies: { cpa_session: await consultantJwt() },
    payload: { artefact_kind: 'media', artefact_id: MEDIA_A },
  });
  assert.equal(res.statusCode, 409);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'claim_locked');
  await app.close();
});

test('POST artefact-links: positive-control — firm-B session can link firm-B media to firm-B activity', async () => {
  await privilegedSql`
    DELETE FROM event
     WHERE kind IN ('ARTEFACT_LINKED', 'ARTEFACT_UNLINKED')
       AND payload ->> 'activity_id' = ${ACTIVITY_B_OPEN}
  `;
  try {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/activities/${ACTIVITY_B_OPEN}/artefact-links`,
      cookies: { cpa_session: await tenantBAdminJwt() },
      payload: { artefact_kind: 'media', artefact_id: MEDIA_B },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json<{ artefact_id: string; activity_id: string }>();
    assert.equal(body.artefact_id, MEDIA_B);
    assert.equal(body.activity_id, ACTIVITY_B_OPEN);
    await app.close();
  } finally {
    await privilegedSql`
      DELETE FROM event
       WHERE kind IN ('ARTEFACT_LINKED', 'ARTEFACT_UNLINKED')
         AND payload ->> 'activity_id' = ${ACTIVITY_B_OPEN}
    `;
  }
});

// =============================================================================
// DELETE /v1/activities/:id/artefact-links/:event_id
// =============================================================================

test('DELETE artefact-links: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'DELETE',
    url: `/v1/activities/${ACTIVITY_A_OPEN}/artefact-links/${crypto.randomUUID()}`,
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('DELETE artefact-links: 403 for viewer role', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'DELETE',
    url: `/v1/activities/${ACTIVITY_A_OPEN}/artefact-links/${crypto.randomUUID()}`,
    cookies: { cpa_session: await viewerJwt() },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('DELETE artefact-links: 200 + ARTEFACT_UNLINKED event written', async () => {
  await clearLinkEvents(ACTIVITY_A_OPEN);
  try {
    const app = buildApp();
    // First, link.
    const linkRes = await app.inject({
      method: 'POST',
      url: `/v1/activities/${ACTIVITY_A_OPEN}/artefact-links`,
      cookies: { cpa_session: await consultantJwt() },
      payload: { artefact_kind: 'media', artefact_id: MEDIA_A, link_reason: 'first link' },
    });
    assert.equal(linkRes.statusCode, 201);
    const linkBody = linkRes.json<{ event_id: string }>();

    // Then, unlink.
    const unlinkRes = await app.inject({
      method: 'DELETE',
      url: `/v1/activities/${ACTIVITY_A_OPEN}/artefact-links/${linkBody.event_id}`,
      cookies: { cpa_session: await consultantJwt() },
      payload: { reason: 'wrong activity' },
    });
    assert.equal(unlinkRes.statusCode, 200);
    const unlinkBody = unlinkRes.json<{
      unlinked_event_id: string;
      prior_event_id: string;
      activity_id: string;
      artefact_kind: string;
      artefact_id: string;
    }>();
    assert.equal(unlinkBody.prior_event_id, linkBody.event_id);
    assert.equal(unlinkBody.activity_id, ACTIVITY_A_OPEN);
    assert.equal(unlinkBody.artefact_kind, 'media');
    assert.equal(unlinkBody.artefact_id, MEDIA_A);

    // Verify the original LINKED event still exists (append-only).
    const linkedRows = await privilegedSql<{ id: string }[]>`
      SELECT id FROM event WHERE id = ${linkBody.event_id}
    `;
    assert.equal(linkedRows.length, 1, 'original LINKED event must NOT be deleted');

    // Verify a new UNLINKED event exists with the matching payload.
    const unlinkedRows = await privilegedSql<
      {
        kind: string;
        payload: {
          activity_id: string;
          artefact_kind: string;
          artefact_id: string;
          reason?: string;
        };
      }[]
    >`
      SELECT kind, payload FROM event WHERE id = ${unlinkBody.unlinked_event_id}
    `;
    assert.equal(unlinkedRows.length, 1);
    assert.equal(unlinkedRows[0]?.kind, 'ARTEFACT_UNLINKED');
    assert.equal(unlinkedRows[0]?.payload.activity_id, ACTIVITY_A_OPEN);
    assert.equal(unlinkedRows[0]?.payload.artefact_id, MEDIA_A);
    assert.equal(unlinkedRows[0]?.payload.reason, 'wrong activity');
    await app.close();
  } finally {
    await clearLinkEvents(ACTIVITY_A_OPEN);
  }
});

test('DELETE artefact-links: 200 with no body (reason omitted)', async () => {
  await clearLinkEvents(ACTIVITY_A_OPEN);
  try {
    const app = buildApp();
    const linkRes = await app.inject({
      method: 'POST',
      url: `/v1/activities/${ACTIVITY_A_OPEN}/artefact-links`,
      cookies: { cpa_session: await consultantJwt() },
      payload: { artefact_kind: 'media', artefact_id: MEDIA_A },
    });
    const linkBody = linkRes.json<{ event_id: string }>();

    const unlinkRes = await app.inject({
      method: 'DELETE',
      url: `/v1/activities/${ACTIVITY_A_OPEN}/artefact-links/${linkBody.event_id}`,
      cookies: { cpa_session: await consultantJwt() },
    });
    assert.equal(unlinkRes.statusCode, 200);
    await app.close();
  } finally {
    await clearLinkEvents(ACTIVITY_A_OPEN);
  }
});

test('DELETE artefact-links: 400 on invalid body (extra key)', async () => {
  await clearLinkEvents(ACTIVITY_A_OPEN);
  try {
    const app = buildApp();
    const linkRes = await app.inject({
      method: 'POST',
      url: `/v1/activities/${ACTIVITY_A_OPEN}/artefact-links`,
      cookies: { cpa_session: await consultantJwt() },
      payload: { artefact_kind: 'media', artefact_id: MEDIA_A },
    });
    const linkBody = linkRes.json<{ event_id: string }>();

    const unlinkRes = await app.inject({
      method: 'DELETE',
      url: `/v1/activities/${ACTIVITY_A_OPEN}/artefact-links/${linkBody.event_id}`,
      cookies: { cpa_session: await consultantJwt() },
      payload: { reason: 'ok', not_a_real_key: true },
    });
    assert.equal(unlinkRes.statusCode, 400);
    await app.close();
  } finally {
    await clearLinkEvents(ACTIVITY_A_OPEN);
  }
});

test('DELETE artefact-links: 404 when original event does not exist', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'DELETE',
    url: `/v1/activities/${ACTIVITY_A_OPEN}/artefact-links/${crypto.randomUUID()}`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(res.statusCode, 404);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'linked_event_not_found');
  await app.close();
});

test('DELETE artefact-links: 404 cross-firm activity_id', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'DELETE',
    url: `/v1/activities/${ACTIVITY_B_OPEN}/artefact-links/${crypto.randomUUID()}`,
    cookies: { cpa_session: await adminJwt() }, // firm A session
  });
  assert.equal(res.statusCode, 404);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'activity_not_found');
  await app.close();
});

test('DELETE artefact-links: 409 if already unlinked (subsequent UNLINKED exists)', async () => {
  await clearLinkEvents(ACTIVITY_A_OPEN);
  try {
    const app = buildApp();
    const linkRes = await app.inject({
      method: 'POST',
      url: `/v1/activities/${ACTIVITY_A_OPEN}/artefact-links`,
      cookies: { cpa_session: await consultantJwt() },
      payload: { artefact_kind: 'media', artefact_id: MEDIA_A },
    });
    const linkBody = linkRes.json<{ event_id: string }>();

    // First unlink → 200.
    const firstUnlink = await app.inject({
      method: 'DELETE',
      url: `/v1/activities/${ACTIVITY_A_OPEN}/artefact-links/${linkBody.event_id}`,
      cookies: { cpa_session: await consultantJwt() },
    });
    assert.equal(firstUnlink.statusCode, 200);

    // Second unlink against the same event_id → 409 (already unlinked).
    const secondUnlink = await app.inject({
      method: 'DELETE',
      url: `/v1/activities/${ACTIVITY_A_OPEN}/artefact-links/${linkBody.event_id}`,
      cookies: { cpa_session: await consultantJwt() },
    });
    assert.equal(secondUnlink.statusCode, 409);
    const body = secondUnlink.json<{ error: string }>();
    assert.equal(body.error, 'already_unlinked');
    await app.close();
  } finally {
    await clearLinkEvents(ACTIVITY_A_OPEN);
  }
});

test('DELETE artefact-links: 409 on locked claim (audit_defence)', async () => {
  // Seed a LINKED event directly under the locked activity so the DELETE
  // fails at the stage gate (not at the linked-event lookup). We sidestep
  // the chain helper for the fixture — verifyChain isn't run here.
  const FIXTURE_LINKED = '00000000-0000-4000-8000-0000000a4081';
  await privilegedSql`
    INSERT INTO event (
      id, tenant_id, subject_tenant_id, project_id, kind, payload,
      prev_hash, hash, captured_at, captured_by_user_id
    ) VALUES (
      ${FIXTURE_LINKED}, ${TENANT_A}, ${SUBJECT_A1}, ${PROJECT_A_OPEN}, 'ARTEFACT_LINKED',
      ${JSON.stringify({
        activity_id: ACTIVITY_A_LOCKED,
        artefact_kind: 'media',
        artefact_id: MEDIA_A,
      })}::jsonb,
      NULL, ${'a4'.padEnd(64, 'c')},
      '2026-04-01T11:00:00Z'::timestamptz, ${ADMIN_USER}
    )
  `;
  try {
    const app = buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/activities/${ACTIVITY_A_LOCKED}/artefact-links/${FIXTURE_LINKED}`,
      cookies: { cpa_session: await consultantJwt() },
    });
    assert.equal(res.statusCode, 409);
    const body = res.json<{ error: string }>();
    assert.equal(body.error, 'claim_locked');
    await app.close();
  } finally {
    await privilegedSql`DELETE FROM event WHERE id = ${FIXTURE_LINKED}`;
  }
});

// =============================================================================
// getActivityArtefacts helper — LINKED minus subsequent UNLINKED
// =============================================================================

test('helper getActivityArtefacts: returns currently-linked artefacts (LINKED only)', async () => {
  await clearLinkEvents(ACTIVITY_A_OPEN);
  try {
    const app = buildApp();
    // Link three artefacts of different kinds.
    const r1 = await app.inject({
      method: 'POST',
      url: `/v1/activities/${ACTIVITY_A_OPEN}/artefact-links`,
      cookies: { cpa_session: await consultantJwt() },
      payload: { artefact_kind: 'media', artefact_id: MEDIA_A, link_reason: 'photo' },
    });
    assert.equal(r1.statusCode, 201);
    const r2 = await app.inject({
      method: 'POST',
      url: `/v1/activities/${ACTIVITY_A_OPEN}/artefact-links`,
      cookies: { cpa_session: await consultantJwt() },
      payload: { artefact_kind: 'expenditure', artefact_id: EXPENDITURE_A },
    });
    assert.equal(r2.statusCode, 201);
    const r3 = await app.inject({
      method: 'POST',
      url: `/v1/activities/${ACTIVITY_A_OPEN}/artefact-links`,
      cookies: { cpa_session: await consultantJwt() },
      payload: { artefact_kind: 'time_entry', artefact_id: TIME_ENTRY_A },
    });
    assert.equal(r3.statusCode, 201);

    const live = await getActivityArtefacts(ACTIVITY_A_OPEN, { tenantId: TENANT_A });
    assert.equal(live.length, 3);
    const ids = live.map((a) => a.artefact_id).sort();
    assert.deepEqual(ids, [MEDIA_A, EXPENDITURE_A, TIME_ENTRY_A].sort());
    const mediaEntry = live.find((a) => a.artefact_kind === 'media');
    assert.equal(mediaEntry?.link_reason, 'photo');
    await app.close();
  } finally {
    await clearLinkEvents(ACTIVITY_A_OPEN);
  }
});

test('helper getActivityArtefacts: subsequent UNLINKED removes the artefact from the live set', async () => {
  await clearLinkEvents(ACTIVITY_A_OPEN);
  try {
    const app = buildApp();
    const linkRes = await app.inject({
      method: 'POST',
      url: `/v1/activities/${ACTIVITY_A_OPEN}/artefact-links`,
      cookies: { cpa_session: await consultantJwt() },
      payload: { artefact_kind: 'media', artefact_id: MEDIA_A },
    });
    assert.equal(linkRes.statusCode, 201);

    // Pre-unlink: live set contains MEDIA_A.
    const before = await getActivityArtefacts(ACTIVITY_A_OPEN, { tenantId: TENANT_A });
    assert.equal(before.length, 1);
    assert.equal(before[0]?.artefact_id, MEDIA_A);

    // Unlink.
    const linkBody = linkRes.json<{ event_id: string }>();
    const unlinkRes = await app.inject({
      method: 'DELETE',
      url: `/v1/activities/${ACTIVITY_A_OPEN}/artefact-links/${linkBody.event_id}`,
      cookies: { cpa_session: await consultantJwt() },
    });
    assert.equal(unlinkRes.statusCode, 200);

    // Post-unlink: live set is empty.
    const after = await getActivityArtefacts(ACTIVITY_A_OPEN, { tenantId: TENANT_A });
    assert.equal(after.length, 0);
    await app.close();
  } finally {
    await clearLinkEvents(ACTIVITY_A_OPEN);
  }
});

test('helper getActivityArtefacts: re-link (LINKED → UNLINKED → LINKED) leaves the artefact visible', async () => {
  await clearLinkEvents(ACTIVITY_A_OPEN);
  try {
    const app = buildApp();
    // First link.
    const r1 = await app.inject({
      method: 'POST',
      url: `/v1/activities/${ACTIVITY_A_OPEN}/artefact-links`,
      cookies: { cpa_session: await consultantJwt() },
      payload: { artefact_kind: 'media', artefact_id: MEDIA_A, link_reason: 'first' },
    });
    const r1Body = r1.json<{ event_id: string }>();

    // Unlink.
    await app.inject({
      method: 'DELETE',
      url: `/v1/activities/${ACTIVITY_A_OPEN}/artefact-links/${r1Body.event_id}`,
      cookies: { cpa_session: await consultantJwt() },
    });

    // Second link (re-link).
    const r2 = await app.inject({
      method: 'POST',
      url: `/v1/activities/${ACTIVITY_A_OPEN}/artefact-links`,
      cookies: { cpa_session: await consultantJwt() },
      payload: { artefact_kind: 'media', artefact_id: MEDIA_A, link_reason: 'second' },
    });
    assert.equal(r2.statusCode, 201);
    const r2Body = r2.json<{ event_id: string }>();

    const live = await getActivityArtefacts(ACTIVITY_A_OPEN, { tenantId: TENANT_A });
    assert.equal(live.length, 1, 're-linked artefact should be visible');
    // The visible row should reference the SECOND linked event, not the first.
    assert.equal(live[0]?.linked_event_id, r2Body.event_id);
    assert.equal(live[0]?.link_reason, 'second');
    await app.close();
  } finally {
    await clearLinkEvents(ACTIVITY_A_OPEN);
  }
});

test('helper getActivityArtefacts: events for a different activity are excluded', async () => {
  // Seed a LINKED event under ACTIVITY_A_LOCKED (different activity in
  // same tenant) and assert the helper for ACTIVITY_A_OPEN doesn't see it.
  await clearLinkEvents(ACTIVITY_A_OPEN);
  await clearLinkEvents(ACTIVITY_A_LOCKED);
  const FIXTURE_LINKED_FOR_LOCKED = '00000000-0000-4000-8000-0000000a4082';
  // NOTE: pass the object directly to postgres-js (no JSON.stringify, no
  // ::jsonb cast). postgres-js auto-encodes objects as JSON when the
  // target column is jsonb. The previous form `${JSON.stringify(obj)}::jsonb`
  // double-encoded — the JSON-string was bound as a TEXT param, then ::jsonb
  // cast it as a jsonb scalar STRING (not an OBJECT). `payload->>'activity_id'`
  // then returned NULL because `->>'key'` only extracts from objects.
  // Confirmed via PR #4 CI diagnostic on test #153 (run 25126567751).
  await privilegedSql`
    INSERT INTO event (
      id, tenant_id, subject_tenant_id, project_id, kind, payload,
      prev_hash, hash, captured_at, captured_by_user_id
    ) VALUES (
      ${FIXTURE_LINKED_FOR_LOCKED}, ${TENANT_A}, ${SUBJECT_A1}, ${PROJECT_A_OPEN},
      'ARTEFACT_LINKED',
      ${{
        activity_id: ACTIVITY_A_LOCKED,
        artefact_kind: 'media',
        artefact_id: MEDIA_A,
      }},
      NULL, ${'a4'.padEnd(64, 'd')},
      '2026-04-01T12:00:00Z'::timestamptz, ${ADMIN_USER}
    )
  `;
  try {
    const app = buildApp();
    // Link one artefact under ACTIVITY_A_OPEN — getActivityArtefacts for
    // ACTIVITY_A_OPEN should return that one and NOT the one under
    // ACTIVITY_A_LOCKED.
    const linkRes = await app.inject({
      method: 'POST',
      url: `/v1/activities/${ACTIVITY_A_OPEN}/artefact-links`,
      cookies: { cpa_session: await consultantJwt() },
      payload: { artefact_kind: 'expenditure', artefact_id: EXPENDITURE_A },
    });
    assert.equal(linkRes.statusCode, 201);

    const liveForOpen = await getActivityArtefacts(ACTIVITY_A_OPEN, { tenantId: TENANT_A });
    assert.equal(liveForOpen.length, 1);
    assert.equal(liveForOpen[0]?.artefact_kind, 'expenditure');
    assert.equal(liveForOpen[0]?.artefact_id, EXPENDITURE_A);

    const liveForLocked = await getActivityArtefacts(ACTIVITY_A_LOCKED, { tenantId: TENANT_A });
    assert.equal(liveForLocked.length, 1);
    assert.equal(liveForLocked[0]?.artefact_id, MEDIA_A);
    await app.close();
  } finally {
    await clearLinkEvents(ACTIVITY_A_OPEN);
    await clearLinkEvents(ACTIVITY_A_LOCKED);
  }
});
