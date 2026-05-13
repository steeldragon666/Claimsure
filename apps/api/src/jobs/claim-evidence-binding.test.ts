import { test, after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sql, privilegedSql } from '@cpa/db/client';
import { insertEventWithChain } from '@cpa/db';
import { _reloadEnvForTests } from '@cpa/agents/runtime';

// Force the stub allocator impl before the job module loads.
process.env.ALLOCATOR_IMPL = 'stub';

// Default-on flags for happy paths. Per-test overrides reload via
// _reloadEnvForTests after mutating process.env.
delete process.env.P6_AGENT_B_ENABLED;
delete process.env.P6_AGENT_TENANT_ALLOWLIST;
_reloadEnvForTests();

// Import AFTER env is configured.
const { AGENT_B_SYSTEM_USER_ID } = await import('./activity-register-synthesize.js');
const { runClaimEvidenceBindingJob, handleClaimEvidenceBindingJob } =
  await import('./claim-evidence-binding.js');

// ---------------------------------------------------------------------------
// Pinned UUIDs — `0c32` segment groups all Task 3.2 fixtures.
// ---------------------------------------------------------------------------

const TENANT = '00000000-0000-4000-8000-0000000c3201';
const ADMIN_USER = '00000000-0000-4000-8000-0000000c3210';
const SUBJECT = '00000000-0000-4000-8000-0000000c3220';
const PROJECT = '00000000-0000-4000-8000-0000000c3230';
const CLAIM = '00000000-0000-4000-8000-0000000c3240';
const ACTIVITY_1 = '00000000-0000-4000-8000-0000000c3250';
const _ACTIVITY_2 = '00000000-0000-4000-8000-0000000c3251';

const cleanup = async (): Promise<void> => {
  await privilegedSql`DELETE FROM agent_call_cache WHERE agent_name = 'evidence-auto-allocator'`;
  await privilegedSql`DELETE FROM event WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM audit_score_snapshot WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM activity WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM claim WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM project WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM subject_tenant WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM "user" WHERE id = ${ADMIN_USER}`;
  await sql`DELETE FROM tenant WHERE id = ${TENANT}`;
};

before(async () => {
  await cleanup();

  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT}, 'Firm C32', 'firm-c32', 'mixed')`;

  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${ADMIN_USER}, 'c32-admin@example.com', 'microsoft', 'microsoft:c32-admin', 'C32 Admin')`;

  // Seed AGENT_B_SYSTEM_USER_ID idempotently.
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${AGENT_B_SYSTEM_USER_ID}, 'system+agent-b@cpa.local', 'microsoft', 'system:agent-b', 'Agent B (Activity Register Synthesizer)')
            ON CONFLICT (id) DO NOTHING`;

  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT}, ${ADMIN_USER}, 'admin', true)`;

  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                       VALUES (${SUBJECT}, ${TENANT}, 'Acme R&D C32', 'claimant')`;

  await privilegedSql`INSERT INTO project (id, tenant_id, subject_tenant_id, name, started_at)
                       VALUES (${PROJECT}, ${TENANT}, ${SUBJECT}, 'ML Pipeline Rebuild C32', '2024-07-01T00:00:00Z')`;

  // Main test claim with workflow_state set (initialized wizard).
  const workflowState = JSON.stringify({
    initialized_at: new Date().toISOString(),
    steps: { '1': null, '2': null, '3': null, '4': null, '5': null },
  });
  await privilegedSql`INSERT INTO claim (id, tenant_id, subject_tenant_id, project_id, fiscal_year, stage, workflow_state)
                       VALUES (${CLAIM}, ${TENANT}, ${SUBJECT}, ${PROJECT}, 2025, 'engagement', ${workflowState}::text::jsonb)`;
});

// Per-test isolation: clear events + activities, reset feature flags.
beforeEach(async () => {
  await privilegedSql`DELETE FROM event WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM activity WHERE tenant_id = ${TENANT}`;
  delete process.env.P6_AGENT_B_ENABLED;
  delete process.env.P6_AGENT_TENANT_ALLOWLIST;
  _reloadEnvForTests();
});

after(async () => {
  await cleanup();
  await sql.end();
  await privilegedSql.end();
});

// ---------------------------------------------------------------------------
// Helpers: seed activities and evidence events.
// ---------------------------------------------------------------------------

async function seedActivity(args: {
  id: string;
  code: string;
  kind: 'core' | 'supporting';
  title: string;
  hypothesis?: string | null;
}): Promise<void> {
  await privilegedSql`INSERT INTO activity (id, tenant_id, project_id, claim_id, code, kind, title, hypothesis, fy_label, hypothesis_formed_at)
                       VALUES (${args.id}, ${TENANT}, ${PROJECT}, ${CLAIM}, ${args.code}, ${args.kind}, ${args.title}, ${args.hypothesis ?? null}, 'FY25', NOW())`;
}

async function seedEvidenceEvent(args: {
  payloadText?: string;
  kind?: string;
  classification?: Record<string, unknown> | null;
}): Promise<string> {
  const payload: Record<string, unknown> = { _v: 1 };
  if (args.payloadText !== undefined) {
    payload['text'] = args.payloadText;
  }
  const eventKind = args.kind ?? 'SUPPORTING';
  await insertEventWithChain({
    tenant_id: TENANT,
    subject_tenant_id: SUBJECT,
    project_id: PROJECT,
    kind: eventKind,
    payload,
    classification: args.classification ?? null,
    captured_at: new Date(),
    captured_by_user_id: ADMIN_USER,
    override_of_event_id: null,
    override_new_kind: null,
    override_reason: null,
    idempotency_key: null,
  });
  // Return the id of the seeded event.
  const rows = await privilegedSql<{ id: string }[]>`
    SELECT id FROM event
     WHERE tenant_id = ${TENANT}
       AND project_id = ${PROJECT}
       AND kind = ${eventKind}
     ORDER BY received_at DESC
     LIMIT 1
  `;
  return rows[0]!.id;
}

// ---------------------------------------------------------------------------
// Tests: feature flag / tenant gate (no DB needed).
// ---------------------------------------------------------------------------

test('feature flag disabled: returns skipped_disabled, no DB read', async () => {
  process.env.P6_AGENT_B_ENABLED = 'false';
  _reloadEnvForTests();
  const result = await runClaimEvidenceBindingJob({
    claim_id: CLAIM,
    tenant_id: TENANT,
  });
  assert.equal(result.status, 'skipped_disabled');
  assert.match(result.reason ?? '', /P6_AGENT_B_ENABLED/);
});

test('tenant not in allowlist: returns skipped_disabled', async () => {
  process.env.P6_AGENT_TENANT_ALLOWLIST = '00000000-0000-0000-0000-deadbeef0000';
  _reloadEnvForTests();
  const result = await runClaimEvidenceBindingJob({
    claim_id: CLAIM,
    tenant_id: TENANT,
  });
  assert.equal(result.status, 'skipped_disabled');
  assert.match(result.reason ?? '', /allowlist/i);
});

// ---------------------------------------------------------------------------
// Tests: input validation.
// ---------------------------------------------------------------------------

test('invalid input: missing claim_id returns failed', async () => {
  const result = await runClaimEvidenceBindingJob({ tenant_id: TENANT });
  assert.equal(result.status, 'failed');
  assert.match(result.reason ?? '', /invalid job input/i);
});

// ---------------------------------------------------------------------------
// Tests: claim lookup failures.
// ---------------------------------------------------------------------------

test('claim not found: returns failed with reason', async () => {
  const result = await runClaimEvidenceBindingJob({
    claim_id: '00000000-0000-4000-8000-00000000dead',
    tenant_id: TENANT,
  });
  assert.equal(result.status, 'failed');
  assert.match(result.reason ?? '', /claim not found/);
});

// ---------------------------------------------------------------------------
// Tests: no activities → allocated with 0 links.
// ---------------------------------------------------------------------------

test('no activities: returns allocated with links_created=0', async () => {
  await seedEvidenceEvent({ payloadText: 'some evidence text' });

  const result = await runClaimEvidenceBindingJob({
    claim_id: CLAIM,
    tenant_id: TENANT,
  });
  assert.equal(result.status, 'allocated');
  assert.equal(result.links_created, 0);
  assert.equal(result.events_processed, 0);
});

// ---------------------------------------------------------------------------
// Tests: happy path (stub allocator with vocabulary match).
// ---------------------------------------------------------------------------

test('happy path: vocabulary match creates ARTEFACT_LINKED event', async () => {
  // Seed an activity with a distinctive word in the title.
  await seedActivity({
    id: ACTIVITY_1,
    code: 'CA-01',
    kind: 'core',
    title: 'Machine Learning Pipeline Optimization',
    hypothesis: 'ML will improve throughput',
  });

  // Seed an evidence event with a >4-char word matching the activity title.
  // "pipeline" is >4 chars and appears in both activity title and evidence text.
  const eventId = await seedEvidenceEvent({
    payloadText: 'Worked on the pipeline refactoring today',
    kind: 'EXPERIMENT',
    classification: {
      kind: 'EXPERIMENT',
      confidence: 0.9,
      rationale: 'Describes experimentation',
      statutory_anchor: 's.355-25',
    },
  });

  const result = await runClaimEvidenceBindingJob({
    claim_id: CLAIM,
    tenant_id: TENANT,
  });

  assert.equal(result.status, 'allocated');
  assert.equal(result.links_created, 1);
  assert.equal(result.events_processed, 1);

  // Verify ARTEFACT_LINKED event exists with correct payload shape.
  const linkEvents = await privilegedSql<
    {
      kind: string;
      captured_by_user_id: string;
      payload: {
        activity_id: string;
        artefact_kind: string;
        artefact_id: string;
        link_reason: string;
      };
    }[]
  >`
    SELECT kind, captured_by_user_id, payload
      FROM event
     WHERE tenant_id = ${TENANT} AND kind = 'ARTEFACT_LINKED'
  `;

  assert.equal(linkEvents.length, 1);
  assert.equal(linkEvents[0]!.kind, 'ARTEFACT_LINKED');
  assert.equal(linkEvents[0]!.captured_by_user_id, AGENT_B_SYSTEM_USER_ID);
  assert.equal(linkEvents[0]!.payload.activity_id, ACTIVITY_1);
  assert.equal(linkEvents[0]!.payload.artefact_kind, 'event');
  assert.equal(linkEvents[0]!.payload.artefact_id, eventId);
  assert.ok(linkEvents[0]!.payload.link_reason);
});

// ---------------------------------------------------------------------------
// Tests: below-confidence-threshold (stub default allocation = 0.60).
// ---------------------------------------------------------------------------

test('below-confidence-threshold: no link created when stub returns 0.60', async () => {
  // Seed an activity whose title shares NO >4-char words with the evidence.
  await seedActivity({
    id: ACTIVITY_1,
    code: 'CA-01',
    kind: 'core',
    title: 'Core Work',
    hypothesis: 'Some hypothesis',
  });

  // Evidence text with no >4-char vocabulary overlap with "Core Work".
  // Stub will fall through to default first-activity allocation at 0.60.
  await seedEvidenceEvent({
    payloadText: 'Did lab tests',
    kind: 'EXPERIMENT',
    classification: {
      kind: 'EXPERIMENT',
      confidence: 0.9,
      rationale: 'Describes experimentation',
      statutory_anchor: 's.355-25',
    },
  });

  const result = await runClaimEvidenceBindingJob({
    claim_id: CLAIM,
    tenant_id: TENANT,
  });

  assert.equal(result.status, 'allocated');
  assert.equal(result.links_created, 0);
  assert.equal(result.events_processed, 1);

  // No ARTEFACT_LINKED events should exist.
  const linkEvents = await privilegedSql<{ id: string }[]>`
    SELECT id FROM event
     WHERE tenant_id = ${TENANT} AND kind = 'ARTEFACT_LINKED'
  `;
  assert.equal(linkEvents.length, 0);
});

// ---------------------------------------------------------------------------
// Tests: already-linked events are excluded.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tests: cross-tenant isolation (F3).
//
// The job uses `privilegedSql` (bypassing RLS) and relies entirely on the
// `c.tenant_id = ${input.tenant_id}` predicate in the claim-lookup SQL to
// scope rows to the calling tenant. This test pins that guard: if a claim
// exists in tenant A but the job is invoked with a different tenant_id,
// the job must short-circuit as `failed` (claim not found) and emit
// NO ARTEFACT_LINKED events. Mirrors `claim-activity-proposal.test.ts`:184.
// ---------------------------------------------------------------------------

test('claim belongs to different tenant: returns failed without emitting ARTEFACT_LINKED', async () => {
  // Set up a claim in TENANT with an activity and an unbound evidence event
  // that WOULD match the activity if the job ran in tenant A.
  await seedActivity({
    id: ACTIVITY_1,
    code: 'CA-01',
    kind: 'core',
    title: 'Machine Learning Pipeline Optimization',
    hypothesis: 'ML will improve throughput',
  });
  await seedEvidenceEvent({
    payloadText: 'Worked on the pipeline refactoring today',
    kind: 'EXPERIMENT',
    classification: {
      kind: 'EXPERIMENT',
      confidence: 0.9,
      rationale: 'Describes experimentation',
      statutory_anchor: 's.355-25',
    },
  });

  // Call the job with a foreign tenant_id — the claim row exists, but the
  // SQL `c.tenant_id = ${input.tenant_id}` predicate must hide it.
  const FOREIGN_TENANT = '00000000-0000-4000-8000-00000000dead';
  const result = await runClaimEvidenceBindingJob({
    claim_id: CLAIM,
    tenant_id: FOREIGN_TENANT,
  });

  assert.equal(result.status, 'failed');
  assert.match(result.reason ?? '', /claim not found/i);

  // No ARTEFACT_LINKED events should have been written for the activity —
  // the wrong-tenant call must NOT touch the real tenant's event log.
  const linkEvents = await privilegedSql<{ id: string }[]>`
    SELECT id FROM event
     WHERE tenant_id = ${TENANT} AND kind = 'ARTEFACT_LINKED'
  `;
  assert.equal(linkEvents.length, 0);
});

test('already-linked events are excluded from processing', async () => {
  // Seed an activity.
  await seedActivity({
    id: ACTIVITY_1,
    code: 'CA-01',
    kind: 'core',
    title: 'Machine Learning Pipeline Optimization',
    hypothesis: 'ML will improve throughput',
  });

  // Seed an evidence event with vocabulary match.
  const eventId = await seedEvidenceEvent({
    payloadText: 'Worked on the pipeline refactoring today',
    kind: 'EXPERIMENT',
    classification: {
      kind: 'EXPERIMENT',
      confidence: 0.9,
      rationale: 'Describes experimentation',
      statutory_anchor: 's.355-25',
    },
  });

  // Manually create an ARTEFACT_LINKED event for this evidence event,
  // simulating a prior binding.
  await insertEventWithChain({
    tenant_id: TENANT,
    subject_tenant_id: SUBJECT,
    project_id: PROJECT,
    kind: 'ARTEFACT_LINKED',
    payload: {
      activity_id: ACTIVITY_1,
      artefact_kind: 'event',
      artefact_id: eventId,
      link_reason: 'Previously linked',
    },
    classification: null,
    captured_at: new Date(),
    captured_by_user_id: AGENT_B_SYSTEM_USER_ID,
    override_of_event_id: null,
    override_new_kind: null,
    override_reason: null,
    idempotency_key: null,
  });

  const result = await runClaimEvidenceBindingJob({
    claim_id: CLAIM,
    tenant_id: TENANT,
  });

  assert.equal(result.status, 'allocated');
  assert.equal(result.links_created, 0);
  // The evidence event should NOT be in unbound events (already linked).
  assert.equal(result.events_processed, 0);

  // Only the manually-created ARTEFACT_LINKED event should exist (no new ones).
  const linkEvents = await privilegedSql<{ id: string }[]>`
    SELECT id FROM event
     WHERE tenant_id = ${TENANT} AND kind = 'ARTEFACT_LINKED'
  `;
  assert.equal(linkEvents.length, 1);
});

// ---------------------------------------------------------------------------
// Tests: partial-failure isolation (F4).
//
// The job iterates unbound evidence events and calls the allocator inside a
// per-event try/catch. If the allocator throws for one event, the job MUST
// continue processing the remaining events. The stub allocator exposes an
// ALLOCATOR_STUB_THROW_ON_EVENT_ID env-var hook so tests can target one
// specific event_id for synthetic failure without affecting others.
// ---------------------------------------------------------------------------

test('Haiku throws on one event of N: surviving events still get ARTEFACT_LINKED', async () => {
  // Seed an activity whose title shares >4-char vocabulary with both events
  // ("pipeline") so the stub returns confidence 0.72 (above threshold 0.65).
  await seedActivity({
    id: ACTIVITY_1,
    code: 'CA-01',
    kind: 'core',
    title: 'Machine Learning Pipeline Optimization',
    hypothesis: 'ML will improve throughput',
  });

  // Seed two unbound evidence events. eventX will be the one the stub throws
  // on; eventY must still produce an ARTEFACT_LINKED event.
  const eventX_id = await seedEvidenceEvent({
    payloadText: 'Worked on the pipeline refactoring today',
    kind: 'EXPERIMENT',
    classification: {
      kind: 'EXPERIMENT',
      confidence: 0.9,
      rationale: 'Describes experimentation',
      statutory_anchor: 's.355-25',
    },
  });
  const eventY_id = await seedEvidenceEvent({
    payloadText: 'More pipeline experimentation results',
    kind: 'EXPERIMENT',
    classification: {
      kind: 'EXPERIMENT',
      confidence: 0.9,
      rationale: 'Describes experimentation',
      statutory_anchor: 's.355-25',
    },
  });

  process.env.ALLOCATOR_STUB_THROW_ON_EVENT_ID = eventX_id;

  try {
    const result = await runClaimEvidenceBindingJob({
      claim_id: CLAIM,
      tenant_id: TENANT,
    });

    // Job-level contract: 'allocated' even when a per-event allocator call
    // throws — partial failures are absorbed inside the per-event try/catch.
    assert.equal(result.status, 'allocated');
    // Both events were attempted; only one produced a link.
    assert.equal(result.events_processed, 2);
    assert.equal(result.links_created, 1);

    // Confirm exactly one ARTEFACT_LINKED row exists, and it points at eventY.
    const linkEvents = await privilegedSql<
      {
        payload: { artefact_id: string; activity_id: string };
      }[]
    >`
      SELECT payload FROM event
       WHERE tenant_id = ${TENANT} AND kind = 'ARTEFACT_LINKED'
    `;
    assert.equal(linkEvents.length, 1);
    assert.equal(linkEvents[0]!.payload.artefact_id, eventY_id);
    assert.equal(linkEvents[0]!.payload.activity_id, ACTIVITY_1);

    // Defensive: explicitly assert NO ARTEFACT_LINKED was emitted for eventX.
    const linkedForX = linkEvents.filter((e) => e.payload.artefact_id === eventX_id);
    assert.equal(linkedForX.length, 0);
  } finally {
    delete process.env.ALLOCATOR_STUB_THROW_ON_EVENT_ID;
  }
});

// ---------------------------------------------------------------------------
// Tests: pg-boss worker retry semantics (Fix 2).
//
// The job's pg-boss wrapper (handleClaimEvidenceBindingJob) must THROW on
// transient failures so pg-boss engages its retry policy. Permanent
// failures (invalid input, claim not found) must return as-is — retrying
// won't help and would just churn the queue.
// ---------------------------------------------------------------------------

test('handleClaimEvidenceBindingJob: transient outer failure throws so pg-boss can retry', async () => {
  // CLAIM_EVIDENCE_BINDING_THROW_TRANSIENT=1 makes the job throw inside
  // its outer try block — the catch returns { status:'failed', reason:
  // 'Synthetic transient binding-job failure' }. That reason is NOT in
  // PERMANENT_FAILURE_REASONS, so the worker wrapper must rethrow.
  process.env.CLAIM_EVIDENCE_BINDING_THROW_TRANSIENT = '1';
  try {
    await assert.rejects(
      () =>
        handleClaimEvidenceBindingJob({
          claim_id: CLAIM,
          tenant_id: TENANT,
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Transient failure, will retry/);
        return true;
      },
    );
  } finally {
    delete process.env.CLAIM_EVIDENCE_BINDING_THROW_TRANSIENT;
  }
});

test('handleClaimEvidenceBindingJob: permanent failure (invalid input) does NOT throw', async () => {
  const result = await handleClaimEvidenceBindingJob({
    // @ts-expect-error -- intentionally invalid for the test
    claim_id: 'not-a-uuid',
    tenant_id: TENANT,
  });
  assert.equal(result.status, 'failed');
  assert.match(result.reason ?? '', /invalid job input/);
});

test('handleClaimEvidenceBindingJob: permanent failure (claim not found) does NOT throw', async () => {
  const result = await handleClaimEvidenceBindingJob({
    claim_id: '00000000-0000-4000-8000-00000000dead',
    tenant_id: TENANT,
  });
  assert.equal(result.status, 'failed');
  assert.match(result.reason ?? '', /claim not found/);
});
