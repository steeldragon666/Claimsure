import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicaliseEvent, hashEvent, type EventForHashing } from './chain.js';

/**
 * A9 phase 1 — diagnostic parity tests for the canonicaliser.
 *
 * These tests exercise `canonicaliseEvent` and `hashEvent` purely in-process;
 * they do NOT touch the database, so they can run even when `pnpm db:up`
 * has not been started. The full `chain.test.ts` (which seeds + verifies
 * via DB) lives next to this file and remains the integration-level
 * coverage; these tests target the three hypotheses for the long-standing
 * canonicalisation drift between `seedEvent` (apps/web/e2e/fixtures/test-data.ts)
 * and `verifyChain` (packages/db/src/chain.ts) that has caused
 * `apps/web/e2e/chain-verification.spec.ts` to be skipped since 2026-04-27.
 *
 * Hypothesis index (from the e2e TODO block):
 *   H1 — `seedEvent` builds `EventForHashing` OMITTING `captured_by_employee_id`;
 *        `verifyChain` passes `captured_by_employee_id: e.captured_by_employee_id ?? null`.
 *        The canonicaliser branch `e.captured_by_employee_id != null` should
 *        treat both `undefined` and `null` identically (loose equality with
 *        `null` matches both). This test proves the invariant for
 *        canonicaliseEvent directly.
 *
 *   H2 — classification jsonb roundtrip — the seed embeds `§` (U+00A7) in
 *        statutory_anchor; postgres jsonb is byte-stable for the canonical
 *        string after a JSON.parse(JSON.stringify(...)) round-trip.
 *
 *   H3 — `captured_at` precision — postgres timestamptz is microseconds,
 *        JS Date is milliseconds; round-tripping via toISOString() must
 *        be byte-identical.
 *
 * Phase 1 commit lands these tests; whichever fails identifies the root
 * cause and is fixed in phase 2.
 */

const BASE_EVENT: EventForHashing = {
  subject_tenant_id: '00000000-0000-4000-8000-0000c0002222',
  kind: 'HYPOTHESIS',
  payload: { _v: 1, source: 'paste', raw_text: 'A9 diagnostic seed' },
  classification: {
    kind: 'HYPOTHESIS',
    confidence: 0.85,
    rationale: 'seed',
    statutory_anchor: '§355-25(1)(a)',
    model: 'stub-v1.0.0',
    prompt_version: 'classify@1.0.0',
    tokens_in: 0,
    tokens_out: 0,
  },
  captured_at: new Date('2026-04-27T00:00:00.123Z'),
  captured_by_user_id: '00000000-0000-4000-8000-0000c0003333',
  override_of_event_id: null,
  override_new_kind: null,
  override_reason: null,
};

// H1 — captured_by_employee_id missing vs explicit null parity.
//
// Replicates the data shape mismatch between `seedEvent` (which builds
// `EventForHashing` without the `captured_by_employee_id` property) and
// `verifyChain` (which passes the column through `?? null`). The
// canonicaliser branch `e.captured_by_employee_id != null` uses loose
// inequality, so `undefined != null` → false (omitted) and `null != null`
// → false (omitted). Both forms must produce byte-identical canonical
// strings — and therefore identical SHA-256 hashes — for the chain to
// verify.
test('H1: canonicalise — omitted captured_by_employee_id matches explicit null', () => {
  const omitted = canonicaliseEvent({ ...BASE_EVENT });
  const withNull = canonicaliseEvent({ ...BASE_EVENT, captured_by_employee_id: null });
  assert.equal(
    omitted,
    withNull,
    'undefined and null must take the same canonicaliser branch (both omit the field)',
  );
  assert.equal(
    hashEvent(null, { ...BASE_EVENT }),
    hashEvent(null, { ...BASE_EVENT, captured_by_employee_id: null }),
    'derived SHA-256 must also match (sanity check that the canonical strings drive the hash)',
  );
});

// H1 follow-up — explicit non-null captured_by_employee_id IS included.
//
// Conversely, when the field IS set (mobile-employee capture path), the
// canonicaliser MUST include it — otherwise mobile events would collide
// with consultant events that share the rest of the shape, breaking the
// uniqueness guarantee of the SHA-256 chain head.
test('H1 follow-up: canonicalise — non-null captured_by_employee_id IS included', () => {
  const withEmployee = canonicaliseEvent({
    ...BASE_EVENT,
    captured_by_employee_id: '00000000-0000-4000-8000-0000c0004444',
  });
  const omitted = canonicaliseEvent({ ...BASE_EVENT });
  assert.notEqual(
    withEmployee,
    omitted,
    'non-null captured_by_employee_id must be in the canonical output',
  );
  assert.match(withEmployee, /"captured_by_employee_id":"00000000-0000-4000-8000-0000c0004444"/);
});

// H2 — classification jsonb roundtrip.
//
// PostgreSQL's jsonb storage normalises whitespace + key order but is
// byte-stable for the values themselves (Unicode codepoints, numbers).
// Simulate the roundtrip via JSON.parse(JSON.stringify(...)), which is
// what postgres-js effectively does on read for a jsonb column. The
// canonicaliser sorts keys, so any key-order drift must NOT affect the
// canonical string.
test('H2: canonicalise — classification with U+00A7 byte-identical after JSON roundtrip', () => {
  const before = canonicaliseEvent({ ...BASE_EVENT });
  const roundtrippedClassification: unknown = JSON.parse(JSON.stringify(BASE_EVENT.classification));
  const after = canonicaliseEvent({
    ...BASE_EVENT,
    classification: roundtrippedClassification,
  });
  assert.equal(
    after,
    before,
    'classification must be byte-identical after JSON.parse(JSON.stringify(...)) roundtrip',
  );
  // Sanity: the canonical string actually contains the literal § codepoint
  // (verifying we are testing what we think we are testing).
  assert.ok(after.includes('§355-25(1)(a)'));
});

// H2 follow-up — payload jsonb roundtrip with same Unicode + key reorder.
//
// The seed payload is a flat object; on read postgres-js may return keys in
// a different order. canonicalJsonStringify sorts keys, so reorder must not
// drift the canonical output.
test('H2 follow-up: canonicalise — payload key reorder is canonicalised away', () => {
  const a = canonicaliseEvent({
    ...BASE_EVENT,
    payload: { _v: 1, source: 'paste', raw_text: 'A9 diagnostic seed' },
  });
  const b = canonicaliseEvent({
    ...BASE_EVENT,
    payload: { raw_text: 'A9 diagnostic seed', source: 'paste', _v: 1 },
  });
  assert.equal(a, b, 'payload key order must not affect canonical output');
});

// H3 — captured_at ms precision parity.
//
// `seedEvent` passes `captured_at: new Date(Date.now() - 60_000)` — a JS
// Date with millisecond precision. Postgres timestamptz stores at
// microsecond precision; postgres-js returns the column as a JS Date with
// ms precision (microseconds truncated). Both seed and verify call
// `.toISOString()` on the Date for hashing. Simulate the round-trip by
// constructing a new Date from the toISOString() output and re-canonicalising.
test('H3: canonicalise — captured_at Date with ms precision matches roundtripped form', () => {
  const original = new Date('2026-04-27T12:34:56.789Z');
  const a = canonicaliseEvent({ ...BASE_EVENT, captured_at: original });
  // Simulate seed-time → DB → verify-time round-trip:
  //   DB stores at μs precision; ms Date has μs == 0; postgres-js returns
  //   a JS Date built from the ISO string. new Date(iso) preserves ms
  //   precision, so this is exactly what verifyChain receives.
  const roundtripped = new Date(original.toISOString());
  const b = canonicaliseEvent({ ...BASE_EVENT, captured_at: roundtripped });
  assert.equal(
    b,
    a,
    'captured_at Date must produce identical canonical string after toISOString round-trip',
  );
  // Sanity: ISO strings must match too (proves the Date copy is byte-equal).
  assert.equal(roundtripped.toISOString(), original.toISOString());
});

// H3 follow-up — captured_at via constructor-from-Date matches constructor-from-iso.
//
// verifyChain calls `new Date(e.captured_at)` where postgres-js may return
// either a Date (with type-parser) or a string (without). Both inputs to
// `new Date(x)` should produce a Date that toISOString()s back to the same
// value the seed used.
test('H3 follow-up: canonicalise — new Date(date) and new Date(iso) yield identical hashes', () => {
  const original = new Date('2026-04-27T12:34:56.789Z');
  const fromDate = new Date(original); // postgres-js with type parser → Date
  const fromIso = new Date(original.toISOString()); // postgres-js without → string → Date
  assert.equal(
    hashEvent(null, { ...BASE_EVENT, captured_at: fromDate }),
    hashEvent(null, { ...BASE_EVENT, captured_at: fromIso }),
    'both Date construction paths must hash identically',
  );
});

// H3 corner — sub-millisecond precision is NOT silently dropped.
//
// JS Date cannot represent sub-millisecond precision, so this is a
// theoretical-only invariant: if a Date with ms precision is hashed, then
// recovered from microsecond-precision postgres timestamptz storage, the
// recovered Date should also be ms precision. If postgres ever returned a
// different ISO string (e.g. with µs digits), this would catch it.
test('H3 corner: captured_at toISOString contains exactly 3 fractional-second digits', () => {
  const d = new Date('2026-04-27T12:34:56.789Z');
  const iso = d.toISOString();
  assert.match(
    iso,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    'JS Date toISOString must always yield ms (3-digit) precision',
  );
});

// Cross-test: seedEvent shape vs verifyChain shape produce identical hashes.
//
// This is the END-TO-END parity test that the e2e chain-verification spec
// fundamentally relies on. seedEvent builds an EventForHashing OMITTING
// captured_by_employee_id; verifyChain builds one WITH the field set to
// `?? null`. After a simulated jsonb + timestamptz round-trip, the SHA-256
// must be identical — otherwise the chain breaks at event #0.
test('A9 cross: seedEvent shape and verifyChain shape produce identical hashes (full simulation)', () => {
  // What seedEvent would feed to hashEvent (no captured_by_employee_id key):
  const seedShape: EventForHashing = {
    subject_tenant_id: BASE_EVENT.subject_tenant_id,
    kind: BASE_EVENT.kind,
    payload: BASE_EVENT.payload,
    classification: BASE_EVENT.classification,
    captured_at: BASE_EVENT.captured_at,
    captured_by_user_id: BASE_EVENT.captured_by_user_id,
    override_of_event_id: null,
    override_new_kind: null,
    override_reason: null,
  };
  const seedHash = hashEvent(null, seedShape);

  // What verifyChain would re-build after reading the same row from postgres:
  //   - payload: parsed from jsonb (key order normalised)
  //   - classification: parsed from jsonb (key order normalised)
  //   - captured_at: Date built from postgres timestamptz (ms precision)
  //   - captured_by_employee_id: null (column NULL in the inserted row,
  //     verifyChain feeds via `?? null`)
  const verifyShape: EventForHashing = {
    subject_tenant_id: seedShape.subject_tenant_id,
    kind: seedShape.kind,
    payload: JSON.parse(JSON.stringify(seedShape.payload)),
    classification: JSON.parse(JSON.stringify(seedShape.classification)),
    captured_at: new Date(seedShape.captured_at.toISOString()),
    captured_by_user_id: seedShape.captured_by_user_id,
    captured_by_employee_id: null,
    override_of_event_id: null,
    override_new_kind: null,
    override_reason: null,
  };
  const verifyHash = hashEvent(null, verifyShape);

  assert.equal(
    verifyHash,
    seedHash,
    'seed-time and verify-time hashes must match for the chain-verification e2e to pass',
  );
});

// ---------------------------------------------------------------------------
// A9 phase 3 — extension test coverage for every P4 event kind.
//
// For each P4 state-transition kind, build a representative payload (mirrors
// the Zod schema in @cpa/schemas/event.ts) and assert canonicaliseEvent +
// hashEvent produce a stable 64-char hex SHA-256. Two-event chain extension
// is also covered (kind A → kind B, prev_hash linkage).
//
// These are pure unit tests — no DB required. The matching DB-backed
// insertEventWithChain + verifyChain round-trips live in chain.test.ts and
// run only when the local docker postgres is up.
// ---------------------------------------------------------------------------

/** Common base for P4 event hash tests — only `kind` and `payload` change. */
const P4_BASE = {
  subject_tenant_id: '00000000-0000-4000-8000-0000c0002222',
  classification: null,
  captured_at: new Date('2026-04-29T00:00:00.000Z'),
  captured_by_user_id: '00000000-0000-4000-8000-0000c0003333',
  override_of_event_id: null,
  override_new_kind: null,
  override_reason: null,
} as const;

/**
 * Each entry: a P4 evidence kind currently accepted by the DB CHECK
 * (event_kind_valid / migrations 0014, 0015) plus a representative payload
 * matching the Zod schema in @cpa/schemas/event.ts.
 *
 * The reserved-but-deferred kinds called out in the A9 task description
 * (EXPENDITURE_MAPPED, EXPENDITURE_APPORTIONED, MAPPING_RULE_*) are
 * intentionally NOT in this list — they are not currently in EVIDENCE_KINDS
 * nor the event_kind_valid CHECK, so a round-trip would fail at insert
 * time. Adding them is out of scope per the A9 contract ("Do NOT add new
 * event kinds"); see the report for the deferred list.
 */
const P4_KIND_FIXTURES: Array<{ kind: string; payload: Record<string, unknown> }> = [
  {
    kind: 'PROJECT_CREATED',
    payload: {
      project_id: '00000000-0000-4000-8000-0000b0000001',
      name: 'Project Alpha',
      started_at: '2026-04-01T00:00:00.000Z',
    },
  },
  {
    kind: 'PROJECT_UPDATED',
    payload: {
      project_id: '00000000-0000-4000-8000-0000b0000001',
      fields_changed: {
        name: { from: 'Project Alpha', to: 'Project Alpha (renamed)' },
        description: { from: null, to: 'Updated description' },
      },
    },
  },
  {
    kind: 'PROJECT_ARCHIVED',
    payload: {
      project_id: '00000000-0000-4000-8000-0000b0000001',
      archived_by_user_id: '00000000-0000-4000-8000-0000c0003333',
      reason: 'merged into successor',
    },
  },
  {
    kind: 'ACTIVITY_CREATED',
    payload: {
      activity_id: '00000000-0000-4000-8000-0000a0000001',
      code: 'CA-01',
      kind: 'core',
      title: 'Activity One',
      project_id: '00000000-0000-4000-8000-0000b0000001',
      claim_id: '00000000-0000-4000-8000-0000d0000001',
    },
  },
  {
    kind: 'ACTIVITY_UPDATED',
    payload: {
      activity_id: '00000000-0000-4000-8000-0000a0000001',
      fields_changed: {
        title: { from: 'Activity One', to: 'Activity One (renamed)' },
      },
    },
  },
  {
    kind: 'ARTEFACT_LINKED',
    payload: {
      activity_id: '00000000-0000-4000-8000-0000a0000001',
      artefact_kind: 'event',
      artefact_id: '00000000-0000-4000-8000-0000e0000001',
      link_reason: 'A9 phase 3 fixture',
    },
  },
  {
    kind: 'ARTEFACT_UNLINKED',
    payload: {
      activity_id: '00000000-0000-4000-8000-0000a0000001',
      artefact_kind: 'event',
      artefact_id: '00000000-0000-4000-8000-0000e0000001',
      reason: 'wrong activity',
    },
  },
  {
    kind: 'EXPENDITURE_INGESTED',
    payload: {
      expenditure_id: '00000000-0000-4000-8000-0000f0000001',
      source: 'manual',
      vendor_name: 'Acme Co',
      line_count: 3,
    },
  },
  // TODO(B9-emission): when EXPENDITURE_MAPPED, EXPENDITURE_APPORTIONED, and
  // MAPPING_RULE_{CREATED,UPDATED,ARCHIVED} are added to evidenceKind +
  // event_kind_valid CHECK, add their canonical-shape fixtures here. The
  // engine and route layers (B8/B9) already handle them — only the chain
  // round-trip is gated on the schema enum.
];

for (const { kind, payload } of P4_KIND_FIXTURES) {
  test(`P4 extension: ${kind} canonicalises + hashes deterministically`, () => {
    const event: EventForHashing = { ...P4_BASE, kind, payload };

    // 1. Canonical string is byte-stable across two calls (no hidden state).
    const canonA = canonicaliseEvent(event);
    const canonB = canonicaliseEvent(event);
    assert.equal(canonA, canonB, `${kind} canonical output must be deterministic`);

    // 2. Canonical string is byte-stable across payload-key reorder
    //    (proves canonicalJsonStringify sorts keys for nested objects too).
    const reorderedPayload: Record<string, unknown> = {};
    for (const key of Object.keys(payload).reverse()) {
      reorderedPayload[key] = payload[key];
    }
    const canonReordered = canonicaliseEvent({ ...event, payload: reorderedPayload });
    assert.equal(canonReordered, canonA, `${kind} payload key order must not affect canonical`);

    // 3. SHA-256 is the expected hex format and stable across calls.
    const hashA = hashEvent(null, event);
    const hashB = hashEvent(null, event);
    assert.match(hashA, /^[0-9a-f]{64}$/);
    assert.equal(hashA, hashB, `${kind} hash must be deterministic`);

    // 4. Chain extension: a second event chained to the first must include
    //    the prev_hash in its own SHA-256 (no collision with prev=null).
    const second: EventForHashing = { ...event, captured_at: new Date('2026-04-29T01:00:00.000Z') };
    const chainedHash = hashEvent(hashA, second);
    const standaloneHash = hashEvent(null, second);
    assert.notEqual(
      chainedHash,
      standaloneHash,
      `${kind} chained hash must differ from standalone (prev_hash mixed in)`,
    );
  });
}

// Two-event chain across heterogeneous P4 kinds — proves that the per-kind
// fixtures above can be chained together (each kind's prev_hash is the
// previous event's hash, regardless of its kind).
test('A9 phase 3: heterogeneous P4 kinds chain pairwise', () => {
  let prevHash: string | null = null;
  const seenHashes = new Set<string>();
  for (const { kind, payload } of P4_KIND_FIXTURES) {
    const event: EventForHashing = {
      ...P4_BASE,
      kind,
      payload,
      // Stagger captured_at so the chain has a well-defined ordering.
      captured_at: new Date(2026, 3, 29, 0, seenHashes.size, 0, 0),
    };
    const h = hashEvent(prevHash, event);
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.ok(!seenHashes.has(h), `${kind} must produce a unique hash within the chain`);
    seenHashes.add(h);
    prevHash = h;
  }
  assert.equal(seenHashes.size, P4_KIND_FIXTURES.length);
});
