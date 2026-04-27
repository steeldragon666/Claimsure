import { test, after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sql, privilegedSql } from '@cpa/db/client';
import { recomputeAllActive, runRecomputeJob } from './audit-score-recompute.js';

// Pinned UUIDs — the 0d03 segment groups all D3 fixtures.
const TENANT = '00000000-0000-4000-8000-0000000d0301';
const ADMIN_USER = '00000000-0000-4000-8000-0000000d0310';
const SUBJECT_A = '00000000-0000-4000-8000-0000000d0321';
const SUBJECT_B = '00000000-0000-4000-8000-0000000d0322';
const SUBJECT_DELETED = '00000000-0000-4000-8000-0000000d0323';

const cleanup = async (): Promise<void> => {
  await privilegedSql`
    DELETE FROM audit_score_snapshot WHERE tenant_id = ${TENANT}
  `;
  await privilegedSql`
    DELETE FROM subject_tenant WHERE id = ANY(${[SUBJECT_A, SUBJECT_B, SUBJECT_DELETED]})
  `;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM "user" WHERE id = ${ADMIN_USER}`;
  await sql`DELETE FROM tenant WHERE id = ${TENANT}`;
};

before(async () => {
  await cleanup();
  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT}, 'Firm D3', 'firm-d03', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${ADMIN_USER}, 'd03-admin@example.com', 'microsoft', 'microsoft:d03-admin', 'D03 Admin')`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT}, ${ADMIN_USER}, 'admin', true)`;
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                       VALUES (${SUBJECT_A}, ${TENANT}, 'Acme A', 'claimant'),
                              (${SUBJECT_B}, ${TENANT}, 'Acme B', 'claimant'),
                              (${SUBJECT_DELETED}, ${TENANT}, 'Deleted Co', 'claimant')`;
  // Soft-delete the third claimant — recomputeAllActive must skip it.
  await privilegedSql`
    UPDATE subject_tenant SET deleted_at = NOW() WHERE id = ${SUBJECT_DELETED}
  `;
});

beforeEach(async () => {
  await privilegedSql`
    DELETE FROM audit_score_snapshot WHERE tenant_id = ${TENANT}
  `;
});

after(async () => {
  await cleanup();
  await sql.end();
  await privilegedSql.end();
});

test('runRecomputeJob: inserts a snapshot row + returns id + total', async () => {
  const result = await runRecomputeJob({
    tenant_id: TENANT,
    subject_tenant_id: SUBJECT_A,
  });
  assert.match(result.snapshot_id, /^[0-9a-f-]{36}$/);
  assert.equal(typeof result.total_pts, 'number');
  // The fresh claimant has no events / time_entries / signing_request rows,
  // so most rules score 0. has_recent_capture: 0, hypothesis_per_core: 0,
  // no_30day_gap: 10 (max_gap=0 < 30), every_event_has_artefact: 0,
  // time_tracking_active: 0, apportionment_complete: 0,
  // engagement_letter_signed: 0, classifier_avg_confidence: 0,
  // override_rate_low: 0, evidence_kinds_diverse: 0. Total = 10.
  assert.ok(result.total_pts >= 0 && result.total_pts <= 100);

  const rows = await privilegedSql<
    { id: string; total_pts: number; max_pts: number; rule_breakdown: unknown }[]
  >`
    SELECT id, total_pts, max_pts, rule_breakdown
      FROM audit_score_snapshot
     WHERE id = ${result.snapshot_id}
  `;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.max_pts, 100);
  assert.equal(rows[0]?.total_pts, result.total_pts);
  // rule_breakdown is a jsonb array of 10 objects. Tolerate both shapes
  // (parsed-array from postgres-js auto-decode, OR string from a legacy
  // double-encoded INSERT path) so a postgres-js encoding regression
  // surfaces as a useful diff rather than `length === <bytecount>`.
  const rawBreakdown = rows[0]?.rule_breakdown;
  const breakdown = (
    typeof rawBreakdown === 'string' ? JSON.parse(rawBreakdown) : rawBreakdown
  ) as Array<{ id: string; max: number }>;
  assert.equal(breakdown.length, 10);
  assert.ok(breakdown.every((r) => typeof r.id === 'string' && typeof r.max === 'number'));
});

test('runRecomputeJob: each call appends a NEW row (append-only)', async () => {
  const r1 = await runRecomputeJob({
    tenant_id: TENANT,
    subject_tenant_id: SUBJECT_A,
  });
  const r2 = await runRecomputeJob({
    tenant_id: TENANT,
    subject_tenant_id: SUBJECT_A,
  });
  assert.notEqual(r1.snapshot_id, r2.snapshot_id);

  const rows = await privilegedSql<{ id: string }[]>`
    SELECT id FROM audit_score_snapshot
     WHERE subject_tenant_id = ${SUBJECT_A}
  `;
  assert.equal(rows.length, 2);
});

test('recomputeAllActive: iterates non-deleted claimants, skips soft-deleted', async () => {
  const result = await recomputeAllActive();
  // We have SUBJECT_A + SUBJECT_B alive; SUBJECT_DELETED is filtered out.
  // Other tests in the run may have created claimants, so this is a
  // lower-bound assertion.
  assert.ok(result.recomputed >= 2, `expected ≥ 2, got ${result.recomputed}`);

  const ourRows = await privilegedSql<{ subject_tenant_id: string }[]>`
    SELECT subject_tenant_id FROM audit_score_snapshot
     WHERE tenant_id = ${TENANT}
  `;
  const ourIds = new Set(ourRows.map((r) => r.subject_tenant_id));
  assert.ok(ourIds.has(SUBJECT_A));
  assert.ok(ourIds.has(SUBJECT_B));
  assert.ok(!ourIds.has(SUBJECT_DELETED));
});
