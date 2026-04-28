import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { signSession } from '@cpa/auth';
import { insertEventWithChain } from '@cpa/db';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../app.js';

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

// Per-test UUID prefixes — `0000a8XXXX` is the T-A8 namespace (P4
// Swimlane A, Task 8, activity-application PDF). Disjoint from
// the other A-swimlane test IDs so parallel test runs don't collide.
const TENANT_A = '00000000-0000-4000-8000-0000000a8001';
const TENANT_B = '00000000-0000-4000-8000-0000000a8002';
const ADMIN_USER = '00000000-0000-4000-8000-0000000a8010';
const VIEWER_USER = '00000000-0000-4000-8000-0000000a8011';
const TENANT_B_ADMIN = '00000000-0000-4000-8000-0000000a8012';
const SUBJECT_A1 = '00000000-0000-4000-8000-0000000a8021';
const SUBJECT_B1 = '00000000-0000-4000-8000-0000000a8022';
const PROJECT_A = '00000000-0000-4000-8000-0000000a8031';
const PROJECT_B = '00000000-0000-4000-8000-0000000a8032';
const CLAIM_A = '00000000-0000-4000-8000-0000000a8041';
const CLAIM_B = '00000000-0000-4000-8000-0000000a8042';
const ACTIVITY_A = '00000000-0000-4000-8000-0000000a8051';
const ACTIVITY_B = '00000000-0000-4000-8000-0000000a8052';
const NONEXISTENT_ID = '00000000-0000-4000-8000-0000000a80ff';

const cleanup = async (): Promise<void> => {
  await privilegedSql`
    DELETE FROM event WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})
  `;
  await privilegedSql`DELETE FROM activity WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM claim WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM project WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM subject_tenant_user WHERE subject_tenant_id IN (
    SELECT id FROM subject_tenant WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})
  )`;
  await privilegedSql`DELETE FROM subject_tenant WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await sql`DELETE FROM "user" WHERE id IN (${ADMIN_USER}, ${VIEWER_USER}, ${TENANT_B_ADMIN})`;
  await sql`DELETE FROM tenant WHERE id IN (${TENANT_A}, ${TENANT_B})`;
};

before(async () => {
  await cleanup();
  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT_A}, 'A8 Firm Alpha', 'firm-alpha-a8', 'mixed'),
                   (${TENANT_B}, 'A8 Firm Beta', 'firm-beta-a8', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${ADMIN_USER}, 'a8-admin@example.com', 'microsoft', 'microsoft:a8-admin', 'A8 Admin'),
                   (${VIEWER_USER}, 'a8-viewer@example.com', 'microsoft', 'microsoft:a8-viewer', 'A8 Viewer'),
                   (${TENANT_B_ADMIN}, 'a8-admin-b@example.com', 'microsoft', 'microsoft:a8-admin-b', 'A8 Admin (Firm B)')`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT_A}, ${ADMIN_USER}, 'admin', true),
                              (gen_random_uuid(), ${TENANT_A}, ${VIEWER_USER}, 'viewer', true),
                              (gen_random_uuid(), ${TENANT_B}, ${TENANT_B_ADMIN}, 'admin', true)`;
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                       VALUES (${SUBJECT_A1}, ${TENANT_A}, 'A8 Acme Pty Ltd', 'claimant'),
                              (${SUBJECT_B1}, ${TENANT_B}, 'A8 Other Co', 'claimant')`;
  await privilegedSql`
    INSERT INTO project (id, tenant_id, subject_tenant_id, name, description, started_at)
    VALUES
      (${PROJECT_A}, ${TENANT_A}, ${SUBJECT_A1}, 'A8 Project Alpha',
       'Catalyst longevity research project',
       '2026-01-01T00:00:00Z'::timestamptz),
      (${PROJECT_B}, ${TENANT_B}, ${SUBJECT_B1}, 'A8 Project Beta',
       'Other-firm project (cross-firm test fixture)',
       '2026-01-01T00:00:00Z'::timestamptz)
  `;
  await privilegedSql`
    INSERT INTO claim (id, tenant_id, subject_tenant_id, fiscal_year, stage)
    VALUES
      (${CLAIM_A}, ${TENANT_A}, ${SUBJECT_A1}, 2027, 'narrative_drafting'),
      (${CLAIM_B}, ${TENANT_B}, ${SUBJECT_B1}, 2027, 'engagement')
  `;
  await privilegedSql`
    INSERT INTO activity (id, tenant_id, project_id, claim_id, code, kind, title,
                          description, hypothesis, technical_uncertainty,
                          expected_outcome, actual_outcome)
    VALUES
      (${ACTIVITY_A}, ${TENANT_A}, ${PROJECT_A}, ${CLAIM_A},
       'CA-001', 'core', 'Catalyst longevity test',
       'Bench-test the proprietary catalyst formulation.',
       'Catalyst will retain >85% activity at 200 hours.',
       'No published longevity data for this catalyst class.',
       'Establish whether the catalyst meets the design target.',
       'Confirmed degradation mechanism is sintering-driven.'),
      (${ACTIVITY_B}, ${TENANT_B}, ${PROJECT_B}, ${CLAIM_B},
       'CA-001', 'core', 'B-firm activity', null, null, null, null, null)
  `;

  // Seed an ARTEFACT_LINKED + an UNCERTAINTY event so the PDF has
  // non-empty artefact + register sections to render.
  await insertEventWithChain({
    tenant_id: TENANT_A,
    subject_tenant_id: SUBJECT_A1,
    project_id: PROJECT_A,
    kind: 'ARTEFACT_LINKED',
    payload: {
      activity_id: ACTIVITY_A,
      artefact_kind: 'media',
      artefact_id: '00000000-0000-4000-8000-0000000a8aa1',
      link_reason: 'baseline configuration',
    },
    classification: null,
    captured_at: new Date('2026-02-05T10:00:00Z'),
    captured_by_user_id: ADMIN_USER,
    override_of_event_id: null,
    override_new_kind: null,
    override_reason: null,
  });
  await insertEventWithChain({
    tenant_id: TENANT_A,
    subject_tenant_id: SUBJECT_A1,
    project_id: PROJECT_A,
    kind: 'HYPOTHESIS',
    payload: {
      activity_id: ACTIVITY_A,
      raw_text: 'Catalyst will retain >85% activity at 200 hours.',
    },
    classification: {
      kind: 'HYPOTHESIS',
      confidence: 0.92,
      rationale: 'Direct match to hypothesis kind.',
      statutory_anchor: null,
      model: 'stub',
      prompt_version: 'classify@1.0.0',
      tokens_in: 0,
      tokens_out: 0,
    },
    captured_at: new Date('2026-02-01T09:00:00Z'),
    captured_by_user_id: ADMIN_USER,
    override_of_event_id: null,
    override_new_kind: null,
    override_reason: null,
  });
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

const adminJwt = (): Promise<string> => jwtFor(ADMIN_USER, 'a8-admin@example.com', 'admin');
const viewerJwt = (): Promise<string> => jwtFor(VIEWER_USER, 'a8-viewer@example.com', 'viewer');
const tenantBAdminJwt = (): Promise<string> =>
  jwtFor(TENANT_B_ADMIN, 'a8-admin-b@example.com', 'admin', TENANT_B);

// ---------------------------------------------------------------------------
// GET /v1/activities/:id/application.pdf
// ---------------------------------------------------------------------------

test('GET /v1/activities/:id/application.pdf: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/activities/${ACTIVITY_A}/application.pdf`,
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('GET /v1/activities/:id/application.pdf: 200 happy path streams a valid PDF', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/activities/${ACTIVITY_A}/application.pdf`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  // Filename includes both code + fiscal year per spec; matches the
  // suggested suffix `activity-CA-001-2027.pdf`.
  assert.match(
    String(res.headers['content-disposition'] ?? ''),
    /attachment; filename="activity-CA-001-2027\.pdf"/,
    'content-disposition should include the suggested filename',
  );
  // Audit-mode caching — the PDF reflects current state and must NOT
  // be stored by intermediates (regulator wants the latest data).
  assert.equal(res.headers['cache-control'], 'private, no-store');

  // Buffer the body and verify the magic bytes.
  const body = res.rawPayload;
  assert.ok(body instanceof Uint8Array || Buffer.isBuffer(body), 'response body is binary');
  assert.ok(body.byteLength > 1000, `PDF should be >1KB; got ${body.byteLength}`);
  const magic = Buffer.from(body.subarray(0, 5)).toString('utf8');
  assert.equal(magic, '%PDF-', `expected %PDF- magic; got ${magic}`);
  await app.close();
});

test('GET /v1/activities/:id/application.pdf: 200 for viewer (read-only role can download)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/activities/${ACTIVITY_A}/application.pdf`,
    cookies: { cpa_session: await viewerJwt() },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  await app.close();
});

test('GET /v1/activities/:id/application.pdf: 404 for nonexistent activity', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/activities/${NONEXISTENT_ID}/application.pdf`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 404);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'activity_not_found');
  await app.close();
});

test('GET /v1/activities/:id/application.pdf: 404 for cross-firm activity (RLS positive control)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/activities/${ACTIVITY_B}/application.pdf`,
    cookies: { cpa_session: await adminJwt() }, // Tenant-A session
  });
  assert.equal(res.statusCode, 404);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'activity_not_found');

  // Positive control: the same row IS visible from a tenant-B session,
  // so 404 above is RLS-driven, not a missing-row mistake.
  const positive = await app.inject({
    method: 'GET',
    url: `/v1/activities/${ACTIVITY_B}/application.pdf`,
    cookies: { cpa_session: await tenantBAdminJwt() },
  });
  assert.equal(positive.statusCode, 200);
  assert.equal(positive.headers['content-type'], 'application/pdf');
  await app.close();
});

test('GET /v1/activities/:id/application.pdf: PDF includes full ascii %PDF- magic and trailer', async () => {
  // A more complete byte-level sanity check than the happy-path test —
  // verifies the body is a valid (well-framed) PDF, not just a buffer
  // that starts with the right bytes.
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/activities/${ACTIVITY_A}/application.pdf`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.rawPayload;
  // %PDF- magic.
  assert.equal(Buffer.from(body.subarray(0, 5)).toString('utf8'), '%PDF-');
  // %%EOF trailer.
  const tail = Buffer.from(body.subarray(body.byteLength - 16)).toString('utf8');
  assert.ok(tail.includes('%%EOF'), `expected %%EOF trailer; got: ${tail}`);
  await app.close();
});
