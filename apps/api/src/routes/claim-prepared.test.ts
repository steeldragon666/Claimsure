/**
 * Tests for GET /v1/claims/:id/prepared — the per-step AI-prepared-content
 * read surface the consultant approve-wizard renders.
 *
 * Fixture strategy mirrors `claim-workflow.test.ts`: a disjoint UUID prefix
 * (cbaxx) torn down between runs; RLS exercised via cross-firm 404.
 *
 * Coverage:
 *   - auth (401 no session, 403 viewer), 400 bad uuid, 404 unknown claim
 *   - cross-firm isolation (404)
 *   - empty claim → every step prepared:false with empty arrays (no fabrication)
 *   - populated claim → real content per step:
 *       · step 1 hypotheses from ip_search_verdict
 *       · step 2 proposed activities from ACTIVITY_REGISTER_DRAFTED + accepted
 *       · step 4 evidence from ARTEFACT_LINKED
 *       · step 5 narrative from narrative_draft
 *       · step 6 review roll-up counts
 */

import { test, after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { signSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../app.js';

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

// `cbaxx` namespace — claim-prepared route batch. Disjoint from
// claim-workflow.test.ts (`c66xx`).
const TENANT_A = '00000000-0000-4000-8000-0000000cba01';
const TENANT_B = '00000000-0000-4000-8000-0000000cba02';
const ADMIN_USER = '00000000-0000-4000-8000-0000000cba10';
const VIEWER_USER = '00000000-0000-4000-8000-0000000cba11';
const CONSULTANT_USER = '00000000-0000-4000-8000-0000000cba12';
const TENANT_B_ADMIN = '00000000-0000-4000-8000-0000000cba13';

const SUBJECT_A = '00000000-0000-4000-8000-0000000cba20';
const SUBJECT_B = '00000000-0000-4000-8000-0000000cba21';
const PROJECT_A = '00000000-0000-4000-8000-0000000cba30';
const PROJECT_B = '00000000-0000-4000-8000-0000000cba31';
const CLAIM_EMPTY = '00000000-0000-4000-8000-0000000cba40';
const CLAIM_FULL = '00000000-0000-4000-8000-0000000cba41';
const CLAIM_B = '00000000-0000-4000-8000-0000000cba43';
const CLAIM_UNKNOWN = '00000000-0000-4000-8000-0000000cbaff';
const ACTIVITY_FULL = '00000000-0000-4000-8000-0000000cba50';
const PROPOSED_ID = '00000000-0000-4000-8000-0000000cba60';
const EVIDENCE_EVENT = '00000000-0000-4000-8000-0000000cba70';

const cleanup = async (): Promise<void> => {
  await privilegedSql`DELETE FROM ip_search_verdict WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
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

const WS = JSON.stringify({
  initialized_at: '2025-01-01T00:00:00.000Z',
  steps: { '1': null, '2': null, '3': null, '4': null, '5': null },
});

before(async () => {
  await cleanup();
  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT_A}, 'Firm CPPA', 'firm-cbaa', 'mixed'),
                   (${TENANT_B}, 'Firm CPPB', 'firm-cbab', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${ADMIN_USER}, 'cba-admin@example.com', 'microsoft', 'microsoft:cba-admin', 'CPP Admin'),
                   (${VIEWER_USER}, 'cba-viewer@example.com', 'microsoft', 'microsoft:cba-viewer', 'CPP Viewer'),
                   (${CONSULTANT_USER}, 'cba-cons@example.com', 'microsoft', 'microsoft:cba-cons', 'CPP Consultant'),
                   (${TENANT_B_ADMIN}, 'cba-admin-b@example.com', 'microsoft', 'microsoft:cba-admin-b', 'CPP Admin B')`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT_A}, ${ADMIN_USER}, 'admin', true),
                              (gen_random_uuid(), ${TENANT_A}, ${VIEWER_USER}, 'viewer', true),
                              (gen_random_uuid(), ${TENANT_A}, ${CONSULTANT_USER}, 'consultant', true),
                              (gen_random_uuid(), ${TENANT_B}, ${TENANT_B_ADMIN}, 'admin', true)`;
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                       VALUES (${SUBJECT_A}, ${TENANT_A}, 'CPP Subject A', 'claimant'),
                              (${SUBJECT_B}, ${TENANT_B}, 'CPP Subject B', 'claimant')`;
  await privilegedSql`
    INSERT INTO project (id, tenant_id, subject_tenant_id, name, started_at)
    VALUES
      (${PROJECT_A}, ${TENANT_A}, ${SUBJECT_A}, 'CPP Project A', '2024-07-01T00:00:00Z'::timestamptz),
      (${PROJECT_B}, ${TENANT_B}, ${SUBJECT_B}, 'CPP Project B', '2024-07-01T00:00:00Z'::timestamptz)
  `;
});

beforeEach(async () => {
  await privilegedSql`DELETE FROM ip_search_verdict WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM narrative_draft WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM event WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM activity WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM claim WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`
    INSERT INTO claim (id, tenant_id, subject_tenant_id, project_id, fiscal_year, stage, workflow_state)
    VALUES
      (${CLAIM_EMPTY}, ${TENANT_A}, ${SUBJECT_A}, ${PROJECT_A}, 2025, 'engagement', ${WS}::jsonb),
      (${CLAIM_FULL},  ${TENANT_A}, ${SUBJECT_A}, ${PROJECT_A}, 2026, 'engagement', ${WS}::jsonb),
      (${CLAIM_B},     ${TENANT_B}, ${SUBJECT_B}, ${PROJECT_B}, 2025, 'engagement', ${WS}::jsonb)
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

const adminJwt = (): Promise<string> => jwtFor(ADMIN_USER, 'cba-admin@example.com', 'admin');
const viewerJwt = (): Promise<string> => jwtFor(VIEWER_USER, 'cba-viewer@example.com', 'viewer');
const tenantBAdminJwt = (): Promise<string> =>
  jwtFor(TENANT_B_ADMIN, 'cba-admin-b@example.com', 'admin', TENANT_B);

// Seed a full claim: an accepted activity (promoted from PROPOSED_ID), the
// ACTIVITY_REGISTER_DRAFTED proposal event, an IP verdict, an ARTEFACT_LINKED
// evidence event, and a complete narrative draft.
const seedFullClaim = async (): Promise<void> => {
  await privilegedSql`
    INSERT INTO activity (id, tenant_id, project_id, claim_id, code, kind, title,
                          hypothesis, technical_uncertainty, proposed_id,
                          fy_label, hypothesis_formed_at)
    VALUES (${ACTIVITY_FULL}, ${TENANT_A}, ${PROJECT_A}, ${CLAIM_FULL},
            'CA-01', 'core', 'Sample-efficiency RL study',
            'A novel reward-shaping approach improves sample efficiency',
            'No known method achieves this on sparse-reward tasks',
            ${PROPOSED_ID}, 'FY26', '2025-06-01T00:00:00Z'::timestamptz)
  `;

  // ACTIVITY_REGISTER_DRAFTED event carrying one proposed activity.
  const draftPayload = {
    _v: 1,
    project_id: PROJECT_A,
    proposed_activities: [
      {
        proposed_id: PROPOSED_ID,
        name: 'Sample-efficiency RL study',
        kind: 'core',
        statutory_anchor: 's.355-25',
        rationale: 'Clusters the experiment + observation events into one core activity.',
        clustered_event_ids: [EVIDENCE_EVENT],
        confidence: 0.88,
        proposed_hypothesis: 'A novel reward-shaping approach improves sample efficiency',
        proposed_uncertainty: 'No known method achieves this on sparse-reward tasks',
      },
    ],
    unclustered_event_ids: [],
    total_input_events: 1,
    events_truncated: false,
    synthesizer_notes: 'one clean cluster',
    model: 'test-model',
    prompt_version: 'synthesize-register@1.0.0',
    idempotency_key: 'cba-test-key',
  };
  await privilegedSql`
    INSERT INTO event (id, tenant_id, subject_tenant_id, project_id, kind, payload,
                       prev_hash, hash, captured_at, captured_by_user_id)
    VALUES (gen_random_uuid(), ${TENANT_A}, ${SUBJECT_A}, ${PROJECT_A},
            'ACTIVITY_REGISTER_DRAFTED', ${JSON.stringify(draftPayload)}::jsonb,
            NULL, encode(digest('cba-draft', 'sha256'), 'hex'),
            '2025-06-02T00:00:00Z'::timestamptz, ${CONSULTANT_USER})
  `;

  // Evidence event + ARTEFACT_LINKED binding it to the activity.
  await privilegedSql`
    INSERT INTO event (id, tenant_id, subject_tenant_id, project_id, kind, payload,
                       prev_hash, hash, captured_at, captured_by_user_id)
    VALUES (${EVIDENCE_EVENT}, ${TENANT_A}, ${SUBJECT_A}, ${PROJECT_A},
            'EXPERIMENT', '{"text":"ran the RL benchmark"}'::jsonb,
            NULL, encode(digest('cba-evid', 'sha256'), 'hex'),
            '2025-06-03T00:00:00Z'::timestamptz, ${CONSULTANT_USER})
  `;
  await privilegedSql`
    INSERT INTO event (id, tenant_id, subject_tenant_id, project_id, kind, payload,
                       prev_hash, hash, captured_at, captured_by_user_id)
    VALUES (gen_random_uuid(), ${TENANT_A}, ${SUBJECT_A}, ${PROJECT_A},
            'ARTEFACT_LINKED',
            ${JSON.stringify({
              activity_id: ACTIVITY_FULL,
              artefact_kind: 'event',
              artefact_id: EVIDENCE_EVENT,
              link_reason: 'auto-allocated by evidence binder',
            })}::jsonb,
            NULL, encode(digest('cba-link', 'sha256'), 'hex'),
            '2025-06-04T00:00:00Z'::timestamptz, ${CONSULTANT_USER})
  `;

  // IP-search verdict (approved).
  await privilegedSql`
    INSERT INTO ip_search_verdict (id, tenant_id, claim_id, activity_id,
                                   hypothesis_text, verdict, draft_verdict,
                                   analysis_markdown, approved_by_user_id, approved_at)
    VALUES (gen_random_uuid(), ${TENANT_A}, ${CLAIM_FULL}, ${ACTIVITY_FULL},
            'A novel reward-shaping approach improves sample efficiency',
            'pass', 'pass',
            'No prior art directly anticipates this combination.',
            ${CONSULTANT_USER}, '2025-06-05T00:00:00Z'::timestamptz)
  `;

  // Narrative draft (complete).
  await privilegedSql`
    INSERT INTO narrative_draft (tenant_id, id, activity_id, section_kind,
                                 current_version, status, segments, content_hash,
                                 model, prompt_version, created_by_user_id)
    VALUES (${TENANT_A}, gen_random_uuid(), ${ACTIVITY_FULL}, 'new_knowledge',
            1, 'complete',
            ${JSON.stringify([
              { type: 'prose', text: 'The team set out to improve sample efficiency.' },
              {
                type: 'claim',
                text: 'The benchmark confirmed the hypothesis.',
                citing_events: [EVIDENCE_EVENT],
              },
            ])}::jsonb,
            encode(digest('cba', 'sha256'), 'hex'),
            'draft-narrative@1.1.0', 'draft-narrative@1.1.0', ${CONSULTANT_USER})
  `;
};

interface PreparedBody {
  prepared: {
    step1_hypotheses: { prepared: boolean; items: unknown[] };
    step2_activities: { prepared: boolean; items: Array<Record<string, unknown>> };
    step3_apportionment: { prepared: boolean; items: unknown[]; total_amount: number };
    step4_evidence: { prepared: boolean; items: Array<Record<string, unknown>> };
    step5_narrative: { prepared: boolean; items: Array<Record<string, unknown>> };
    step6_review: Record<string, number>;
  };
}

// =============================================================================
// Auth + validation
// =============================================================================

test('GET /prepared: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: `/v1/claims/${CLAIM_EMPTY}/prepared` });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('GET /prepared: 403 for viewer role', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/claims/${CLAIM_EMPTY}/prepared`,
    cookies: { cpa_session: await viewerJwt() },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('GET /prepared: 400 on non-UUID claim id', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/claims/not-a-uuid/prepared`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('GET /prepared: 404 on unknown claim', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/claims/${CLAIM_UNKNOWN}/prepared`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('GET /prepared: 404 cross-firm (Firm B admin cannot read Firm A claim)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/claims/${CLAIM_EMPTY}/prepared`,
    cookies: { cpa_session: await tenantBAdminJwt() },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

// =============================================================================
// Empty claim — no fabrication
// =============================================================================

test('GET /prepared: empty claim → every step prepared:false with empty arrays', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/claims/${CLAIM_EMPTY}/prepared`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<PreparedBody>();
  const p = body.prepared;
  assert.equal(p.step1_hypotheses.prepared, false);
  assert.deepEqual(p.step1_hypotheses.items, []);
  assert.equal(p.step2_activities.prepared, false);
  assert.deepEqual(p.step2_activities.items, []);
  assert.equal(p.step3_apportionment.prepared, false);
  assert.equal(p.step4_evidence.prepared, false);
  assert.equal(p.step5_narrative.prepared, false);
  assert.equal(p.step6_review.activity_count, 0);
  assert.equal(p.step6_review.hypothesis_count, 0);
  await app.close();
});

// =============================================================================
// Populated claim — real content per step
// =============================================================================

test('GET /prepared: populated claim returns real per-step content', async () => {
  await seedFullClaim();
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/claims/${CLAIM_FULL}/prepared`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const p = res.json<PreparedBody>().prepared;

  // Step 1 — IP-search verdict.
  assert.equal(p.step1_hypotheses.prepared, true);
  assert.equal(p.step1_hypotheses.items.length, 1);

  // Step 2 — proposed activity from the draft event, marked accepted.
  assert.equal(p.step2_activities.prepared, true);
  assert.equal(p.step2_activities.items.length, 1);
  const act = p.step2_activities.items[0]!;
  assert.equal(act['kind'], 'core');
  assert.equal(act['statutory_anchor'], 's.355-25');
  assert.equal(act['accepted'], true);
  assert.equal(act['activity_code'], 'CA-01');
  assert.equal(act['confidence'], 0.88);

  // Step 4 — evidence bound to the activity.
  assert.equal(p.step4_evidence.prepared, true);
  const evActivity = p.step4_evidence.items.find((e) => e['activity_id'] === ACTIVITY_FULL)!;
  assert.ok(evActivity);
  assert.equal((evActivity['artefacts'] as unknown[]).length, 1);

  // Step 5 — narrative draft with a citing-claim segment.
  assert.equal(p.step5_narrative.prepared, true);
  const narr = p.step5_narrative.items[0]!;
  assert.equal(narr['section_kind'], 'new_knowledge');
  assert.equal((narr['segments'] as unknown[]).length, 2);

  // Step 6 — roll-up counts.
  assert.equal(p.step6_review.hypothesis_count, 1);
  assert.equal(p.step6_review.activity_count, 1);
  assert.equal(p.step6_review.activities_accepted, 1);
  assert.equal(p.step6_review.evidence_links, 1);
  assert.equal(p.step6_review.narrative_sections, 1);

  await app.close();
});
