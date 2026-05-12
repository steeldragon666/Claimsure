/**
 * Tests for POST /v1/claims/:claim_id/narrative/sections/:section_kind/accept.
 *
 * Fixture prefix `c67xx` keeps these disjoint from claim-workflow's c66xx
 * and narrative.test.ts's c55xx.
 *
 * The route flips `narrative_draft.status` from 'complete' to 'accepted'
 * for ALL drafts of one section_kind under any activity in the claim.
 * Tests exercise:
 *   - auth (401), role gate (403 viewer)
 *   - param validation (400 non-UUID claim, 400 bad section_kind)
 *   - cross-firm isolation (404 via RLS)
 *   - happy path (count > 0)
 *   - idempotency (re-call returns count=0)
 *   - status discipline (streaming + archived rows untouched)
 *   - workflow integration: canAdvance(4) flips when all 4 sections
 *     accepted across the claim's activities
 */

import { test, after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { signSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../app.js';

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

// c67xx — narrative-accept route batch. Disjoint from c66 (claim-workflow)
// and c55 (narrative).
const TENANT_A = '00000000-0000-4000-8000-0000000c6701';
const TENANT_B = '00000000-0000-4000-8000-0000000c6702';
const ADMIN_USER = '00000000-0000-4000-8000-0000000c6710';
const VIEWER_USER = '00000000-0000-4000-8000-0000000c6711';
const CONSULTANT_USER = '00000000-0000-4000-8000-0000000c6712';
const TENANT_B_ADMIN = '00000000-0000-4000-8000-0000000c6713';

const SUBJECT_A = '00000000-0000-4000-8000-0000000c6720';
const SUBJECT_B = '00000000-0000-4000-8000-0000000c6721';
const PROJECT_A = '00000000-0000-4000-8000-0000000c6730';
const PROJECT_B = '00000000-0000-4000-8000-0000000c6731';
const CLAIM_A = '00000000-0000-4000-8000-0000000c6740';
const CLAIM_B = '00000000-0000-4000-8000-0000000c6741';
const CLAIM_UNKNOWN = '00000000-0000-4000-8000-0000000c67ff';

const ACTIVITY_A1 = '00000000-0000-4000-8000-0000000c6750';
const ACTIVITY_A2 = '00000000-0000-4000-8000-0000000c6751';

const SECTION_KINDS = [
  'new_knowledge',
  'hypothesis',
  'uncertainty',
  'experiments_and_results',
] as const;
type SectionKind = (typeof SECTION_KINDS)[number];

const cleanup = async (): Promise<void> => {
  await privilegedSql`DELETE FROM narrative_draft_version WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM narrative_draft WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
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
            VALUES (${TENANT_A}, 'Firm C67A', 'firm-c67a', 'mixed'),
                   (${TENANT_B}, 'Firm C67B', 'firm-c67b', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${ADMIN_USER}, 'c67-admin@example.com', 'microsoft', 'microsoft:c67-admin', 'C67 Admin'),
                   (${VIEWER_USER}, 'c67-viewer@example.com', 'microsoft', 'microsoft:c67-viewer', 'C67 Viewer'),
                   (${CONSULTANT_USER}, 'c67-cons@example.com', 'microsoft', 'microsoft:c67-cons', 'C67 Consultant'),
                   (${TENANT_B_ADMIN}, 'c67-admin-b@example.com', 'microsoft', 'microsoft:c67-admin-b', 'C67 Admin (Firm B)')`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT_A}, ${ADMIN_USER}, 'admin', true),
                              (gen_random_uuid(), ${TENANT_A}, ${VIEWER_USER}, 'viewer', true),
                              (gen_random_uuid(), ${TENANT_A}, ${CONSULTANT_USER}, 'consultant', true),
                              (gen_random_uuid(), ${TENANT_B}, ${TENANT_B_ADMIN}, 'admin', true)`;
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                       VALUES (${SUBJECT_A}, ${TENANT_A}, 'C67 Subject A', 'claimant'),
                              (${SUBJECT_B}, ${TENANT_B}, 'C67 Subject B', 'claimant')`;
  await privilegedSql`
    INSERT INTO project (id, tenant_id, subject_tenant_id, name, started_at)
    VALUES
      (${PROJECT_A}, ${TENANT_A}, ${SUBJECT_A}, 'C67 Project A',
       '2024-07-01T00:00:00Z'::timestamptz),
      (${PROJECT_B}, ${TENANT_B}, ${SUBJECT_B}, 'C67 Project B',
       '2024-07-01T00:00:00Z'::timestamptz)
  `;
});

beforeEach(async () => {
  // Reset per-test state. Claims and activities + narrative_drafts get
  // re-seeded fresh below to keep status assertions crisp.
  await privilegedSql`DELETE FROM narrative_draft_version WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM narrative_draft WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM event WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM activity WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM claim WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`
    INSERT INTO claim (id, tenant_id, subject_tenant_id, project_id, fiscal_year, stage, workflow_state)
    VALUES
      (${CLAIM_A}, ${TENANT_A}, ${SUBJECT_A}, ${PROJECT_A}, 2025, 'engagement', NULL),
      (${CLAIM_B}, ${TENANT_B}, ${SUBJECT_B}, ${PROJECT_B}, 2025, 'engagement', NULL)
  `;
  await privilegedSql`
    INSERT INTO activity (id, tenant_id, project_id, claim_id, code, kind, title,
                          fy_label, hypothesis_formed_at)
    VALUES
      (${ACTIVITY_A1}, ${TENANT_A}, ${PROJECT_A}, ${CLAIM_A}, 'CA-01', 'core', 'Activity 1',
       'FY25', '2025-01-01T00:00:00Z'),
      (${ACTIVITY_A2}, ${TENANT_A}, ${PROJECT_A}, ${CLAIM_A}, 'CA-02', 'supporting', 'Activity 2',
       'FY25', '2025-01-01T00:00:00Z')
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

const viewerJwt = (): Promise<string> => jwtFor(VIEWER_USER, 'c67-viewer@example.com', 'viewer');
const consultantJwt = (): Promise<string> =>
  jwtFor(CONSULTANT_USER, 'c67-cons@example.com', 'consultant');
const tenantBAdminJwt = (): Promise<string> =>
  jwtFor(TENANT_B_ADMIN, 'c67-admin-b@example.com', 'admin', TENANT_B);

/**
 * Seed one narrative_draft row.
 */
async function seedDraft(args: {
  tenantId: string;
  activityId: string;
  sectionKind: SectionKind;
  status: 'streaming' | 'complete' | 'accepted' | 'archived';
}): Promise<string> {
  const rows = await privilegedSql<{ id: string }[]>`
    INSERT INTO narrative_draft (
      tenant_id, id, activity_id, section_kind, current_version,
      status, segments, content_hash, model, prompt_version, created_by_user_id
    )
    VALUES (
      ${args.tenantId},
      gen_random_uuid(),
      ${args.activityId},
      ${args.sectionKind},
      1,
      ${args.status},
      ${JSON.stringify([{ type: 'prose', text: 'seed' }])}::jsonb,
      encode(digest('seed', 'sha256'), 'hex'),
      'test-model-v1',
      'test-prompt@1.0.0',
      ${CONSULTANT_USER}
    )
    RETURNING id
  `;
  return rows[0]!.id;
}

/** Read a draft's current status. */
async function getDraftStatus(id: string): Promise<string> {
  const rows = await privilegedSql<{ status: string }[]>`
    SELECT status FROM narrative_draft WHERE id = ${id}
  `;
  return rows[0]!.status;
}

// =============================================================================
// Auth + validation
// =============================================================================

test('POST /accept: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_A}/narrative/sections/new_knowledge/accept`,
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /accept: 403 for viewer role', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_A}/narrative/sections/new_knowledge/accept`,
    cookies: { cpa_session: await viewerJwt() },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('POST /accept: 400 on non-UUID claim_id', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/not-a-uuid/narrative/sections/new_knowledge/accept`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(res.statusCode, 400);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'invalid_claim_id');
  await app.close();
});

test('POST /accept: 400 on invalid section_kind', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_A}/narrative/sections/not_a_section/accept`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(res.statusCode, 400);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'invalid_section_kind');
  await app.close();
});

test('POST /accept: 404 cross-firm claim (RLS conceals it)', async () => {
  // Tenant B admin tries to accept on CLAIM_A (owned by Tenant A).
  // RLS hides the row; route reports claim_not_found.
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_A}/narrative/sections/new_knowledge/accept`,
    cookies: { cpa_session: await tenantBAdminJwt() },
  });
  assert.equal(res.statusCode, 404);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'claim_not_found');
  await app.close();
});

test('POST /accept: 404 on unknown claim id', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_UNKNOWN}/narrative/sections/new_knowledge/accept`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

// =============================================================================
// Happy path + idempotency
// =============================================================================

test('POST /accept: 200 happy path — updates rows + returns accepted_count > 0', async () => {
  // Two activities, both with a 'complete' draft for new_knowledge.
  // Accepting flips BOTH (claim-scoped semantics).
  const draftA1 = await seedDraft({
    tenantId: TENANT_A,
    activityId: ACTIVITY_A1,
    sectionKind: 'new_knowledge',
    status: 'complete',
  });
  const draftA2 = await seedDraft({
    tenantId: TENANT_A,
    activityId: ACTIVITY_A2,
    sectionKind: 'new_knowledge',
    status: 'complete',
  });

  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_A}/narrative/sections/new_knowledge/accept`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    accepted_count: number;
    accepted_at: string | null;
    accepted_by: string;
    activity_ids: string[];
  }>();
  assert.equal(body.accepted_count, 2);
  assert.ok(body.accepted_at && /^\d{4}-\d{2}-\d{2}T/.test(body.accepted_at));
  assert.equal(body.accepted_by, CONSULTANT_USER);
  assert.deepEqual(new Set(body.activity_ids), new Set([ACTIVITY_A1, ACTIVITY_A2]));

  assert.equal(await getDraftStatus(draftA1), 'accepted');
  assert.equal(await getDraftStatus(draftA2), 'accepted');
  await app.close();
});

test('POST /accept: 200 idempotent on already-accepted — returns accepted_count = 0', async () => {
  const draftA1 = await seedDraft({
    tenantId: TENANT_A,
    activityId: ACTIVITY_A1,
    sectionKind: 'hypothesis',
    status: 'complete',
  });

  const app = buildApp();
  // First call: flips one row.
  const first = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_A}/narrative/sections/hypothesis/accept`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json<{ accepted_count: number }>().accepted_count, 1);

  // Second call: no transition, count=0, accepted_at=null, ids=[].
  const second = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_A}/narrative/sections/hypothesis/accept`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(second.statusCode, 200);
  const body = second.json<{
    accepted_count: number;
    accepted_at: string | null;
    accepted_by: string;
    activity_ids: string[];
  }>();
  assert.equal(body.accepted_count, 0);
  assert.equal(body.accepted_at, null);
  assert.equal(body.accepted_by, CONSULTANT_USER);
  assert.deepEqual(body.activity_ids, []);

  // Underlying row stays 'accepted'.
  assert.equal(await getDraftStatus(draftA1), 'accepted');
  await app.close();
});

test("POST /accept: doesn't touch 'streaming' or 'archived' drafts", async () => {
  // Activity 1 has a 'complete' draft (should flip) + 'streaming' draft
  // of a DIFFERENT section (unrelated to the accepted section, but
  // proves we don't broadly mutate by mistake). Activity 2 has an
  // 'archived' draft for the SAME section — must NOT flip.
  const completeDraft = await seedDraft({
    tenantId: TENANT_A,
    activityId: ACTIVITY_A1,
    sectionKind: 'uncertainty',
    status: 'complete',
  });
  const streamingDraft = await seedDraft({
    tenantId: TENANT_A,
    activityId: ACTIVITY_A1,
    sectionKind: 'hypothesis', // different section — also must not flip
    status: 'streaming',
  });
  const archivedDraft = await seedDraft({
    tenantId: TENANT_A,
    activityId: ACTIVITY_A2,
    sectionKind: 'uncertainty', // same section — but archived
    status: 'archived',
  });

  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_A}/narrative/sections/uncertainty/accept`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ accepted_count: number; activity_ids: string[] }>();
  // Only the 'complete' row flips. Archived (same section) stays. Streaming
  // (different section) also untouched.
  assert.equal(body.accepted_count, 1);
  assert.deepEqual(body.activity_ids, [ACTIVITY_A1]);

  assert.equal(await getDraftStatus(completeDraft), 'accepted');
  assert.equal(await getDraftStatus(streamingDraft), 'streaming');
  assert.equal(await getDraftStatus(archivedDraft), 'archived');
  await app.close();
});

// =============================================================================
// Workflow integration: canAdvance(4) flips when all 4 sections are accepted
// =============================================================================

test('POST /accept: GET /workflow afterward shows canAdvance(4).ok=true once all 4 section_kinds accepted', async () => {
  // Seed one 'complete' draft per section_kind, all under ACTIVITY_A1.
  // The snapshot counter does COUNT(DISTINCT section_kind), so accepting
  // each section in turn should drive the count from 0 → 4.
  for (const kind of SECTION_KINDS) {
    await seedDraft({
      tenantId: TENANT_A,
      activityId: ACTIVITY_A1,
      sectionKind: kind,
      status: 'complete',
    });
  }
  // Initialize the wizard state so GET /workflow returns 200 (not 400
  // not_a_wizard_claim).
  await privilegedSql`
    UPDATE claim
       SET workflow_state = ${JSON.stringify({
         initialized_at: '2025-01-01T00:00:00.000Z',
         steps: { '1': null, '2': null, '3': null, '4': null, '5': null },
       })}::text::jsonb
     WHERE id = ${CLAIM_A}
  `;

  const app = buildApp();
  const cookie = { cpa_session: await consultantJwt() };

  // Initial state — no sections accepted, canAdvance(4) must be false.
  const initial = await app.inject({
    method: 'GET',
    url: `/v1/claims/${CLAIM_A}/workflow`,
    cookies: cookie,
  });
  assert.equal(initial.statusCode, 200);
  const initialBody = initial.json<{
    derived: { canAdvance: Record<'1' | '2' | '3' | '4' | '5', { ok: boolean; reason?: string }> };
  }>();
  assert.equal(initialBody.derived.canAdvance['4'].ok, false);

  // Accept each section in turn.
  for (const kind of SECTION_KINDS) {
    const acceptRes = await app.inject({
      method: 'POST',
      url: `/v1/claims/${CLAIM_A}/narrative/sections/${kind}/accept`,
      cookies: cookie,
    });
    assert.equal(acceptRes.statusCode, 200, `accept ${kind} should succeed`);
  }

  // Final state — all 4 sections accepted, canAdvance(4) flips to true.
  const final = await app.inject({
    method: 'GET',
    url: `/v1/claims/${CLAIM_A}/workflow`,
    cookies: cookie,
  });
  assert.equal(final.statusCode, 200);
  const finalBody = final.json<{
    derived: { canAdvance: Record<'1' | '2' | '3' | '4' | '5', { ok: boolean; reason?: string }> };
  }>();
  assert.equal(finalBody.derived.canAdvance['4'].ok, true);
  await app.close();
});
