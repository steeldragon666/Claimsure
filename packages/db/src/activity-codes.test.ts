// Tests for nextActivityCode (CA/SA auto-generation helper).
//
// IMPORTANT: tests share fixture state and run sequentially. Earlier
// inserts pre-condition later tests (e.g. test 4 relies on CA-01 from
// test 3 to set up the CA-01 + CA-03 gap-fill scenario). Reordering
// these will cause failures from fixture pollution.
//
// Test sequence:
//   1. Empty claim → CA-01 (core)
//   2. Empty claim → SA-01 (supporting)
//   3. Insert CA-01, then nextActivityCode core → CA-02
//   4. Insert CA-03 (gap), then nextActivityCode core → CA-02 (gap-fill)
//   5. SA still independent of CA: nextActivityCode supporting → SA-01
//   6. Different claim (CLAIM_2_ID) → CA-01 (per-claim sequence)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql, privilegedSql } from './client.js';
import { nextActivityCode } from './activity-codes.js';

const TENANT_ID = '00000000-0000-4000-8000-0000ac001111';
const SUBJECT_ID = '00000000-0000-4000-8000-0000ac002222';
const USER_ID = '00000000-0000-4000-8000-0000ac003333';
const PROJECT_ID = '00000000-0000-4000-8000-0000ac004444';
const CLAIM_ID = '00000000-0000-4000-8000-0000ac005555';
const CLAIM_2_ID = '00000000-0000-4000-8000-0000ac005556';

before(async () => {
  await sql.begin(async (tx) => {
    await tx`INSERT INTO tenant (id, name, slug, primary_idp) VALUES (${TENANT_ID}, 'AC Test Firm', 'ac-test-firm', 'mixed')`;
    await tx`INSERT INTO "user" (id, email, primary_idp, external_id) VALUES (${USER_ID}, 'ac-test@example.com', 'microsoft', 'microsoft:ac-test')`;
    await tx`SELECT set_config('app.current_tenant_id', ${TENANT_ID}, true)`;
    await tx`INSERT INTO subject_tenant (id, tenant_id, name, kind) VALUES (${SUBJECT_ID}, ${TENANT_ID}, 'AC Test Claimant', 'claimant')`;
    await tx`INSERT INTO project (id, tenant_id, subject_tenant_id, name, started_at) VALUES (${PROJECT_ID}, ${TENANT_ID}, ${SUBJECT_ID}, 'AC Test Project', '2026-01-01T00:00:00Z')`;
    await tx`INSERT INTO claim (id, tenant_id, subject_tenant_id, fiscal_year) VALUES (${CLAIM_ID}, ${TENANT_ID}, ${SUBJECT_ID}, 2026)`;
    await tx`INSERT INTO claim (id, tenant_id, subject_tenant_id, fiscal_year) VALUES (${CLAIM_2_ID}, ${TENANT_ID}, ${SUBJECT_ID}, 2027)`;
  });
});

after(async () => {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${TENANT_ID}, true)`;
    await tx`DELETE FROM activity WHERE claim_id IN (${CLAIM_ID}, ${CLAIM_2_ID})`;
    await tx`DELETE FROM claim WHERE id IN (${CLAIM_ID}, ${CLAIM_2_ID})`;
    await tx`DELETE FROM project WHERE id = ${PROJECT_ID}`;
    await tx`DELETE FROM subject_tenant WHERE id = ${SUBJECT_ID}`;
  });
  await sql`DELETE FROM "user" WHERE id = ${USER_ID}`;
  await sql`DELETE FROM tenant WHERE id = ${TENANT_ID}`;
  await sql.end();
});

test('nextActivityCode: empty claim returns CA-01 (core)', async () => {
  const code = await nextActivityCode({ claim_id: CLAIM_ID, kind: 'core' });
  assert.equal(code, 'CA-01');
});

test('nextActivityCode: empty claim returns SA-01 (supporting)', async () => {
  const code = await nextActivityCode({ claim_id: CLAIM_ID, kind: 'supporting' });
  assert.equal(code, 'SA-01');
});

test('nextActivityCode: with CA-01 only returns CA-02', async () => {
  // Insert CA-01 first
  await privilegedSql`
    INSERT INTO activity (id, tenant_id, project_id, claim_id, code, kind, title)
    VALUES (
      ${'00000000-0000-4000-8000-0000ac007701'},
      ${TENANT_ID}, ${PROJECT_ID}, ${CLAIM_ID},
      'CA-01', 'core', 'First core activity'
    )
  `;
  const code = await nextActivityCode({ claim_id: CLAIM_ID, kind: 'core' });
  assert.equal(code, 'CA-02');
});

test('nextActivityCode: gap-fill (CA-01 + CA-03 exist) returns CA-02', async () => {
  // Insert CA-03 (CA-01 already inserted in previous test); skip CA-02
  await privilegedSql`
    INSERT INTO activity (id, tenant_id, project_id, claim_id, code, kind, title)
    VALUES (
      ${'00000000-0000-4000-8000-0000ac007703'},
      ${TENANT_ID}, ${PROJECT_ID}, ${CLAIM_ID},
      'CA-03', 'core', 'Third core activity'
    )
  `;
  const code = await nextActivityCode({ claim_id: CLAIM_ID, kind: 'core' });
  assert.equal(code, 'CA-02');
});

test('nextActivityCode: mixed kinds independent (CA-01 does not shadow SA-01)', async () => {
  // CA-01 already exists from prior test; verify SA-01 is still returned
  // for kind=supporting on the same claim
  const code = await nextActivityCode({ claim_id: CLAIM_ID, kind: 'supporting' });
  assert.equal(code, 'SA-01');
});

test('nextActivityCode: per-claim sequence (claim 2 fresh CA-01)', async () => {
  // CLAIM_2_ID has no activities; should still get CA-01
  const code = await nextActivityCode({ claim_id: CLAIM_2_ID, kind: 'core' });
  assert.equal(code, 'CA-01');
});
