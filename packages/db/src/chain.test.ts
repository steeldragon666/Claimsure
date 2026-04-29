import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { canonicaliseEvent, hashEvent, insertEventWithChain, verifyChain } from './chain.js';
import { sql } from './client.js';

const TENANT_ID = '00000000-0000-4000-8000-0000c0001111';
const SUBJECT_ID = '00000000-0000-4000-8000-0000c0002222';
const USER_ID = '00000000-0000-4000-8000-0000c0003333';

before(async () => {
  await sql.begin(async (tx) => {
    await tx`INSERT INTO tenant (id, name, slug, primary_idp) VALUES (${TENANT_ID}, 'Chain Test Firm', 'chain-test-firm', 'mixed')`;
    await tx`INSERT INTO "user" (id, email, primary_idp, external_id) VALUES (${USER_ID}, 'chain-test@example.com', 'microsoft', 'microsoft:chain-test')`;
    await tx`SELECT set_config('app.current_tenant_id', ${TENANT_ID}, true)`;
    await tx`INSERT INTO subject_tenant (id, tenant_id, name, kind) VALUES (${SUBJECT_ID}, ${TENANT_ID}, 'Chain Test Claimant', 'claimant')`;
  });
});

after(async () => {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${TENANT_ID}, true)`;
    await tx`DELETE FROM event WHERE subject_tenant_id = ${SUBJECT_ID}`;
    await tx`DELETE FROM subject_tenant WHERE id = ${SUBJECT_ID}`;
  });
  await sql`DELETE FROM "user" WHERE id = ${USER_ID}`;
  await sql`DELETE FROM tenant WHERE id = ${TENANT_ID}`;
  await sql.end();
});

test('canonicaliseEvent produces deterministic JSON with sorted keys', () => {
  const a = canonicaliseEvent({
    subject_tenant_id: 'a',
    kind: 'HYPOTHESIS',
    payload: { x: 1, y: 2 },
    classification: null,
    captured_at: new Date('2026-04-27T00:00:00Z'),
    captured_by_user_id: 'u',
    override_of_event_id: null,
    override_new_kind: null,
    override_reason: null,
  });
  const b = canonicaliseEvent({
    captured_by_user_id: 'u',
    override_reason: null,
    classification: null,
    payload: { y: 2, x: 1 },
    kind: 'HYPOTHESIS',
    captured_at: new Date('2026-04-27T00:00:00Z'),
    subject_tenant_id: 'a',
    override_new_kind: null,
    override_of_event_id: null,
  });
  assert.equal(a, b, 'canonical form must be order-independent');
});

test('hashEvent: prev=null produces stable hex hash', () => {
  const h = hashEvent(null, {
    subject_tenant_id: 'a',
    kind: 'HYPOTHESIS',
    payload: { _v: 1, source: 'paste', raw_text: 'hello' },
    classification: null,
    captured_at: new Date('2026-04-27T00:00:00Z'),
    captured_by_user_id: 'u',
    override_of_event_id: null,
    override_new_kind: null,
    override_reason: null,
  });
  assert.match(h, /^[0-9a-f]{64}$/);
});

test('canonicaliseEvent rejects NaN in payload (would silently corrupt the chain)', () => {
  assert.throws(
    () =>
      canonicaliseEvent({
        subject_tenant_id: 'a',
        kind: 'HYPOTHESIS',
        payload: { value: NaN },
        classification: null,
        captured_at: new Date('2026-04-27T00:00:00Z'),
        captured_by_user_id: 'u',
        override_of_event_id: null,
        override_new_kind: null,
        override_reason: null,
      }),
    /non-finite number/,
  );
});

test('canonicaliseEvent rejects Infinity in payload', () => {
  assert.throws(
    () =>
      canonicaliseEvent({
        subject_tenant_id: 'a',
        kind: 'HYPOTHESIS',
        payload: { value: Infinity },
        classification: null,
        captured_at: new Date('2026-04-27T00:00:00Z'),
        captured_by_user_id: 'u',
        override_of_event_id: null,
        override_new_kind: null,
        override_reason: null,
      }),
    /non-finite number/,
  );
});

// Test F6/1: P4 kinds produce stable canonical JSON.
//
// Snapshot of the exact canonical-JSON byte sequence for an ACTIVITY_CREATED
// event. The string below is the regression anchor for the canonicaliser —
// any subtle change (key order, classification handling, new field added
// unconditionally) will fail this test loudly. Updating the snapshot is a
// chain-breaking change requiring a migration plan.
test('P4 kinds: canonicaliseEvent produces stable snapshot for ACTIVITY_CREATED', () => {
  const e = canonicaliseEvent({
    subject_tenant_id: '00000000-0000-4000-8000-0000c0002222',
    kind: 'ACTIVITY_CREATED',
    payload: {
      activity_id: '00000000-0000-4000-8000-0000a0000001',
      code: 'A1',
      kind: 'core',
      title: 'Activity One',
      project_id: '00000000-0000-4000-8000-0000b0000001',
      claim_id: '00000000-0000-4000-8000-0000d0000001',
    },
    classification: null,
    captured_at: new Date('2026-04-27T00:00:00Z'),
    captured_by_user_id: '00000000-0000-4000-8000-0000c0003333',
    override_of_event_id: null,
    override_new_kind: null,
    override_reason: null,
  });
  assert.equal(
    e,
    '{"captured_at":"2026-04-27T00:00:00.000Z","captured_by_user_id":"00000000-0000-4000-8000-0000c0003333","classification":null,"kind":"ACTIVITY_CREATED","override_new_kind":null,"override_of_event_id":null,"override_reason":null,"payload":{"activity_id":"00000000-0000-4000-8000-0000a0000001","claim_id":"00000000-0000-4000-8000-0000d0000001","code":"A1","kind":"core","project_id":"00000000-0000-4000-8000-0000b0000001","title":"Activity One"},"subject_tenant_id":"00000000-0000-4000-8000-0000c0002222"}',
  );
});

// Test F6/2: pre-P4 hash regression guard.
//
// Locks the SHA-256 hash for a P2-shape HYPOTHESIS event with prev=null.
// The previous test at line ~56 only asserts hex-format via regex — this
// one asserts the exact 64-char hex value, so a future canonicaliser
// change that breaks pre-P4 hash compatibility (e.g., changing how
// captured_by_employee_id is conditionally omitted, reordering keys,
// changing payload normalisation) fails here immediately rather than
// silently invalidating every chain produced before P4.
test('P4 regression guard: pre-P4 hash is byte-identical to P2 anchor', () => {
  const h = hashEvent(null, {
    subject_tenant_id: 'a',
    kind: 'HYPOTHESIS',
    payload: { _v: 1, source: 'paste', raw_text: 'hello' },
    classification: null,
    captured_at: new Date('2026-04-27T00:00:00Z'),
    captured_by_user_id: 'u',
    override_of_event_id: null,
    override_new_kind: null,
    override_reason: null,
  });
  assert.equal(h, '49df527ffde03d6f89584b297842fbda49dd6121c8894405094c8e0c7e57beba');
});

// Test F6/4: EVIDENCE_KINDS parity guard (F5 reviewer recommendation).
//
// `evidenceKind` (Zod enum, wire format in @cpa/schemas) and `EVIDENCE_KINDS`
// (Drizzle column type in @cpa/db) are dual sources of truth that must stay
// byte-identical — same entries, same order. A drift here means the API
// would accept a kind the DB rejects (or vice versa) and the mismatch
// would only surface as an opaque CHECK violation at insert time. This
// test catches it at CI time instead.
test('EVIDENCE_KINDS parity: @cpa/db and @cpa/schemas stay in sync', async () => {
  const { EVIDENCE_KINDS } = await import('./schema/event.js');
  const { evidenceKind } = await import('@cpa/schemas');
  assert.deepEqual(
    [...evidenceKind.options],
    [...EVIDENCE_KINDS],
    'evidenceKind.options must match EVIDENCE_KINDS exactly (same order, same content)',
  );
});

test('CLAIM_STAGES parity: @cpa/db and @cpa/schemas stay in sync', async () => {
  const { CLAIM_STAGES } = await import('./schema/claim.js');
  const { CLAIM_STAGES_LITERAL } = await import('@cpa/schemas');
  assert.deepEqual(
    [...CLAIM_STAGES_LITERAL],
    [...CLAIM_STAGES],
    'CLAIM_STAGES_LITERAL must match CLAIM_STAGES exactly (same order, same content) — see JSDoc on each declaration',
  );
});

test('EXPENDITURE_SOURCES parity: @cpa/db and @cpa/schemas stay in sync', async () => {
  const { EXPENDITURE_SOURCES } = await import('./schema/expenditure.js');
  const { EXPENDITURE_SOURCES_LITERAL } = await import('@cpa/schemas');
  assert.deepEqual(
    [...EXPENDITURE_SOURCES_LITERAL],
    [...EXPENDITURE_SOURCES],
    'EXPENDITURE_SOURCES_LITERAL must match EXPENDITURE_SOURCES exactly (same order, same content)',
  );
});

test('insertEventWithChain: first event has prev_hash=null', async () => {
  const e = await insertEventWithChain({
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    kind: 'HYPOTHESIS',
    payload: { _v: 1, source: 'paste', raw_text: 'first event' },
    classification: {
      kind: 'HYPOTHESIS',
      confidence: 0.9,
      rationale: 'r',
      statutory_anchor: null,
      model: 'stub-v1.0.0',
      prompt_version: 'classify@1.0.0',
      tokens_in: 0,
      tokens_out: 0,
      cache_hit: false,
    },
    captured_at: new Date(),
    captured_by_user_id: USER_ID,
    override_of_event_id: null,
    override_new_kind: null,
    override_reason: null,
  });
  assert.equal(e.prev_hash, null);
  assert.match(e.hash, /^[0-9a-f]{64}$/);
});

test('insertEventWithChain: second event extends prev_hash', async () => {
  const e1 = await insertEventWithChain({
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    kind: 'OBSERVATION',
    payload: { _v: 1, source: 'paste', raw_text: 'second' },
    classification: null,
    captured_at: new Date(),
    captured_by_user_id: USER_ID,
    override_of_event_id: null,
    override_new_kind: null,
    override_reason: null,
  });
  const e2 = await insertEventWithChain({
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    kind: 'EXPERIMENT',
    payload: { _v: 1, source: 'paste', raw_text: 'third' },
    classification: null,
    captured_at: new Date(),
    captured_by_user_id: USER_ID,
    override_of_event_id: null,
    override_new_kind: null,
    override_reason: null,
  });
  assert.equal(e2.prev_hash, e1.hash);
});

test('verifyChain: clean chain returns verified=true', async () => {
  const status = await verifyChain(SUBJECT_ID);
  assert.equal(status.verified, true);
  assert.ok((status.event_count ?? 0) > 0);
  assert.match(status.head_hash ?? '', /^[0-9a-f]{64}$/);
});

// Test F6/3: verifyChain across mixed P2 + P4 kinds.
//
// Inserts one classifiable evidence kind (P2-style) followed by three
// state-transition kinds (P4) into the same subject_tenant chain, then
// verifies the chain is intact. Confirms the canonicaliser handles the
// new kinds identically to the old ones for hash-chain purposes
// (verifyChain only checks hash linkage; payload-shape validation lives
// elsewhere — but realistic P4 payloads are used per design doc §143-156).
test('verifyChain: clean across mixed P2 + P4 kinds', async () => {
  const before = await verifyChain(SUBJECT_ID);
  const baseCount = before.event_count;
  await insertEventWithChain({
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    kind: 'OBSERVATION',
    payload: { _v: 1, source: 'paste', raw_text: 'mixed-chain p2' },
    classification: null,
    captured_at: new Date(),
    captured_by_user_id: USER_ID,
    override_of_event_id: null,
    override_new_kind: null,
    override_reason: null,
  });
  await insertEventWithChain({
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    kind: 'ACTIVITY_CREATED',
    payload: {
      activity_id: '00000000-0000-4000-8000-0000a0000001',
      code: 'A1',
      kind: 'core',
      title: 'Activity One',
      project_id: '00000000-0000-4000-8000-0000b0000001',
      claim_id: '00000000-0000-4000-8000-0000d0000001',
    },
    classification: null,
    captured_at: new Date(),
    captured_by_user_id: USER_ID,
    override_of_event_id: null,
    override_new_kind: null,
    override_reason: null,
  });
  await insertEventWithChain({
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    kind: 'ARTEFACT_LINKED',
    payload: {
      activity_id: '00000000-0000-4000-8000-0000a0000001',
      artefact_kind: 'event',
      artefact_id: '00000000-0000-4000-8000-0000e0000001',
      link_reason: 'mixed-chain test',
    },
    classification: null,
    captured_at: new Date(),
    captured_by_user_id: USER_ID,
    override_of_event_id: null,
    override_new_kind: null,
    override_reason: null,
  });
  await insertEventWithChain({
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    kind: 'EXPENDITURE_INGESTED',
    payload: {
      expenditure_id: '00000000-0000-4000-8000-0000f0000001',
      source: 'manual',
      vendor_name: 'Acme Co',
      line_count: 3,
    },
    classification: null,
    captured_at: new Date(),
    captured_by_user_id: USER_ID,
    override_of_event_id: null,
    override_new_kind: null,
    override_reason: null,
  });
  const after = await verifyChain(SUBJECT_ID);
  assert.equal(after.verified, true);
  assert.equal(after.event_count, baseCount + 4);
  assert.match(after.head_hash ?? '', /^[0-9a-f]{64}$/);
  assert.equal(after.first_break_at, null);
});

test('verifyChain: tampered hash detected', async () => {
  // Read via privilegedSql (RLS-bypass) to symmetry-match the UPDATE
  // below. Using `sql` here would hit the postgres-js GUC quirk: a
  // pooled connection touched by a prior set_config(true) returns ''
  // for current_setting(...,true) on subsequent reads, and the RLS
  // policy's ::uuid cast on '' errors with "invalid input syntax".
  const { privilegedSql } = await import('./client.js');
  const [first] = await privilegedSql<{ id: string; hash: string }[]>`
    SELECT id, hash FROM event WHERE subject_tenant_id = ${SUBJECT_ID}
    ORDER BY captured_at, received_at, id LIMIT 1
  `;
  assert.ok(first);
  const originalHash = first.hash;
  await privilegedSql`UPDATE event SET hash = 'deadbeef' || substring(hash from 9) WHERE id = ${first.id}`;
  const status = await verifyChain(SUBJECT_ID);
  assert.equal(status.verified, false);
  assert.equal(status.first_break_at, 0);
  await privilegedSql`UPDATE event SET hash = ${originalHash} WHERE id = ${first.id}`;
});

// A9 phase 3 — extension test coverage for every P4 event kind currently
// in EVIDENCE_KINDS. Each test inserts an event with a representative
// payload (mirroring the Zod schema in @cpa/schemas/event.ts), then calls
// verifyChain and asserts `verified: true`.
//
// Reserved-but-deferred kinds called out in the A9 task description
// (EXPENDITURE_MAPPED, EXPENDITURE_APPORTIONED, MAPPING_RULE_*) are NOT
// covered here because they don't yet exist in EVIDENCE_KINDS or the
// event_kind_valid CHECK — inserting them would fail at the constraint
// layer. They are tracked in chain.canonical.test.ts (pure-canonicaliser
// coverage) so the canonical bytes for these payloads will be
// deterministic if/when the kinds are added.

const P4_KIND_INSERT_FIXTURES = [
  {
    kind: 'PROJECT_CREATED' as const,
    payload: {
      project_id: '00000000-0000-4000-8000-0000b0000001',
      name: 'A9 Project Alpha',
      started_at: '2026-04-01T00:00:00.000Z',
    },
  },
  {
    kind: 'PROJECT_UPDATED' as const,
    payload: {
      project_id: '00000000-0000-4000-8000-0000b0000001',
      fields_changed: {
        name: { from: 'A9 Project Alpha', to: 'A9 Project Alpha (renamed)' },
      },
    },
  },
  {
    kind: 'PROJECT_ARCHIVED' as const,
    payload: {
      project_id: '00000000-0000-4000-8000-0000b0000001',
      archived_by_user_id: USER_ID,
      reason: 'A9 phase 3 fixture',
    },
  },
  {
    kind: 'ACTIVITY_UPDATED' as const,
    payload: {
      activity_id: '00000000-0000-4000-8000-0000a0000001',
      fields_changed: {
        title: { from: 'Activity One', to: 'Activity One (renamed)' },
      },
    },
  },
  {
    kind: 'ARTEFACT_UNLINKED' as const,
    payload: {
      activity_id: '00000000-0000-4000-8000-0000a0000001',
      artefact_kind: 'event',
      artefact_id: '00000000-0000-4000-8000-0000e0000001',
      reason: 'A9 phase 3 unlink',
    },
  },
  // TODO(B9-emission): when EXPENDITURE_MAPPED, EXPENDITURE_APPORTIONED, and
  // MAPPING_RULE_{CREATED,UPDATED,ARCHIVED} are added to evidenceKind +
  // event_kind_valid CHECK, add their canonical-shape fixtures here. The
  // engine and route layers (B8/B9) already handle them — only the chain
  // round-trip is gated on the schema enum.
];

for (const { kind, payload } of P4_KIND_INSERT_FIXTURES) {
  test(`A9 phase 3: ${kind} round-trips through insertEventWithChain + verifyChain`, async () => {
    const before = await verifyChain(SUBJECT_ID);
    assert.equal(before.verified, true, 'chain must be clean before each fixture');
    const inserted = await insertEventWithChain({
      tenant_id: TENANT_ID,
      subject_tenant_id: SUBJECT_ID,
      kind,
      payload,
      classification: null,
      captured_at: new Date(),
      captured_by_user_id: USER_ID,
      override_of_event_id: null,
      override_new_kind: null,
      override_reason: null,
    });
    assert.match(inserted.hash, /^[0-9a-f]{64}$/);
    const after = await verifyChain(SUBJECT_ID);
    assert.equal(after.verified, true, `chain must remain verified after ${kind}`);
    assert.equal(after.event_count, before.event_count + 1);
    assert.equal(after.head_hash, inserted.hash);
  });
}

// A9 phase 3 — multi-event chain tamper test.
//
// Inserts five events of mixed kinds, verifies clean, tampers with event
// #2's hash, then asserts verifyChain returns first_break_at = 2 (NOT 0).
// This proves verifyChain walks the chain ordinally and pinpoints the
// exact break index — load-bearing for the assurance report's "hash break
// at event N" diagnostic.
test('A9 phase 3: multi-event chain — tamper at index 2 reports first_break_at=2', async () => {
  // Use a dedicated subject_tenant for this test so the event count is
  // well-defined regardless of the order other tests in this file run.
  const SCRATCH_SUBJECT_ID = '00000000-0000-4000-8000-0000c0009999';
  const { privilegedSql } = await import('./client.js');
  await privilegedSql`SELECT set_config('app.current_tenant_id', ${TENANT_ID}, true)`;
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                       VALUES (${SCRATCH_SUBJECT_ID}, ${TENANT_ID}, 'A9 Tamper Scratch', 'claimant')`;

  try {
    const eventKinds: Array<{ kind: string; payload: Record<string, unknown> }> = [
      {
        kind: 'PROJECT_CREATED',
        payload: {
          project_id: '00000000-0000-4000-8000-0000b0000001',
          name: 'Tamper P0',
          started_at: '2026-04-01T00:00:00.000Z',
        },
      },
      {
        kind: 'ACTIVITY_CREATED',
        payload: {
          activity_id: '00000000-0000-4000-8000-0000a0000001',
          code: 'CA-01',
          kind: 'core',
          title: 'Tamper A0',
          project_id: '00000000-0000-4000-8000-0000b0000001',
          claim_id: '00000000-0000-4000-8000-0000d0000001',
        },
      },
      // Index 2 — this is the one we'll tamper with.
      {
        kind: 'ARTEFACT_LINKED',
        payload: {
          activity_id: '00000000-0000-4000-8000-0000a0000001',
          artefact_kind: 'event',
          artefact_id: '00000000-0000-4000-8000-0000e0000001',
          link_reason: 'Tamper L0',
        },
      },
      {
        kind: 'EXPENDITURE_INGESTED',
        payload: {
          expenditure_id: '00000000-0000-4000-8000-0000f0000001',
          source: 'manual',
          vendor_name: 'Tamper Vendor',
          line_count: 1,
        },
      },
      {
        kind: 'PROJECT_ARCHIVED',
        payload: {
          project_id: '00000000-0000-4000-8000-0000b0000001',
          archived_by_user_id: USER_ID,
          reason: 'Tamper end',
        },
      },
    ];

    const inserted: { id: string; hash: string }[] = [];
    let i = 0;
    for (const { kind, payload } of eventKinds) {
      const e = await insertEventWithChain({
        tenant_id: TENANT_ID,
        subject_tenant_id: SCRATCH_SUBJECT_ID,
        kind,
        payload,
        classification: null,
        // Stagger captured_at so the chain ordering is deterministic.
        captured_at: new Date(2026, 3, 29, 0, i, 0, 0),
        captured_by_user_id: USER_ID,
        override_of_event_id: null,
        override_new_kind: null,
        override_reason: null,
      });
      inserted.push({ id: e.id, hash: e.hash });
      i++;
    }

    const clean = await verifyChain(SCRATCH_SUBJECT_ID);
    assert.equal(clean.verified, true);
    assert.equal(clean.event_count, 5);
    assert.equal(clean.first_break_at, null);

    // Tamper event at index 2 (the ARTEFACT_LINKED row).
    const target = inserted[2]!;
    const originalHash = target.hash;
    await privilegedSql`UPDATE event SET hash = 'deadbeef' || substring(hash from 9) WHERE id = ${target.id}`;

    try {
      const tampered = await verifyChain(SCRATCH_SUBJECT_ID);
      assert.equal(tampered.verified, false, 'tampered chain must report verified=false');
      assert.equal(tampered.first_break_at, 2, 'first_break_at must point at the tampered index');
      assert.equal(tampered.event_count, 5);
    } finally {
      // Restore so the cleanup DELETE walks a clean chain (defensive —
      // DELETE doesn't recompute hashes, but keeps teardown deterministic).
      await privilegedSql`UPDATE event SET hash = ${originalHash} WHERE id = ${target.id}`;
    }
  } finally {
    await privilegedSql`SELECT set_config('app.current_tenant_id', ${TENANT_ID}, true)`;
    await privilegedSql`DELETE FROM event WHERE subject_tenant_id = ${SCRATCH_SUBJECT_ID}`;
    await privilegedSql`DELETE FROM subject_tenant WHERE id = ${SCRATCH_SUBJECT_ID}`;
  }
});
