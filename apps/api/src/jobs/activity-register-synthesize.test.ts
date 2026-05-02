import { test, after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sql, privilegedSql } from '@cpa/db/client';
import { insertEventWithChain, verifyChain } from '@cpa/db';
import { _reloadEnvForTests } from '@cpa/agents/runtime';

// Force the stub impl. The factory respects this verbatim. Set BEFORE the job
// module loads so makeRegisterSynthesizer() picks it up on first call.
process.env.ACTIVITY_REGISTER_SYNTHESIZER_IMPL = 'stub';

// Default-on flags for happy paths. Per-test overrides reload via
// _reloadEnvForTests after mutating process.env.
delete process.env.P6_AGENT_B_ENABLED;
delete process.env.P6_AGENT_TENANT_ALLOWLIST;
_reloadEnvForTests();

// Import AFTER env is configured.
const {
  AGENT_B_SYSTEM_USER_ID,
  REGISTER_SYNTHESIZE_EVENT_CAP,
  buildIdempotencyKey,
  compressEvent,
  deriveAuFiscalYear,
  runActivityRegisterSynthesizeJob,
  truncateToFiftyWords,
} = await import('./activity-register-synthesize.js');

// ---------------------------------------------------------------------------
// Pinned UUIDs — `0b00` segment groups all Theme 4 Task 4.3 fixtures so they
// don't collide with chain.test.ts (`0d03`), audit-score (`0d03`), transcribe
// (`0a30`), etc.
// ---------------------------------------------------------------------------

const TENANT = '00000000-0000-4000-8000-0000000b0040';
const TENANT_OTHER = '00000000-0000-4000-8000-0000000b0041';
const ADMIN_USER = '00000000-0000-4000-8000-0000000b0050';
const SUBJECT = '00000000-0000-4000-8000-0000000b0060';
const PROJECT = '00000000-0000-4000-8000-0000000b0070';
const PROJECT_OTHER_TENANT = '00000000-0000-4000-8000-0000000b0071';
const CLAIM = '00000000-0000-4000-8000-0000000b0080';
const ACTIVITY = '00000000-0000-4000-8000-0000000b0090';

const cleanup = async (): Promise<void> => {
  await privilegedSql`DELETE FROM agent_call_cache WHERE agent_name = 'activity-register-synthesizer'`;
  await privilegedSql`DELETE FROM event WHERE tenant_id IN (${TENANT}, ${TENANT_OTHER})`;
  await privilegedSql`DELETE FROM activity WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM claim WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM project WHERE tenant_id IN (${TENANT}, ${TENANT_OTHER})`;
  await privilegedSql`DELETE FROM subject_tenant WHERE tenant_id IN (${TENANT}, ${TENANT_OTHER})`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id IN (${TENANT}, ${TENANT_OTHER})`;
  // Note: AGENT_B_SYSTEM_USER_ID is seeded by migration 0033 and persists
  // across test runs — do NOT delete it here, or subsequent runs would
  // miss the row the chain insert FKs against.
  await sql`DELETE FROM "user" WHERE id = ${ADMIN_USER}`;
  await sql`DELETE FROM tenant WHERE id IN (${TENANT}, ${TENANT_OTHER})`;
};

before(async () => {
  await cleanup();
  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT}, 'Firm B40', 'firm-b40', 'mixed'),
                   (${TENANT_OTHER}, 'Firm B41', 'firm-b41', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${ADMIN_USER}, 'b40-admin@example.com', 'microsoft', 'microsoft:b40-admin', 'B40 Admin')`;
  // AGENT_B_SYSTEM_USER_ID is seeded by migration 0033. Insert idempotently
  // here as a belt-and-braces guard so the test suite can also run against
  // a fresh DB on which the migration was rolled back; ON CONFLICT keeps the
  // migration-seeded row authoritative when both ran.
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${AGENT_B_SYSTEM_USER_ID}, 'system+agent-b@cpa.local', 'microsoft', 'system:agent-b', 'Agent B (Activity Register Synthesizer)')
            ON CONFLICT (id) DO NOTHING`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT}, ${ADMIN_USER}, 'admin', true)`;
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                       VALUES (${SUBJECT}, ${TENANT}, 'Acme R&D', 'claimant')`;
  await privilegedSql`INSERT INTO project (id, tenant_id, subject_tenant_id, name, started_at)
                       VALUES (${PROJECT}, ${TENANT}, ${SUBJECT}, 'ML Pipeline Rebuild', '2024-07-01T00:00:00Z'),
                              (${PROJECT_OTHER_TENANT}, ${TENANT_OTHER}, ${SUBJECT}, 'Wrong tenant project', '2024-07-01T00:00:00Z')`;
  await privilegedSql`INSERT INTO claim (id, tenant_id, subject_tenant_id, project_id, fiscal_year, stage)
                       VALUES (${CLAIM}, ${TENANT}, ${SUBJECT}, ${PROJECT}, 2025, 'engagement')`;
  await privilegedSql`INSERT INTO activity (id, tenant_id, project_id, claim_id, code, kind, title, description)
                       VALUES (${ACTIVITY}, ${TENANT}, ${PROJECT}, ${CLAIM}, 'CA-01', 'core', 'Existing accepted activity', 'pre-baked')`;
});

// Per-test isolation: clear events + cache, but keep tenant/user/project/activity
// fixtures intact so each test starts from a known steady state.
beforeEach(async () => {
  await privilegedSql`DELETE FROM event WHERE tenant_id IN (${TENANT}, ${TENANT_OTHER})`;
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

/**
 * Seed a single SUPPORTING evidence event for the test project. Kept as a
 * helper so individual tests express what they need (count, payload-text)
 * declaratively.
 */
async function seedEvent(args: {
  payloadText?: string;
  capturedAt?: Date;
  kind?: string;
}): Promise<{ id: string }> {
  const payload = args.payloadText !== undefined ? { _v: 1, text: args.payloadText } : { _v: 1 };
  const inserted = await insertEventWithChain({
    tenant_id: TENANT,
    subject_tenant_id: SUBJECT,
    project_id: PROJECT,
    kind: args.kind ?? 'SUPPORTING',
    payload,
    classification: null,
    captured_at: args.capturedAt ?? new Date(),
    captured_by_user_id: ADMIN_USER,
    override_of_event_id: null,
    override_new_kind: null,
    override_reason: null,
    idempotency_key: null,
  });
  return { id: inserted.id };
}

// ---------------------------------------------------------------------------
// Unit tests for the helpers — fast, no DB.
// ---------------------------------------------------------------------------

test('truncateToFiftyWords: returns the whole string for short input', () => {
  const out = truncateToFiftyWords('a b c d e');
  assert.equal(out, 'a b c d e');
});

test('truncateToFiftyWords: trims to exactly 50 words for 100-word input', () => {
  const hundred = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ');
  const out = truncateToFiftyWords(hundred);
  assert.equal(out.split(/\s+/).length, 50);
  assert.equal(out, Array.from({ length: 50 }, (_, i) => `w${i}`).join(' '));
});

test('truncateToFiftyWords: returns empty string for non-string input', () => {
  assert.equal(truncateToFiftyWords(null), '');
  assert.equal(truncateToFiftyWords(undefined), '');
  assert.equal(truncateToFiftyWords(42), '');
});

test('compressEvent: prefers payload.text over payload.raw_text', () => {
  const out = compressEvent({
    id: 'e1',
    kind: 'SUPPORTING',
    captured_at: new Date('2024-08-01T00:00:00Z'),
    payload: { text: 'pasted text', raw_text: 'voice transcript' },
    subject_tenant_id: SUBJECT,
  });
  assert.equal(out.summary, 'pasted text');
});

test('compressEvent: falls back to payload.raw_text when text is absent', () => {
  const out = compressEvent({
    id: 'e1',
    kind: 'SUPPORTING',
    captured_at: new Date('2024-08-01T00:00:00Z'),
    payload: { raw_text: 'voice transcript' },
    subject_tenant_id: SUBJECT,
  });
  assert.equal(out.summary, 'voice transcript');
});

test('buildIdempotencyKey: stable across event id ordering', () => {
  const k1 = buildIdempotencyKey({
    project_id: PROJECT,
    event_ids: ['e-c', 'e-a', 'e-b'],
    existing_activity_ids: [ACTIVITY],
  });
  const k2 = buildIdempotencyKey({
    project_id: PROJECT,
    event_ids: ['e-a', 'e-b', 'e-c'],
    existing_activity_ids: [ACTIVITY],
  });
  assert.equal(k1, k2);
});

test('deriveAuFiscalYear: July 1 rolls into the next FY', () => {
  // FY2025 = 1 July 2024 – 30 June 2025.
  assert.equal(deriveAuFiscalYear(new Date('2024-07-01T00:00:00Z')), 2025);
});

test('deriveAuFiscalYear: June 30 stays in the current FY', () => {
  // 30 June 2024 is the last day of FY2024.
  assert.equal(deriveAuFiscalYear(new Date('2024-06-30T23:59:59Z')), 2024);
});

test('deriveAuFiscalYear: January is in the FY ending that calendar year', () => {
  // 15 Jan 2025 is FY2025 (the FY ending 30 June 2025).
  assert.equal(deriveAuFiscalYear(new Date('2025-01-15T00:00:00Z')), 2025);
});

test('deriveAuFiscalYear: December rolls into next-calendar-year FY', () => {
  // 31 Dec 2024 is FY2025 (the FY ending 30 June 2025).
  assert.equal(deriveAuFiscalYear(new Date('2024-12-31T00:00:00Z')), 2025);
});

test('buildIdempotencyKey: differs when project changes', () => {
  const k1 = buildIdempotencyKey({
    project_id: PROJECT,
    event_ids: ['e-a'],
    existing_activity_ids: [],
  });
  const k2 = buildIdempotencyKey({
    project_id: 'other-project',
    event_ids: ['e-a'],
    existing_activity_ids: [],
  });
  assert.notEqual(k1, k2);
});

// ---------------------------------------------------------------------------
// Integration tests — exercise the full job against a real DB.
// ---------------------------------------------------------------------------

test('feature flag disabled: returns skipped_disabled, no DB read', async () => {
  process.env.P6_AGENT_B_ENABLED = 'false';
  _reloadEnvForTests();
  const result = await runActivityRegisterSynthesizeJob({
    tenant_id: TENANT,
    project_id: PROJECT,
  });
  assert.equal(result.status, 'skipped_disabled');
  assert.match(result.reason ?? '', /P6_AGENT_B_ENABLED/);
});

test('tenant not in allowlist: returns skipped_disabled', async () => {
  process.env.P6_AGENT_TENANT_ALLOWLIST = '00000000-0000-0000-0000-deadbeef0000';
  _reloadEnvForTests();
  const result = await runActivityRegisterSynthesizeJob({
    tenant_id: TENANT,
    project_id: PROJECT,
  });
  assert.equal(result.status, 'skipped_disabled');
  // Case-insensitive — production reason string mentions
  // `P6_AGENT_TENANT_ALLOWLIST` (uppercased env-var name); we just want to
  // assert the concept, not exact casing.
  assert.match(result.reason ?? '', /allowlist/i);
});

test('project not found: returns failed with reason', async () => {
  const result = await runActivityRegisterSynthesizeJob({
    tenant_id: TENANT,
    project_id: '00000000-0000-4000-8000-00000000dead',
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'project not found');
});

test('project belongs to a different tenant: returns failed', async () => {
  // PROJECT_OTHER_TENANT exists but under TENANT_OTHER. Calling with TENANT
  // must not see it (the WHERE tenant_id bind narrows the row out).
  const result = await runActivityRegisterSynthesizeJob({
    tenant_id: TENANT,
    project_id: PROJECT_OTHER_TENANT,
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'project not found');
});

test('empty events: synthesizes an event with proposed_activity_count = 0', async () => {
  const result = await runActivityRegisterSynthesizeJob({
    tenant_id: TENANT,
    project_id: PROJECT,
  });
  assert.equal(result.status, 'synthesized');
  assert.equal(result.proposed_activity_count, 0);
  assert.equal(result.unclustered_event_count, 0);
  assert.equal(result.events_truncated, false);

  // The chain row should exist with the right kind + system user.
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

test('single event happy path: stub clusters into 1 proposed activity', async () => {
  await seedEvent({ payloadText: 'experimented with novel optimiser' });

  const result = await runActivityRegisterSynthesizeJob({
    tenant_id: TENANT,
    project_id: PROJECT,
  });
  assert.equal(result.status, 'synthesized');
  assert.equal(result.proposed_activity_count, 1);
  assert.equal(result.unclustered_event_count, 0);
  assert.equal(result.events_truncated, false);
});

test('truncation: 201 events → events_truncated=true, total_input_events=200', async () => {
  // Seed cap+1 events. captured_at strictly increasing so DESC ordering is
  // unambiguous; all in 2024-08 so they share an ISO week (which keeps the
  // stub's bucket count low and below the 30-cap).
  const base = new Date('2024-08-01T00:00:00Z').getTime();
  for (let i = 0; i < REGISTER_SYNTHESIZE_EVENT_CAP + 1; i++) {
    await seedEvent({
      payloadText: `event ${i}`,
      // Stagger by 1ms each so captured_at ordering is total + stable.
      capturedAt: new Date(base + i),
    });
  }

  const result = await runActivityRegisterSynthesizeJob({
    tenant_id: TENANT,
    project_id: PROJECT,
  });
  assert.equal(result.status, 'synthesized');
  assert.equal(result.events_truncated, true);

  const rows = await privilegedSql<
    { payload: { total_input_events: number; events_truncated: boolean } }[]
  >`
    SELECT payload
      FROM event
     WHERE tenant_id = ${TENANT} AND kind = 'ACTIVITY_REGISTER_DRAFTED'
  `;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.payload.total_input_events, REGISTER_SYNTHESIZE_EVENT_CAP);
  assert.equal(rows[0]?.payload.events_truncated, true);
});

test('idempotency: second call returns skipped_idempotent, no second event', async () => {
  await seedEvent({ payloadText: 'design doc draft' });

  const r1 = await runActivityRegisterSynthesizeJob({
    tenant_id: TENANT,
    project_id: PROJECT,
  });
  assert.equal(r1.status, 'synthesized');

  const r2 = await runActivityRegisterSynthesizeJob({
    tenant_id: TENANT,
    project_id: PROJECT,
  });
  assert.equal(r2.status, 'skipped_idempotent');

  const countRows = await privilegedSql<{ c: string }[]>`
    SELECT COUNT(*)::text AS c FROM event
     WHERE tenant_id = ${TENANT} AND kind = 'ACTIVITY_REGISTER_DRAFTED'
  `;
  assert.equal(countRows[0]?.c, '1');
});

test('compressed event summary: 100-word payload trimmed to exactly 50 words', async () => {
  const hundred = Array.from({ length: 100 }, (_, i) => `tok${i}`).join(' ');
  await seedEvent({ payloadText: hundred });

  await runActivityRegisterSynthesizeJob({
    tenant_id: TENANT,
    project_id: PROJECT,
  });

  // The compression happens inside the job before the synth call. To
  // assert the 50-word cap we re-run compressEvent on the seeded row.
  const rows = await privilegedSql<
    {
      id: string;
      kind: string;
      captured_at: Date;
      payload: { text: string };
      subject_tenant_id: string;
    }[]
  >`
    SELECT id, kind, captured_at, payload, subject_tenant_id
      FROM event
     WHERE tenant_id = ${TENANT} AND kind = 'SUPPORTING'
  `;
  assert.equal(rows.length, 1);
  const compressed = compressEvent({
    id: rows[0]!.id,
    kind: rows[0]!.kind,
    captured_at: rows[0]!.captured_at,
    payload: rows[0]!.payload,
    subject_tenant_id: rows[0]!.subject_tenant_id,
  });
  assert.equal(compressed.summary.split(/\s+/).length, 50);
});

test('telemetry metadata: persisted payload carries model + prompt_version', async () => {
  // We assert the wire-level evidence that the synthesizer call ran under
  // withAgentSpan: the payload picks up `model` + `prompt_version` from the
  // synthesizer output, both of which are stamped by the impl via setAttr in
  // withAgentSpan. A direct OTel-span recording test would require importing
  // @opentelemetry/api into the API package; the agents package already
  // covers cost_usd recording in `runtime/telemetry.test.ts`.
  await seedEvent({ payloadText: 'telemetry-trigger event' });

  await runActivityRegisterSynthesizeJob({
    tenant_id: TENANT,
    project_id: PROJECT,
  });

  const rows = await privilegedSql<{ payload: { model: string; prompt_version: string } }[]>`
    SELECT payload
      FROM event
     WHERE tenant_id = ${TENANT} AND kind = 'ACTIVITY_REGISTER_DRAFTED'
  `;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.payload.prompt_version, 'synthesize-register@1.0.0');
  // Stub impl always reports model 'stub-v1.0.0' (see synthesizer-register/stub.ts).
  assert.equal(rows[0]?.payload.model, 'stub-v1.0.0');
});

test('chain integrity: verifyChain returns verified after a successful run', async () => {
  await seedEvent({ payloadText: 'chain integrity test event' });

  const r = await runActivityRegisterSynthesizeJob({
    tenant_id: TENANT,
    project_id: PROJECT,
  });
  assert.equal(r.status, 'synthesized');

  const status = await verifyChain(SUBJECT);
  assert.equal(status.verified, true, 'chain must verify after the synth event lands');
  // 1 seeded SUPPORTING + 1 ACTIVITY_REGISTER_DRAFTED = 2.
  assert.equal(status.event_count, 2);
});
