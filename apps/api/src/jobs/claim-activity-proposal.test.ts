import { test, after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sql, privilegedSql } from '@cpa/db/client';
import { insertEventWithChain } from '@cpa/db';
import { _reloadEnvForTests } from '@cpa/agents/runtime';

// Force the stub synthesizer impl before the job module loads.
process.env.ACTIVITY_REGISTER_SYNTHESIZER_IMPL = 'stub';

// Default-on flags for happy paths. Per-test overrides reload via
// _reloadEnvForTests after mutating process.env.
delete process.env.P6_AGENT_B_ENABLED;
delete process.env.P6_AGENT_TENANT_ALLOWLIST;
_reloadEnvForTests();

// Import AFTER env is configured.
const { AGENT_B_SYSTEM_USER_ID } = await import('./activity-register-synthesize.js');
const { runClaimActivityProposalJob, handleClaimActivityProposalJob } =
  await import('./claim-activity-proposal.js');

// ---------------------------------------------------------------------------
// Pinned UUIDs — `0c31` segment groups all Task 3.1 fixtures.
// ---------------------------------------------------------------------------

const TENANT = '00000000-0000-4000-8000-0000000c3101';
const ADMIN_USER = '00000000-0000-4000-8000-0000000c3110';
const SUBJECT = '00000000-0000-4000-8000-0000000c3120';
const PROJECT = '00000000-0000-4000-8000-0000000c3130';
const CLAIM = '00000000-0000-4000-8000-0000000c3140';
const CLAIM_NO_WORKFLOW = '00000000-0000-4000-8000-0000000c3141';
// Second claim on the same project, different fiscal year — for the
// multi-claim cache-isolation test (Fix 1).
const CLAIM_FY26 = '00000000-0000-4000-8000-0000000c3142';

const cleanup = async (): Promise<void> => {
  await privilegedSql`DELETE FROM agent_call_cache WHERE agent_name = 'activity-register-synthesizer'`;
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
            VALUES (${TENANT}, 'Firm C31', 'firm-c31', 'mixed')`;

  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${ADMIN_USER}, 'c31-admin@example.com', 'microsoft', 'microsoft:c31-admin', 'C31 Admin')`;

  // Seed AGENT_B_SYSTEM_USER_ID idempotently (seeded by migration 0033;
  // belt-and-braces guard so the test also runs on fresh DBs).
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${AGENT_B_SYSTEM_USER_ID}, 'system+agent-b@cpa.local', 'microsoft', 'system:agent-b', 'Agent B (Activity Register Synthesizer)')
            ON CONFLICT (id) DO NOTHING`;

  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT}, ${ADMIN_USER}, 'admin', true)`;

  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                       VALUES (${SUBJECT}, ${TENANT}, 'Acme R&D C31', 'claimant')`;

  await privilegedSql`INSERT INTO project (id, tenant_id, subject_tenant_id, name, started_at)
                       VALUES (${PROJECT}, ${TENANT}, ${SUBJECT}, 'ML Pipeline Rebuild C31', '2024-07-01T00:00:00Z')`;

  // Main test claim with workflow_state set (initialized wizard).
  const workflowState = JSON.stringify({
    initialized_at: new Date().toISOString(),
    steps: { '1': null, '2': null, '3': null, '4': null, '5': null },
  });
  await privilegedSql`INSERT INTO claim (id, tenant_id, subject_tenant_id, project_id, fiscal_year, stage, workflow_state)
                       VALUES (${CLAIM}, ${TENANT}, ${SUBJECT}, ${PROJECT}, 2025, 'engagement', ${workflowState}::text::jsonb)`;

  // Claim without workflow_state (pre-wizard "legacy" claim).
  await privilegedSql`INSERT INTO claim (id, tenant_id, subject_tenant_id, project_id, fiscal_year, stage)
                       VALUES (${CLAIM_NO_WORKFLOW}, ${TENANT}, ${SUBJECT}, ${PROJECT}, 2026, 'engagement')`;

  // Second claim on the SAME project, a DIFFERENT fiscal year — exercises
  // the per-claim idempotency-key scoping (Fix 1). Uses its own
  // workflow_state so the job can advance past the claim-lookup guard.
  const workflowStateFY27 = JSON.stringify({
    initialized_at: new Date().toISOString(),
    steps: { '1': null, '2': null, '3': null, '4': null, '5': null },
  });
  await privilegedSql`INSERT INTO claim (id, tenant_id, subject_tenant_id, project_id, fiscal_year, stage, workflow_state)
                       VALUES (${CLAIM_FY26}, ${TENANT}, ${SUBJECT}, ${PROJECT}, 2027, 'engagement', ${workflowStateFY27}::text::jsonb)`;
});

// Per-test isolation: clear events + cache, reset feature flags.
beforeEach(async () => {
  await privilegedSql`DELETE FROM event WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM agent_call_cache WHERE agent_name = 'activity-register-synthesizer'`;
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
// Helper: seed a single SUPPORTING evidence event for the test project.
// ---------------------------------------------------------------------------
async function seedEvent(args: { payloadText?: string; capturedAt?: Date } = {}): Promise<void> {
  const payload = args.payloadText !== undefined ? { _v: 1, text: args.payloadText } : { _v: 1 };
  await insertEventWithChain({
    tenant_id: TENANT,
    subject_tenant_id: SUBJECT,
    project_id: PROJECT,
    kind: 'SUPPORTING',
    payload,
    classification: null,
    captured_at: args.capturedAt ?? new Date(),
    captured_by_user_id: ADMIN_USER,
    override_of_event_id: null,
    override_new_kind: null,
    override_reason: null,
    idempotency_key: null,
  });
}

// ---------------------------------------------------------------------------
// Tests: feature flag / tenant gate (no DB needed).
// ---------------------------------------------------------------------------

test('feature flag disabled: returns skipped_disabled, no DB read', async () => {
  process.env.P6_AGENT_B_ENABLED = 'false';
  _reloadEnvForTests();
  const result = await runClaimActivityProposalJob({
    claim_id: CLAIM,
    tenant_id: TENANT,
  });
  assert.equal(result.status, 'skipped_disabled');
  assert.match(result.reason ?? '', /P6_AGENT_B_ENABLED/);
});

test('tenant not in allowlist: returns skipped_disabled', async () => {
  process.env.P6_AGENT_TENANT_ALLOWLIST = '00000000-0000-0000-0000-deadbeef0000';
  _reloadEnvForTests();
  const result = await runClaimActivityProposalJob({
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
  const result = await runClaimActivityProposalJob({ tenant_id: TENANT });
  assert.equal(result.status, 'failed');
  assert.match(result.reason ?? '', /invalid job input/i);
});

test('invalid input: non-UUID claim_id returns failed', async () => {
  const result = await runClaimActivityProposalJob({
    claim_id: 'not-a-uuid',
    tenant_id: TENANT,
  });
  assert.equal(result.status, 'failed');
  assert.match(result.reason ?? '', /invalid job input/i);
});

// ---------------------------------------------------------------------------
// Tests: claim lookup failures.
// ---------------------------------------------------------------------------

test('claim not found: returns failed with reason', async () => {
  const result = await runClaimActivityProposalJob({
    claim_id: '00000000-0000-4000-8000-00000000dead',
    tenant_id: TENANT,
  });
  assert.equal(result.status, 'failed');
  assert.match(result.reason ?? '', /claim not found/);
});

test('claim exists but has no workflow_state: returns failed', async () => {
  const result = await runClaimActivityProposalJob({
    claim_id: CLAIM_NO_WORKFLOW,
    tenant_id: TENANT,
  });
  assert.equal(result.status, 'failed');
  assert.match(result.reason ?? '', /claim not found or has no workflow_state/);
});

test('claim belongs to different tenant: returns failed', async () => {
  const result = await runClaimActivityProposalJob({
    claim_id: CLAIM,
    tenant_id: '00000000-0000-4000-8000-00000000dead',
  });
  assert.equal(result.status, 'failed');
  assert.match(result.reason ?? '', /claim not found/);
});

// ---------------------------------------------------------------------------
// Tests: happy path (stub synthesizer).
// ---------------------------------------------------------------------------

test('happy path with no events: synthesizes ACTIVITY_REGISTER_DRAFTED with 0 proposals', async () => {
  const result = await runClaimActivityProposalJob({
    claim_id: CLAIM,
    tenant_id: TENANT,
  });

  assert.equal(result.status, 'synthesized');
  assert.equal(result.proposed_activity_count, 0);
  assert.equal(result.unclustered_event_count, 0);
  assert.equal(result.events_truncated, false);

  // Verify the chain event was written.
  const rows = await privilegedSql<
    { kind: string; captured_by_user_id: string; payload: { proposed_activities: unknown[] } }[]
  >`
    SELECT kind, captured_by_user_id, payload
      FROM event
     WHERE tenant_id = ${TENANT} AND kind = 'ACTIVITY_REGISTER_DRAFTED'
  `;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.kind, 'ACTIVITY_REGISTER_DRAFTED');
  assert.equal(rows[0]?.captured_by_user_id, AGENT_B_SYSTEM_USER_ID);
  assert.deepEqual(rows[0]?.payload.proposed_activities, []);
});

test('happy path with one event: stub clusters into 1 proposed activity', async () => {
  await seedEvent({ payloadText: 'experimented with novel ML optimiser' });

  const result = await runClaimActivityProposalJob({
    claim_id: CLAIM,
    tenant_id: TENANT,
  });

  assert.equal(result.status, 'synthesized');
  assert.equal(result.proposed_activity_count, 1);
  assert.equal(result.unclustered_event_count, 0);
  assert.equal(result.events_truncated, false);
});

test('idempotency: second call with same events returns skipped_idempotent, no duplicate event', async () => {
  await seedEvent({ payloadText: 'design doc draft' });

  const r1 = await runClaimActivityProposalJob({
    claim_id: CLAIM,
    tenant_id: TENANT,
  });
  assert.equal(r1.status, 'synthesized');

  const r2 = await runClaimActivityProposalJob({
    claim_id: CLAIM,
    tenant_id: TENANT,
  });
  assert.equal(r2.status, 'skipped_idempotent');
  assert.match(r2.reason ?? '', /cache hit/);

  // Only one ACTIVITY_REGISTER_DRAFTED event should exist.
  const countRows = await privilegedSql<{ c: string }[]>`
    SELECT COUNT(*)::text AS c FROM event
     WHERE tenant_id = ${TENANT} AND kind = 'ACTIVITY_REGISTER_DRAFTED'
  `;
  assert.equal(countRows[0]?.c, '1');
});

// ---------------------------------------------------------------------------
// Tests: multi-claim cache isolation (Fix 1).
//
// Two claims on the same project with overlapping evidence sets must each
// emit their own ACTIVITY_REGISTER_DRAFTED. Without per-claim cache scoping
// (claim_id + fiscal_year in the idempotency key), Claim B would short-
// circuit on Claim A's cache hit and silently skip.
// ---------------------------------------------------------------------------

test("multi-claim cache isolation: Claim B does not inherit Claim A's cache on shared events", async () => {
  // Single shared evidence event — both claims see the same project event set.
  await seedEvent({ payloadText: 'shared evidence across both claims' });

  // First run: Claim A (FY2025). Should synthesize a fresh draft and write cache.
  const rA = await runClaimActivityProposalJob({
    claim_id: CLAIM,
    tenant_id: TENANT,
  });
  assert.equal(rA.status, 'synthesized');

  // Second run: Claim B (FY2027) on the same project + same event set.
  // With Fix 1, the per-claim cache key differs from Claim A's, so this
  // call must NOT return skipped_idempotent — it must synthesize its own
  // ACTIVITY_REGISTER_DRAFTED event.
  const rB = await runClaimActivityProposalJob({
    claim_id: CLAIM_FY26,
    tenant_id: TENANT,
  });
  assert.equal(
    rB.status,
    'synthesized',
    `Claim B should synthesize, not inherit Claim A's cache hit. status=${rB.status} reason=${rB.reason ?? ''}`,
  );

  // Verify TWO ACTIVITY_REGISTER_DRAFTED events exist — one per claim.
  const draftedRows = await privilegedSql<{ c: string }[]>`
    SELECT COUNT(*)::text AS c FROM event
     WHERE tenant_id = ${TENANT} AND kind = 'ACTIVITY_REGISTER_DRAFTED'
  `;
  assert.equal(draftedRows[0]?.c, '2');

  // Sanity: running Claim A a second time SHOULD still short-circuit on
  // its own cache (per-claim scoping does not break the within-claim
  // idempotency guarantee).
  const rA2 = await runClaimActivityProposalJob({
    claim_id: CLAIM,
    tenant_id: TENANT,
  });
  assert.equal(rA2.status, 'skipped_idempotent');
});

test('payload carries correct metadata: project_id, model, prompt_version', async () => {
  await seedEvent({ payloadText: 'telemetry-trigger event' });

  await runClaimActivityProposalJob({
    claim_id: CLAIM,
    tenant_id: TENANT,
  });

  const rows = await privilegedSql<
    { payload: { project_id: string; model: string; prompt_version: string } }[]
  >`
    SELECT payload
      FROM event
     WHERE tenant_id = ${TENANT} AND kind = 'ACTIVITY_REGISTER_DRAFTED'
  `;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.payload.project_id, PROJECT);
  assert.equal(rows[0]?.payload.prompt_version, 'synthesize-register@1.0.0');
  // Stub always reports model 'stub-v1.0.0'.
  assert.equal(rows[0]?.payload.model, 'stub-v1.0.0');
});

// ---------------------------------------------------------------------------
// Tests: pg-boss worker retry semantics (Fix 2).
//
// The job's pg-boss wrapper (handleClaimActivityProposalJob) must THROW on
// transient failures so pg-boss engages its retry policy. Permanent
// failures (invalid input, claim not found) must return as-is — retrying
// won't help and would just churn the queue.
// ---------------------------------------------------------------------------

test('handleClaimActivityProposalJob: transient synthesizer failure throws so pg-boss can retry', async () => {
  await seedEvent({ payloadText: 'a synth-driving event' });

  // SYNTHESIZER_STUB_THROW=1 makes the stub synthesizer throw synchronously
  // inside withAgentSpan — the job's outer try/catch absorbs it and
  // returns { status:'failed', reason:'Synthetic stub synthesizer failure' }.
  // That reason is NOT in PERMANENT_FAILURE_REASONS, so the worker
  // wrapper must rethrow.
  process.env.SYNTHESIZER_STUB_THROW = '1';
  try {
    await assert.rejects(
      () =>
        handleClaimActivityProposalJob({
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
    delete process.env.SYNTHESIZER_STUB_THROW;
  }
});

test('handleClaimActivityProposalJob: permanent failure (invalid input) does NOT throw', async () => {
  // Zod-rejected input → reason starts with 'invalid job input' which IS
  // in PERMANENT_FAILURE_REASONS. The wrapper must return the failed
  // result as-is so pg-boss treats the job as succeeded (no retry).
  const result = await handleClaimActivityProposalJob({
    // @ts-expect-error -- intentionally invalid for the test
    claim_id: 'not-a-uuid',
    tenant_id: TENANT,
  });
  assert.equal(result.status, 'failed');
  assert.match(result.reason ?? '', /invalid job input/);
});

test('handleClaimActivityProposalJob: permanent failure (claim not found) does NOT throw', async () => {
  // 'claim not found' is permanent — the row doesn't exist; retrying is
  // pointless. The wrapper must return as-is.
  const result = await handleClaimActivityProposalJob({
    claim_id: '00000000-0000-4000-8000-00000000dead',
    tenant_id: TENANT,
  });
  assert.equal(result.status, 'failed');
  assert.match(result.reason ?? '', /claim not found/);
});
