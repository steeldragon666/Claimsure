import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { sql, privilegedSql } from './client.js';
import { insertAuditLog } from './audit-log.js';

/**
 * Tests for the `insertAuditLog` writer helper (P5 Task 2.3).
 *
 * Three categories cover the helper's contract:
 *
 *   1. Round-trip: insert → read back → assert all columns match.
 *   2. Tx-participation: insert raises an error AFTER the helper call,
 *      assert the audit_log row was rolled back (proves the helper
 *      uses the caller's tx, not its own).
 *   3. ON DELETE CASCADE: drop the parent firm; assert child audit
 *      rows vanish (mirrors the FK clause in 0022).
 *
 * RLS is covered by `apps/api/src/routes/audit-log.test.ts` (the
 * positive-control test established by Task 2.1) — this file uses
 * `privilegedSql` so the focus stays on writer semantics.
 */

const FIRM_A = '00000000-0000-4000-8000-0000000a1d11';
const FIRM_B = '00000000-0000-4000-8000-0000000a1d12';
const ADMIN_A = '00000000-0000-4000-8000-0000000a1db1';

const cleanup = async (): Promise<void> => {
  // CASCADE on firm_id drops the audit rows when the firm goes; we
  // belt-and-brace by deleting audit rows first so the unit test is
  // independent of whether the cascade fired correctly in a prior run.
  await privilegedSql`DELETE FROM audit_log WHERE firm_id IN (${FIRM_A}, ${FIRM_B})`;
  await privilegedSql`DELETE FROM "user" WHERE id = ${ADMIN_A}`;
  await privilegedSql`DELETE FROM tenant WHERE id IN (${FIRM_A}, ${FIRM_B})`;
};

before(async () => {
  await cleanup();
  await privilegedSql`
    INSERT INTO tenant (id, name, slug, primary_idp)
    VALUES (${FIRM_A}, 'Firm A audit-writer', 'firm-a-audit-writer', 'mixed'),
           (${FIRM_B}, 'Firm B audit-writer', 'firm-b-audit-writer', 'mixed')
  `;
  await privilegedSql`
    INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
    VALUES (${ADMIN_A}, 'audit-writer-admin@example.com', 'microsoft', 'microsoft:audit-writer-admin', 'Audit Writer Admin')
  `;
});

after(async () => {
  await cleanup();
  await sql.end();
  await privilegedSql.end();
});

// ---------------------------------------------------------------------------
// Round-trip — happy path
// ---------------------------------------------------------------------------

test('insertAuditLog: round-trip MAPPING_RULE_CREATED', async () => {
  const ruleId = '00000000-0000-4000-8000-0000000a1d21';
  const result = await privilegedSql.begin(async (tx) => {
    return insertAuditLog({
      tx,
      firmId: FIRM_A,
      kind: 'MAPPING_RULE_CREATED',
      payload: {
        mapping_rule_id: ruleId,
        name: 'fixture rule',
        priority: 10,
        conditions: [],
        action: { type: 'flag_for_review', reason: 'unit test' },
      },
      actorUserId: ADMIN_A,
    });
  });

  assert.equal(typeof result.id, 'string');
  assert.ok(result.created_at instanceof Date);

  // Read back via privilegedSql (RLS bypass) so we don't have to seed
  // the firm GUC for what is fundamentally a writer-shape test.
  const rows = await privilegedSql<
    {
      id: string;
      firm_id: string;
      kind: string;
      payload: { mapping_rule_id?: string };
      actor_user_id: string | null;
    }[]
  >`SELECT id, firm_id, kind, payload, actor_user_id FROM audit_log WHERE id = ${result.id}`;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.firm_id, FIRM_A);
  assert.equal(rows[0]?.kind, 'MAPPING_RULE_CREATED');
  assert.equal(rows[0]?.payload?.mapping_rule_id, ruleId);
  assert.equal(rows[0]?.actor_user_id, ADMIN_A);
});

// ---------------------------------------------------------------------------
// Tx-participation — proves the helper uses the caller's transaction
// ---------------------------------------------------------------------------

test('insertAuditLog: insert participates in caller tx (rollback nukes the row)', async () => {
  const ruleId = '00000000-0000-4000-8000-0000000a1d22';
  // Capture the would-be id by failing the tx after the helper succeeds.
  let capturedId: string | null = null;
  let caught: unknown = null;
  try {
    await privilegedSql.begin(async (tx) => {
      const r = await insertAuditLog({
        tx,
        firmId: FIRM_A,
        kind: 'MAPPING_RULE_UPDATED',
        payload: {
          mapping_rule_id: ruleId,
          fields_changed: { priority: { from: 10, to: 11 } },
        },
        actorUserId: ADMIN_A,
      });
      capturedId = r.id;
      // Fail the transaction AFTER the writer succeeded. If the writer
      // had opened its own tx (instead of riding on the caller's), this
      // throw wouldn't roll the audit row back.
      throw new Error('intentional rollback');
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error && caught.message === 'intentional rollback');
  assert.ok(capturedId !== null, 'helper should have returned an id before the throw');

  const rows = await privilegedSql`SELECT id FROM audit_log WHERE id = ${capturedId}`;
  assert.equal(rows.length, 0, 'rollback must have wiped the audit row');
});

// ---------------------------------------------------------------------------
// ON DELETE CASCADE — dropping the firm wipes its audit log
// ---------------------------------------------------------------------------

test('insertAuditLog: ON DELETE CASCADE on firm_id', async () => {
  const ruleId = '00000000-0000-4000-8000-0000000a1d23';
  const inserted = await privilegedSql.begin(async (tx) => {
    return insertAuditLog({
      tx,
      firmId: FIRM_B,
      kind: 'MAPPING_RULE_ARCHIVED',
      payload: { mapping_rule_id: ruleId, archived_by_user_id: ADMIN_A },
      actorUserId: ADMIN_A,
    });
  });

  // Sanity: row is there before the firm goes.
  const before = await privilegedSql`SELECT id FROM audit_log WHERE id = ${inserted.id}`;
  assert.equal(before.length, 1);

  // Delete the firm — CASCADE on audit_log.firm_id should wipe the
  // audit row in the same statement. Note: also need to drop any
  // dependent rows on `tenant` first if 0023 added more FKs; for the
  // P5b worktree the only tenant FK pointing at FIRM_B is the audit
  // row itself + the user (which was inserted under tenant_user — but
  // we never created a tenant_user link for FIRM_B). Direct DELETE
  // works.
  await privilegedSql`DELETE FROM tenant WHERE id = ${FIRM_B}`;

  const after = await privilegedSql`SELECT id FROM audit_log WHERE id = ${inserted.id}`;
  assert.equal(after.length, 0, 'CASCADE must have wiped the audit row');

  // Re-create FIRM_B for any other tests that run after this one in
  // the same suite (and so the global cleanup() doesn't trip on a
  // missing row). Idempotent: cleanup() handles the dup.
  await privilegedSql`
    INSERT INTO tenant (id, name, slug, primary_idp)
    VALUES (${FIRM_B}, 'Firm B audit-writer', 'firm-b-audit-writer', 'mixed')
  `;
});
