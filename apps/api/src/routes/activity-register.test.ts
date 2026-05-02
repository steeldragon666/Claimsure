import { test, after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { signSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import { insertEventWithChain } from '@cpa/db';
import { _reloadEnvForTests } from '@cpa/agents/runtime';
import type { ProposedActivity, ActivityRegisterDraftedPayload } from '@cpa/schemas';
import { buildApp } from '../app.js';

// Default-on flags so the synthesize trigger isn't accidentally 503'd
// by env left over from another test file.
delete process.env.P6_AGENT_B_ENABLED;
delete process.env.P6_AGENT_TENANT_ALLOWLIST;
_reloadEnvForTests();

// Force the stub synthesizer for the trigger happy-path test (the
// shim's downstream synthesizer call uses whichever impl is configured;
// stub is deterministic and offline).
process.env.ACTIVITY_REGISTER_SYNTHESIZER_IMPL = 'stub';

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

// Per-file UUID prefix `0b44` — Theme 4 / Task 4.4-4.5. Disjoint from
// the synthesize job test (`0b40-0b09`) and other route tests.
const TENANT_A = '00000000-0000-4000-8000-0000000b4400';
const TENANT_B = '00000000-0000-4000-8000-0000000b4401';
const ADMIN_USER = '00000000-0000-4000-8000-0000000b4410';
const VIEWER_USER = '00000000-0000-4000-8000-0000000b4411';
const CONSULTANT_USER = '00000000-0000-4000-8000-0000000b4412';
const TENANT_B_ADMIN = '00000000-0000-4000-8000-0000000b4413';

const SUBJECT_A = '00000000-0000-4000-8000-0000000b4420';
const SUBJECT_B = '00000000-0000-4000-8000-0000000b4421';
const PROJECT_A = '00000000-0000-4000-8000-0000000b4430';
const PROJECT_B = '00000000-0000-4000-8000-0000000b4431';
const PROJECT_NO_CLAIM = '00000000-0000-4000-8000-0000000b4432';
const CLAIM_A = '00000000-0000-4000-8000-0000000b4440';
const CLAIM_B = '00000000-0000-4000-8000-0000000b4441';

// Agent B system user id — seeded by migration 0033. We don't delete it
// in cleanup; insert idempotently in `before` to support fresh-DB runs.
const AGENT_B_SYSTEM_USER_ID = '00000000-0000-4000-8000-000000a90002';

const cleanup = async (): Promise<void> => {
  await privilegedSql`
    DELETE FROM event WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})
  `;
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
            VALUES (${TENANT_A}, 'Firm B44A', 'firm-b44a', 'mixed'),
                   (${TENANT_B}, 'Firm B44B', 'firm-b44b', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${ADMIN_USER}, 'b44-admin@example.com', 'microsoft', 'microsoft:b44-admin', 'B44 Admin'),
                   (${VIEWER_USER}, 'b44-viewer@example.com', 'microsoft', 'microsoft:b44-viewer', 'B44 Viewer'),
                   (${CONSULTANT_USER}, 'b44-cons@example.com', 'microsoft', 'microsoft:b44-cons', 'B44 Consultant'),
                   (${TENANT_B_ADMIN}, 'b44-admin-b@example.com', 'microsoft', 'microsoft:b44-admin-b', 'B44 Admin (Firm B)')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${AGENT_B_SYSTEM_USER_ID}, 'system+agent-b@cpa.local', 'microsoft', 'system:agent-b', 'Agent B (Activity Register Synthesizer)')
            ON CONFLICT (id) DO NOTHING`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT_A}, ${ADMIN_USER}, 'admin', true),
                              (gen_random_uuid(), ${TENANT_A}, ${VIEWER_USER}, 'viewer', true),
                              (gen_random_uuid(), ${TENANT_A}, ${CONSULTANT_USER}, 'consultant', true),
                              (gen_random_uuid(), ${TENANT_B}, ${TENANT_B_ADMIN}, 'admin', true)`;
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                       VALUES (${SUBJECT_A}, ${TENANT_A}, 'B44 Subject A', 'claimant'),
                              (${SUBJECT_B}, ${TENANT_B}, 'B44 Subject B', 'claimant')`;
  await privilegedSql`
    INSERT INTO project (id, tenant_id, subject_tenant_id, name, started_at)
    VALUES (${PROJECT_A}, ${TENANT_A}, ${SUBJECT_A}, 'B44 Project A',
            '2024-07-01T00:00:00Z'::timestamptz),
           (${PROJECT_B}, ${TENANT_B}, ${SUBJECT_B}, 'B44 Project B',
            '2024-07-01T00:00:00Z'::timestamptz),
           (${PROJECT_NO_CLAIM}, ${TENANT_A}, ${SUBJECT_A}, 'B44 No Claim',
            '2024-07-01T00:00:00Z'::timestamptz)
  `;
  await privilegedSql`
    INSERT INTO claim (id, tenant_id, subject_tenant_id, project_id, fiscal_year, stage)
    VALUES (${CLAIM_A}, ${TENANT_A}, ${SUBJECT_A}, ${PROJECT_A}, 2025, 'engagement'),
           (${CLAIM_B}, ${TENANT_B}, ${SUBJECT_B}, ${PROJECT_B}, 2025, 'engagement')
  `;
});

after(async () => {
  await cleanup();
  await sql.end();
  await privilegedSql.end();
});

// Per-test isolation: clear events + activities so each test starts
// from a known state but tenant/user/project fixtures persist.
beforeEach(async () => {
  await privilegedSql`DELETE FROM event WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM activity WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM agent_call_cache WHERE agent_name = 'activity-register-synthesizer'`;
  delete process.env.P6_AGENT_B_ENABLED;
  delete process.env.P6_AGENT_TENANT_ALLOWLIST;
  _reloadEnvForTests();
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

const adminJwt = (): Promise<string> => jwtFor(ADMIN_USER, 'b44-admin@example.com', 'admin');
const viewerJwt = (): Promise<string> => jwtFor(VIEWER_USER, 'b44-viewer@example.com', 'viewer');
const consultantJwt = (): Promise<string> =>
  jwtFor(CONSULTANT_USER, 'b44-cons@example.com', 'consultant');
const tenantBAdminJwt = (): Promise<string> =>
  jwtFor(TENANT_B_ADMIN, 'b44-admin-b@example.com', 'admin', TENANT_B);

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a synthetic ACTIVITY_REGISTER_DRAFTED event for the given
 * project. Bypasses the synthesizer entirely so the accept-flow tests
 * can pin proposed_ids deterministically. The chain helper handles
 * idempotency_key + prev_hash.
 */
async function seedDraftEvent(args: {
  tenantId: string;
  subjectTenantId: string;
  projectId: string;
  proposedActivities: ProposedActivity[];
}): Promise<{ event_id: string }> {
  const payload: ActivityRegisterDraftedPayload = {
    _v: 1,
    project_id: args.projectId,
    proposed_activities: args.proposedActivities,
    unclustered_event_ids: [],
    total_input_events: 0,
    events_truncated: false,
    synthesizer_notes: 'test seed',
    model: 'test-stub',
    prompt_version: 'synthesize-register@1.0.0',
    idempotency_key: crypto
      .createHash('sha256')
      .update(`test-seed-${args.projectId}-${crypto.randomUUID()}`)
      .digest('hex'),
  };
  const inserted = await insertEventWithChain({
    tenant_id: args.tenantId,
    subject_tenant_id: args.subjectTenantId,
    project_id: args.projectId,
    kind: 'ACTIVITY_REGISTER_DRAFTED',
    payload,
    classification: null,
    captured_at: new Date(),
    captured_by_user_id: AGENT_B_SYSTEM_USER_ID,
    override_of_event_id: null,
    override_new_kind: null,
    override_reason: null,
    idempotency_key: payload.idempotency_key,
  });
  return { event_id: inserted.id };
}

/**
 * Mint a deterministic ProposedActivity. Defaults to a canonical
 * `core` ↔ `s.355-25` pairing; overrides let individual tests flip
 * fields without spelling out the whole shape.
 */
function makeProposed(overrides: Partial<ProposedActivity> = {}): ProposedActivity {
  return {
    proposed_id: crypto.randomUUID(),
    name: 'Test proposal',
    kind: 'core',
    statutory_anchor: 's.355-25',
    rationale: 'covers the experimental backbone',
    clustered_event_ids: [crypto.randomUUID()],
    confidence: 0.8,
    proposed_hypothesis: 'Hypothesis text',
    proposed_uncertainty: 'Uncertainty text',
    ...overrides,
  };
}

// ===========================================================================
// Task 4.4 — POST /v1/projects/:id/activity-register/synthesize
// ===========================================================================

test('POST synthesize: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/projects/${PROJECT_A}/activity-register/synthesize`,
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST synthesize: 403 for viewer role', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/projects/${PROJECT_A}/activity-register/synthesize`,
    cookies: { cpa_session: await viewerJwt() },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('POST synthesize: 404 for unknown project', async () => {
  const app = buildApp();
  const unknown = '00000000-0000-4000-8000-0000000b44ff';
  const res = await app.inject({
    method: 'POST',
    url: `/v1/projects/${unknown}/activity-register/synthesize`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 404);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'project_not_found');
  await app.close();
});

test('POST synthesize: 404 for cross-firm project', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/projects/${PROJECT_B}/activity-register/synthesize`,
    cookies: { cpa_session: await adminJwt() }, // session is firm A
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('POST synthesize: 503 when P6_AGENT_B_ENABLED=false', async () => {
  process.env.P6_AGENT_B_ENABLED = 'false';
  _reloadEnvForTests();
  try {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/projects/${PROJECT_A}/activity-register/synthesize`,
      cookies: { cpa_session: await consultantJwt() },
    });
    assert.equal(res.statusCode, 503);
    const body = res.json<{ error: string }>();
    assert.equal(body.error, 'feature_disabled');
    await app.close();
  } finally {
    delete process.env.P6_AGENT_B_ENABLED;
    _reloadEnvForTests();
  }
});

test('POST synthesize: 202 happy path + GET /latest reflects the new draft', async () => {
  // Use the shim directly for determinism — production code does
  // `void shim(input)` but we await so the assertion can read the row.
  const { enqueueActivityRegisterSynthesize } = await import('../lib/enqueue-synthesize.js');

  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/projects/${PROJECT_A}/activity-register/synthesize`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(res.statusCode, 202);
  const body = res.json<{ requestId: string }>();
  assert.ok(typeof body.requestId === 'string' && body.requestId.length > 0);

  // Explicitly drive the synth (the route's fire-and-forget may not
  // have resolved by the time we assert).
  await enqueueActivityRegisterSynthesize({
    tenant_id: TENANT_A,
    project_id: PROJECT_A,
  });

  const getRes = await app.inject({
    method: 'GET',
    url: `/v1/projects/${PROJECT_A}/activity-register/latest`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(getRes.statusCode, 200);
  const getBody = getRes.json<{
    status: string;
    latest_event: { kind: string; payload: { project_id: string } } | null;
    total_proposed: number;
    accepted_count: number;
  }>();
  // Stub may emit zero proposals on a project with no events; the
  // contract only requires that an event landed, so assert latest_event
  // is non-null and project_id matches.
  assert.notEqual(getBody.latest_event, null);
  assert.equal(getBody.latest_event?.kind, 'ACTIVITY_REGISTER_DRAFTED');
  assert.equal(getBody.latest_event?.payload.project_id, PROJECT_A);
  await app.close();
});

// ===========================================================================
// Task 4.4 — GET /v1/projects/:id/activity-register/latest
// ===========================================================================

test('GET latest: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/projects/${PROJECT_A}/activity-register/latest`,
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('GET latest: 404 for unknown project', async () => {
  const app = buildApp();
  const unknown = '00000000-0000-4000-8000-0000000b44fe';
  const res = await app.inject({
    method: 'GET',
    url: `/v1/projects/${unknown}/activity-register/latest`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('GET latest: 404 for cross-firm project', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/projects/${PROJECT_B}/activity-register/latest`,
    cookies: { cpa_session: await adminJwt() }, // firm A session
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('GET latest: 200 viewer can read (read-only role allowed)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/projects/${PROJECT_A}/activity-register/latest`,
    cookies: { cpa_session: await viewerJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ status: string }>();
  assert.equal(body.status, 'none');
  await app.close();
});

test("GET latest: status='none' when no draft exists", async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/projects/${PROJECT_A}/activity-register/latest`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    status: string;
    latest_event: unknown;
    accepted_count: number;
    total_proposed: number;
  }>();
  assert.equal(body.status, 'none');
  assert.equal(body.latest_event, null);
  assert.equal(body.accepted_count, 0);
  assert.equal(body.total_proposed, 0);
  await app.close();
});

test("GET latest: status='pending' when draft exists with no acceptances", async () => {
  await seedDraftEvent({
    tenantId: TENANT_A,
    subjectTenantId: SUBJECT_A,
    projectId: PROJECT_A,
    proposedActivities: [
      makeProposed(),
      makeProposed({ kind: 'supporting', statutory_anchor: 's.355-30' }),
    ],
  });

  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/projects/${PROJECT_A}/activity-register/latest`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    status: string;
    accepted_count: number;
    total_proposed: number;
  }>();
  assert.equal(body.status, 'pending');
  assert.equal(body.accepted_count, 0);
  assert.equal(body.total_proposed, 2);
  await app.close();
});

test("GET latest: status='complete' when all proposed accepted (via accept endpoint)", async () => {
  const proposedA = makeProposed({ name: 'Proposal A' });
  const proposedB = makeProposed({
    name: 'Proposal B',
    kind: 'supporting',
    statutory_anchor: 's.355-30',
  });
  await seedDraftEvent({
    tenantId: TENANT_A,
    subjectTenantId: SUBJECT_A,
    projectId: PROJECT_A,
    proposedActivities: [proposedA, proposedB],
  });

  const app = buildApp();
  const acceptRes = await app.inject({
    method: 'POST',
    url: `/v1/projects/${PROJECT_A}/activity-register/accept`,
    cookies: { cpa_session: await consultantJwt() },
    payload: {
      acceptances: [{ proposed_id: proposedA.proposed_id }, { proposed_id: proposedB.proposed_id }],
    },
  });
  assert.equal(acceptRes.statusCode, 200);

  const getRes = await app.inject({
    method: 'GET',
    url: `/v1/projects/${PROJECT_A}/activity-register/latest`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(getRes.statusCode, 200);
  const body = getRes.json<{
    status: string;
    accepted_count: number;
    total_proposed: number;
  }>();
  assert.equal(body.status, 'complete');
  assert.equal(body.accepted_count, 2);
  assert.equal(body.total_proposed, 2);
  await app.close();
});

// ===========================================================================
// Task 4.5 — POST /v1/projects/:id/activity-register/accept
// ===========================================================================

test('POST accept: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/projects/${PROJECT_A}/activity-register/accept`,
    payload: { acceptances: [{ proposed_id: crypto.randomUUID() }] },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST accept: 403 for viewer role', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/projects/${PROJECT_A}/activity-register/accept`,
    cookies: { cpa_session: await viewerJwt() },
    payload: { acceptances: [{ proposed_id: crypto.randomUUID() }] },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('POST accept: 404 for unknown project', async () => {
  const app = buildApp();
  const unknown = '00000000-0000-4000-8000-0000000b44fd';
  const res = await app.inject({
    method: 'POST',
    url: `/v1/projects/${unknown}/activity-register/accept`,
    cookies: { cpa_session: await adminJwt() },
    payload: { acceptances: [{ proposed_id: crypto.randomUUID() }] },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('POST accept: 400 invalid body (missing acceptances)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/projects/${PROJECT_A}/activity-register/accept`,
    cookies: { cpa_session: await consultantJwt() },
    payload: {},
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST accept: 404 when no draft register exists yet', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/projects/${PROJECT_A}/activity-register/accept`,
    cookies: { cpa_session: await consultantJwt() },
    payload: { acceptances: [{ proposed_id: crypto.randomUUID() }] },
  });
  assert.equal(res.statusCode, 404);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'no_draft_register');
  await app.close();
});

test('POST accept: 200 all-success — 2 proposed → 2 activities + 2 ACTIVITY_CREATED events', async () => {
  const proposedA = makeProposed({ name: 'Alpha' });
  const proposedB = makeProposed({
    name: 'Beta',
    kind: 'supporting',
    statutory_anchor: 's.355-30',
  });
  await seedDraftEvent({
    tenantId: TENANT_A,
    subjectTenantId: SUBJECT_A,
    projectId: PROJECT_A,
    proposedActivities: [proposedA, proposedB],
  });

  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/projects/${PROJECT_A}/activity-register/accept`,
    cookies: { cpa_session: await consultantJwt() },
    payload: {
      acceptances: [{ proposed_id: proposedA.proposed_id }, { proposed_id: proposedB.proposed_id }],
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    accepted: Array<{
      proposed_id: string;
      activity_id: string;
      code: string;
      skipped_idempotent: boolean;
    }>;
    rejected: Array<{ proposed_id: string; reason: string }>;
  }>();
  assert.equal(body.accepted.length, 2);
  assert.equal(body.rejected.length, 0);
  // Both unique codes — one CA-NN and one SA-NN since one is core, one supporting.
  const codes = body.accepted.map((a) => a.code).sort();
  assert.ok(codes[0]!.startsWith('CA-'), `expected core code, got ${codes[0]}`);
  assert.ok(codes[1]!.startsWith('SA-'), `expected supporting code, got ${codes[1]}`);
  body.accepted.forEach((a) => assert.equal(a.skipped_idempotent, false));

  // Two activity rows in the DB.
  const activityRows = await privilegedSql<{ id: string; code: string; title: string }[]>`
    SELECT id, code, title FROM activity WHERE project_id = ${PROJECT_A} ORDER BY code
  `;
  assert.equal(activityRows.length, 2);
  const titles = activityRows.map((r) => r.title).sort();
  assert.deepEqual(titles, ['Alpha', 'Beta']);

  // Two ACTIVITY_CREATED events with proposed_id correlation.
  const eventRows = await privilegedSql<
    { payload: { activity_id: string; proposed_id: string; title: string } }[]
  >`
    SELECT payload FROM event
     WHERE project_id = ${PROJECT_A}
       AND kind = 'ACTIVITY_CREATED'
  `;
  assert.equal(eventRows.length, 2);
  const proposedIdsFromEvents = eventRows.map((r) => r.payload.proposed_id).sort();
  assert.deepEqual(proposedIdsFromEvents, [proposedA.proposed_id, proposedB.proposed_id].sort());
  await app.close();
});

test('POST accept: 200 with edits — name + kind+anchor flipped', async () => {
  const proposed = makeProposed({
    name: 'Original Name',
    kind: 'core',
    statutory_anchor: 's.355-25',
  });
  await seedDraftEvent({
    tenantId: TENANT_A,
    subjectTenantId: SUBJECT_A,
    projectId: PROJECT_A,
    proposedActivities: [proposed],
  });

  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/projects/${PROJECT_A}/activity-register/accept`,
    cookies: { cpa_session: await consultantJwt() },
    payload: {
      acceptances: [
        {
          proposed_id: proposed.proposed_id,
          edits: {
            name: 'Edited Name',
            kind: 'supporting',
            statutory_anchor: 's.355-30',
          },
        },
      ],
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    accepted: Array<{ activity_id: string; code: string; skipped_idempotent: boolean }>;
    rejected: unknown[];
  }>();
  assert.equal(body.accepted.length, 1);
  assert.equal(body.rejected.length, 0);
  assert.ok(body.accepted[0]!.code.startsWith('SA-'), 'kind=supporting → SA-NN');

  const activityRows = await privilegedSql<{ kind: string; title: string }[]>`
    SELECT kind, title FROM activity WHERE id = ${body.accepted[0]!.activity_id}
  `;
  assert.equal(activityRows[0]?.kind, 'supporting');
  assert.equal(activityRows[0]?.title, 'Edited Name');
  await app.close();
});

test('POST accept: 200 partial — bogus proposed_id rejected, valid ones accepted', async () => {
  const goodA = makeProposed({ name: 'GoodA' });
  const goodB = makeProposed({ name: 'GoodB' });
  await seedDraftEvent({
    tenantId: TENANT_A,
    subjectTenantId: SUBJECT_A,
    projectId: PROJECT_A,
    proposedActivities: [goodA, goodB],
  });
  const bogus = crypto.randomUUID();

  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/projects/${PROJECT_A}/activity-register/accept`,
    cookies: { cpa_session: await consultantJwt() },
    payload: {
      acceptances: [
        { proposed_id: goodA.proposed_id },
        { proposed_id: bogus },
        { proposed_id: goodB.proposed_id },
      ],
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    accepted: Array<{ proposed_id: string }>;
    rejected: Array<{ proposed_id: string; reason: string }>;
  }>();
  assert.equal(body.accepted.length, 2);
  assert.equal(body.rejected.length, 1);
  assert.equal(body.rejected[0]?.proposed_id, bogus);
  assert.match(body.rejected[0]?.reason ?? '', /not in latest/);
  await app.close();
});

test('POST accept: 200 idempotency — second accept returns skipped_idempotent', async () => {
  const proposed = makeProposed({ name: 'Idempotent target' });
  await seedDraftEvent({
    tenantId: TENANT_A,
    subjectTenantId: SUBJECT_A,
    projectId: PROJECT_A,
    proposedActivities: [proposed],
  });

  const app = buildApp();
  const first = await app.inject({
    method: 'POST',
    url: `/v1/projects/${PROJECT_A}/activity-register/accept`,
    cookies: { cpa_session: await consultantJwt() },
    payload: { acceptances: [{ proposed_id: proposed.proposed_id }] },
  });
  assert.equal(first.statusCode, 200);
  const firstBody = first.json<{
    accepted: Array<{ activity_id: string; skipped_idempotent: boolean }>;
  }>();
  assert.equal(firstBody.accepted[0]?.skipped_idempotent, false);
  const firstActivityId = firstBody.accepted[0]?.activity_id;
  assert.ok(firstActivityId, 'first call should populate activity_id');

  const second = await app.inject({
    method: 'POST',
    url: `/v1/projects/${PROJECT_A}/activity-register/accept`,
    cookies: { cpa_session: await consultantJwt() },
    payload: { acceptances: [{ proposed_id: proposed.proposed_id }] },
  });
  assert.equal(second.statusCode, 200);
  const secondBody = second.json<{
    accepted: Array<{ activity_id: string; skipped_idempotent: boolean }>;
  }>();
  assert.equal(secondBody.accepted[0]?.skipped_idempotent, true);
  assert.equal(secondBody.accepted[0]?.activity_id, firstActivityId);

  // Only ONE activity row + ONE ACTIVITY_CREATED event despite two calls.
  const activityRows = await privilegedSql<{ id: string }[]>`
    SELECT id FROM activity WHERE project_id = ${PROJECT_A}
  `;
  assert.equal(activityRows.length, 1);
  const eventRows = await privilegedSql<{ id: string }[]>`
    SELECT id FROM event
     WHERE project_id = ${PROJECT_A}
       AND kind = 'ACTIVITY_CREATED'
  `;
  assert.equal(eventRows.length, 1);
  await app.close();
});

test('POST accept: 200 with bad kind+anchor pairing rejects per-row but keeps batch 200', async () => {
  const ok = makeProposed({ name: 'OK row' });
  const bad = makeProposed({ name: 'Bad row' });
  await seedDraftEvent({
    tenantId: TENANT_A,
    subjectTenantId: SUBJECT_A,
    projectId: PROJECT_A,
    proposedActivities: [ok, bad],
  });

  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/projects/${PROJECT_A}/activity-register/accept`,
    cookies: { cpa_session: await consultantJwt() },
    payload: {
      acceptances: [
        { proposed_id: ok.proposed_id },
        // Edit flips kind to supporting WITHOUT flipping anchor.
        // Canonical pairing requires supporting ↔ s.355-30.
        {
          proposed_id: bad.proposed_id,
          edits: { kind: 'supporting', statutory_anchor: 's.355-25' },
        },
      ],
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    accepted: Array<{ proposed_id: string }>;
    rejected: Array<{ proposed_id: string; reason: string }>;
  }>();
  assert.equal(body.accepted.length, 1);
  assert.equal(body.accepted[0]?.proposed_id, ok.proposed_id);
  assert.equal(body.rejected.length, 1);
  assert.equal(body.rejected[0]?.proposed_id, bad.proposed_id);
  assert.match(body.rejected[0]?.reason ?? '', /must pair with anchor/);
  await app.close();
});

test('POST accept: 409 when project has no open claim', async () => {
  const proposed = makeProposed();
  await seedDraftEvent({
    tenantId: TENANT_A,
    subjectTenantId: SUBJECT_A,
    projectId: PROJECT_NO_CLAIM,
    proposedActivities: [proposed],
  });

  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/projects/${PROJECT_NO_CLAIM}/activity-register/accept`,
    cookies: { cpa_session: await consultantJwt() },
    payload: { acceptances: [{ proposed_id: proposed.proposed_id }] },
  });
  assert.equal(res.statusCode, 409);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'no_open_claim');
  await app.close();
});

test('POST accept: cross-firm RLS — firm-A admin cannot accept a firm-B draft (404)', async () => {
  const proposed = makeProposed();
  await seedDraftEvent({
    tenantId: TENANT_B,
    subjectTenantId: SUBJECT_B,
    projectId: PROJECT_B,
    proposedActivities: [proposed],
  });

  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/projects/${PROJECT_B}/activity-register/accept`,
    cookies: { cpa_session: await adminJwt() }, // firm-A session
    payload: { acceptances: [{ proposed_id: proposed.proposed_id }] },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

// Positive control — firm B's session DOES see firm B's draft.
test('GET latest: positive control — firm B admin sees firm B draft', async () => {
  await seedDraftEvent({
    tenantId: TENANT_B,
    subjectTenantId: SUBJECT_B,
    projectId: PROJECT_B,
    proposedActivities: [makeProposed()],
  });

  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/projects/${PROJECT_B}/activity-register/latest`,
    cookies: { cpa_session: await tenantBAdminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ status: string; total_proposed: number }>();
  assert.equal(body.total_proposed, 1);
  assert.equal(body.status, 'pending');
  await app.close();
});
