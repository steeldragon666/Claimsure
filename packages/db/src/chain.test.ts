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
