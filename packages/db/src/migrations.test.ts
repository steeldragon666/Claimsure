// P5 swimlane A — denormalization migration round-trip tests.
//
// These tests verify that migrations 0019/0020/0021 apply cleanly against a
// dev DB that's already been migrated past idx=18, that the new columns
// behave as designed (nullable / indexed / FK-enforced), that backfills
// populated existing rows, and that uniqueness constraints fire where
// declared.
//
// Tests run against the same `pnpm db:up` Postgres harness as
// chain.test.ts and activity-codes.test.ts — they assume the migration
// runner has applied every migration up to (and including) the head of
// the journal. This is `pnpm db:migrate` in CI; locally `pnpm db:up &&
// pnpm db:migrate`.
//
// Why round-trip rather than `applyMigrations({ uptoIdx: 18 })`-style:
// the migration runner here is `drizzle-orm/postgres-js/migrator`, which
// applies the full journal in one shot — there's no public API to stop
// at a specific idx. Building a per-idx rewinder would duplicate the
// runner; instead we assert post-conditions on the head schema (column
// exists, FK enforced, backfill populated, etc.).
//
// Each test owns its fixtures via UUIDs that pin a per-task segment
// (`5a1` for Task 1.1, `5a2` for Task 1.2, `5a3` for Task 1.3) so a
// partial run leaves no rows that perturb other suites; cleanup runs in
// both `before` and `after` so the seed is idempotent across reruns.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql, privilegedSql } from './client.js';
import { insertEventWithChain } from './chain.js';

// ---------------------------------------------------------------------------
// Fixture identifiers (hex-only UUIDs; 8-4-4-4-12 layout). The `5a0`
// segment pins the test suite's UUID space so cleanup() targets only
// these rows.
// ---------------------------------------------------------------------------

const TENANT_ID = '00000000-0000-4000-8000-00005a000011';
const USER_ID = '00000000-0000-4000-8000-00005a000012';
const SUBJECT_ID = '00000000-0000-4000-8000-00005a000013';

// Task 1.1 — claim.project_id backfill
const PROJECT_1_ID = '00000000-0000-4000-8000-00005a001101';
const CLAIM_1_WITH_ACTIVITY = '00000000-0000-4000-8000-00005a001102';
const CLAIM_1_NO_ACTIVITY = '00000000-0000-4000-8000-00005a001103';
const ACTIVITY_1_ID = '00000000-0000-4000-8000-00005a001104';

// Task 1.2 — expenditure.claim_id
const PROJECT_2_ID = '00000000-0000-4000-8000-00005a001201';
const CLAIM_2_ID = '00000000-0000-4000-8000-00005a001202';
const EXPENDITURE_2_ID = '00000000-0000-4000-8000-00005a001203';

// Task 1.3 — expenditure_line.line_number
const EXPENDITURE_3_ID = '00000000-0000-4000-8000-00005a001301';
const LINE_3A_ID = '00000000-0000-4000-8000-00005a001302';
const LINE_3B_ID = '00000000-0000-4000-8000-00005a001303';
const LINE_3C_ID = '00000000-0000-4000-8000-00005a001304';

// P6 Task 1.1 — migration 0026 EXPENDITURE_CLASSIFIED CHECK round-trip.
// Reuses TENANT/USER/SUBJECT seeded in the suite-wide before() hook.
const EVENT_26_ID = '00000000-0000-4000-8000-00006a000026';

// P6 Task 1.2 — migration 0027 ACTIVITY_REGISTER_DRAFTED CHECK round-trip.
// Reuses the same suite-wide TENANT/USER/SUBJECT.
const EVENT_27_ID = '00000000-0000-4000-8000-00006a000027';

// P6 Task 1.3 — migration 0028 NARRATIVE_DRAFTED CHECK round-trip.
// Reuses the same suite-wide TENANT/USER/SUBJECT.
const EVENT_28_ID = '00000000-0000-4000-8000-00006a000028';

// P6 Task 1.4 — migration 0029 narrative_draft table + RLS.
// Cross-tenant RLS positive control needs a SECOND tenant + user + subject
// alongside the suite-wide TENANT_ID. The narrative_draft.activity_id FK
// (ON DELETE CASCADE) means we must seed real activity rows for both
// tenants — which in turn requires seeding their parent project + claim.
// Suffix scheme: `001401`–`001408` for tenant-A side fixtures (project /
// claim / activity / draft), `001451`–`001458` for tenant-B side.
const TENANT_B_ID = '00000000-0000-4000-8000-00006a001450';
const USER_B_ID = '00000000-0000-4000-8000-00006a001451';
const SUBJECT_B_ID = '00000000-0000-4000-8000-00006a001452';
const PROJECT_4A_ID = '00000000-0000-4000-8000-00006a001401';
const CLAIM_4A_ID = '00000000-0000-4000-8000-00006a001402';
const ACTIVITY_4A_ID = '00000000-0000-4000-8000-00006a001403';
const DRAFT_4A_ID = '00000000-0000-4000-8000-00006a001404';
const PROJECT_4B_ID = '00000000-0000-4000-8000-00006a001453';
const CLAIM_4B_ID = '00000000-0000-4000-8000-00006a001454';
const ACTIVITY_4B_ID = '00000000-0000-4000-8000-00006a001455';
const DRAFT_4B_ID = '00000000-0000-4000-8000-00006a001456';

// P6 Task 1.5 — migration 0030 narrative_draft_version round-trip.
// Reuses Task 1.4's DRAFT_4A_ID / DRAFT_4B_ID parents (seeded in
// the 0029 test which runs earlier in this file). Three version
// rows: two against tenant-A's draft (initial + section_regen, to
// exercise lineage and the UNIQUE constraint), one against tenant-B
// for the cross-tenant RLS positive control.
const DRAFT_VERSION_5A_INITIAL_ID = '00000000-0000-4000-8000-00006a001501';
const DRAFT_VERSION_5A_REGEN_ID = '00000000-0000-4000-8000-00006a001502';
const DRAFT_VERSION_5B_INITIAL_ID = '00000000-0000-4000-8000-00006a001503';

// P6 Task 6.1 — migration 0034 mapping_rule scalar-string backfill.
// Two rule fixtures: one with conditions stored as a jsonb scalar
// STRING (the bug shape), one with action stored as a jsonb scalar
// STRING. The migration's two UPDATEs re-encode each into its
// proper jsonb array/object shape. Test owns its own user FK because
// mapping_rule.created_by_user_id is NOT NULL. Reuses the suite-wide
// TENANT_ID so we don't need a new tenant row.
const MAPPING_RULE_61_USER_ID = '00000000-0000-4000-8000-00006a006101';
const MAPPING_RULE_61_CONDITIONS_ID = '00000000-0000-4000-8000-00006a006102';
const MAPPING_RULE_61_ACTION_ID = '00000000-0000-4000-8000-00006a006103';

// P6 follow-up — migrations 0035 (audit_log REVOKE UPDATE/DELETE) and
// 0036 (event partial unique index on ACTIVITY_CREATED proposed_id).
// Use a dedicated `c8800` UUID segment so cleanup() targets only these
// rows and there's no overlap with any other suite. Two tenants for
// the cross-tenant uniqueness probe (test 5).
const TENANT_C_ID = '00000000-0000-4000-8000-0000000c8801';
const TENANT_D_ID = '00000000-0000-4000-8000-0000000c8802';
const USER_C_ID = '00000000-0000-4000-8000-0000000c8811';
const USER_D_ID = '00000000-0000-4000-8000-0000000c8812';
const SUBJECT_C_ID = '00000000-0000-4000-8000-0000000c8821';
const SUBJECT_D_ID = '00000000-0000-4000-8000-0000000c8822';
// Per-test event IDs.
const AUDIT_LOG_C1_ID = '00000000-0000-4000-8000-0000000c8831';
// Note: event-row IDs are NOT pinned by constants for the migration-0036
// tests — `insertEventWithChain` mints its own UUID. Cleanup of those
// rows happens via DELETE FROM event WHERE tenant_id IN (TENANT_C_ID,
// TENANT_D_ID), which works because TENANT_C / TENANT_D are dedicated
// to this test segment (the c8800 UUID prefix is unique to the suite).

const cleanup = async (): Promise<void> => {
  // P6 follow-up cleanup (c8800 segment) — drop FIRST because event has
  // FK → tenant(id) and audit_log has FK → tenant(id). Event rows are
  // tenant-scoped delete (rather than id-list) because
  // insertEventWithChain mints its own UUIDs in tests 3-6 below.
  await privilegedSql`DELETE FROM event WHERE tenant_id IN (${TENANT_C_ID}, ${TENANT_D_ID})`;
  await privilegedSql`DELETE FROM audit_log WHERE id = ${AUDIT_LOG_C1_ID}`;
  await privilegedSql`DELETE FROM audit_log WHERE firm_id IN (${TENANT_C_ID}, ${TENANT_D_ID})`;
  await privilegedSql`DELETE FROM subject_tenant WHERE id IN (${SUBJECT_C_ID}, ${SUBJECT_D_ID})`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id IN (${TENANT_C_ID}, ${TENANT_D_ID})`;
  await privilegedSql`DELETE FROM "user" WHERE id IN (${USER_C_ID}, ${USER_D_ID})`;
  await privilegedSql`DELETE FROM tenant WHERE id IN (${TENANT_C_ID}, ${TENANT_D_ID})`;
  // Task 6.1 — mapping_rule fixtures. Delete BEFORE the suite-wide
  // user delete so the created_by_user_id FK is free.
  await privilegedSql`DELETE FROM mapping_rule WHERE id IN (${MAPPING_RULE_61_CONDITIONS_ID}, ${MAPPING_RULE_61_ACTION_ID})`;
  await privilegedSql`DELETE FROM "user" WHERE id = ${MAPPING_RULE_61_USER_ID}`;
  await privilegedSql`DELETE FROM event WHERE id IN (${EVENT_26_ID}, ${EVENT_27_ID}, ${EVENT_28_ID})`;
  // Versions first — FK to narrative_draft has ON DELETE CASCADE so
  // the draft delete below would clean these up too, but explicit
  // DELETE keeps the cleanup readable and idempotent across reruns.
  await privilegedSql`DELETE FROM narrative_draft_version WHERE id IN (${DRAFT_VERSION_5A_INITIAL_ID}, ${DRAFT_VERSION_5A_REGEN_ID}, ${DRAFT_VERSION_5B_INITIAL_ID})`;
  // Drafts next — FK to activity has ON DELETE CASCADE so the activity
  // delete below would clean these up too, but explicit DELETE keeps the
  // cleanup readable and idempotent across reruns.
  await privilegedSql`DELETE FROM narrative_draft WHERE id IN (${DRAFT_4A_ID}, ${DRAFT_4B_ID})`;
  await privilegedSql`DELETE FROM expenditure_line WHERE expenditure_id IN (${EXPENDITURE_2_ID}, ${EXPENDITURE_3_ID})`;
  await privilegedSql`DELETE FROM expenditure WHERE id IN (${EXPENDITURE_2_ID}, ${EXPENDITURE_3_ID})`;
  await privilegedSql`DELETE FROM activity WHERE id IN (${ACTIVITY_1_ID}, ${ACTIVITY_4A_ID}, ${ACTIVITY_4B_ID})`;
  await privilegedSql`DELETE FROM claim WHERE id IN (${CLAIM_1_WITH_ACTIVITY}, ${CLAIM_1_NO_ACTIVITY}, ${CLAIM_2_ID}, ${CLAIM_4A_ID}, ${CLAIM_4B_ID})`;
  await privilegedSql`DELETE FROM project WHERE id IN (${PROJECT_1_ID}, ${PROJECT_2_ID}, ${PROJECT_4A_ID}, ${PROJECT_4B_ID})`;
  await privilegedSql`DELETE FROM subject_tenant WHERE id IN (${SUBJECT_ID}, ${SUBJECT_B_ID})`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id IN (${TENANT_ID}, ${TENANT_B_ID})`;
  await privilegedSql`DELETE FROM "user" WHERE id IN (${USER_ID}, ${USER_B_ID})`;
  await privilegedSql`DELETE FROM tenant WHERE id IN (${TENANT_ID}, ${TENANT_B_ID})`;
};

before(async () => {
  await cleanup();
  await privilegedSql`INSERT INTO tenant (id, name, slug, primary_idp)
                       VALUES (${TENANT_ID}, 'P5A Test Firm', 'p5a-test-firm', 'mixed')`;
  await privilegedSql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
                       VALUES (${USER_ID}, 'p5a-migrations@example.com', 'microsoft',
                               'microsoft:p5a-migrations', 'P5A Test User')`;
  await privilegedSql`SELECT set_config('app.current_tenant_id', ${TENANT_ID}, true)`;
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                       VALUES (${SUBJECT_ID}, ${TENANT_ID}, 'P5A Test Claimant', 'claimant')`;
  // P6 Task 1.4 — second tenant + user + subject_tenant for the
  // narrative_draft RLS positive control test below. privilegedSql
  // bypasses RLS (cpa is the table owner) so we can seed across both
  // tenant scopes without juggling the GUC for these globally-scoped
  // (no RLS) inserts. subject_tenant IS RLS-protected, so we flip
  // the GUC before seeding the tenant-B subject.
  await privilegedSql`INSERT INTO tenant (id, name, slug, primary_idp)
                       VALUES (${TENANT_B_ID}, 'P6 Task 1.4 Tenant B', 'p6-1-4-tenant-b', 'mixed')`;
  await privilegedSql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
                       VALUES (${USER_B_ID}, 'p6-1-4-tenant-b@example.com', 'microsoft',
                               'microsoft:p6-1-4-tenant-b', 'P6 Task 1.4 Tenant B User')`;
  await privilegedSql`SELECT set_config('app.current_tenant_id', ${TENANT_B_ID}, true)`;
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                       VALUES (${SUBJECT_B_ID}, ${TENANT_B_ID}, 'P6 Task 1.4 Tenant B Claimant', 'claimant')`;

  // P6 follow-up — fixtures for migrations 0035 + 0036 tests below.
  // Two tenants are needed for migration 0036's cross-tenant probe
  // (test 5). Each tenant gets one user (FK target on event +
  // audit_log) and one subject_tenant (FK target on event).
  await privilegedSql`INSERT INTO tenant (id, name, slug, primary_idp)
                       VALUES (${TENANT_C_ID}, 'P6H Tenant C', 'p6h-tenant-c', 'mixed')`;
  await privilegedSql`INSERT INTO tenant (id, name, slug, primary_idp)
                       VALUES (${TENANT_D_ID}, 'P6H Tenant D', 'p6h-tenant-d', 'mixed')`;
  await privilegedSql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
                       VALUES (${USER_C_ID}, 'p6h-tenant-c@example.com', 'microsoft',
                               'microsoft:p6h-tenant-c', 'P6H Tenant C User')`;
  await privilegedSql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
                       VALUES (${USER_D_ID}, 'p6h-tenant-d@example.com', 'microsoft',
                               'microsoft:p6h-tenant-d', 'P6H Tenant D User')`;
  // subject_tenant has RLS, so flip the GUC before each insert.
  await privilegedSql`SELECT set_config('app.current_tenant_id', ${TENANT_C_ID}, true)`;
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                       VALUES (${SUBJECT_C_ID}, ${TENANT_C_ID}, 'P6H Tenant C Claimant', 'claimant')`;
  await privilegedSql`SELECT set_config('app.current_tenant_id', ${TENANT_D_ID}, true)`;
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                       VALUES (${SUBJECT_D_ID}, ${TENANT_D_ID}, 'P6H Tenant D Claimant', 'claimant')`;
});

after(async () => {
  await cleanup();
  await sql.end();
  await privilegedSql.end();
});

// ---------------------------------------------------------------------------
// Task 1.1 — claim.project_id
// ---------------------------------------------------------------------------

test('migration 0019: claim.project_id column exists and is nullable', async () => {
  const rows = await privilegedSql<
    { column_name: string; is_nullable: string; data_type: string }[]
  >`
    SELECT column_name, is_nullable, data_type
      FROM information_schema.columns
     WHERE table_name = 'claim' AND column_name = 'project_id'
  `;
  assert.equal(rows.length, 1, 'claim.project_id column must exist');
  assert.equal(rows[0]!.is_nullable, 'YES', 'claim.project_id must be nullable');
  assert.equal(rows[0]!.data_type, 'uuid', 'claim.project_id must be uuid');
});

test('migration 0019: claim_project_id_idx index exists', async () => {
  const rows = await privilegedSql<{ indexname: string }[]>`
    SELECT indexname FROM pg_indexes
     WHERE tablename = 'claim' AND indexname = 'claim_project_id_idx'
  `;
  assert.equal(rows.length, 1, 'claim_project_id_idx index must exist');
});

test('migration 0019: backfill populates claim.project_id from activity.project_id', async () => {
  // Seed a project + a claim with one activity — the migration should
  // have backfilled project_id on existing claims (this row is created
  // post-migration, so we exercise the same path manually with a fresh
  // backfill: insert the claim with project_id NULL, run the same
  // UPDATE, and assert the column populates).
  await privilegedSql`SELECT set_config('app.current_tenant_id', ${TENANT_ID}, true)`;
  await privilegedSql`INSERT INTO project (id, tenant_id, subject_tenant_id, name, started_at)
                       VALUES (${PROJECT_1_ID}, ${TENANT_ID}, ${SUBJECT_ID},
                               'P5A T1.1 Project', '2026-01-01T00:00:00Z')`;
  await privilegedSql`INSERT INTO claim (id, tenant_id, subject_tenant_id, fiscal_year, project_id)
                       VALUES (${CLAIM_1_WITH_ACTIVITY}, ${TENANT_ID}, ${SUBJECT_ID}, 2030, NULL)`;
  await privilegedSql`INSERT INTO activity (id, tenant_id, project_id, claim_id, code, kind, title)
                       VALUES (${ACTIVITY_1_ID}, ${TENANT_ID}, ${PROJECT_1_ID},
                               ${CLAIM_1_WITH_ACTIVITY}, 'CA-01', 'core', 'P5A T1.1 Activity')`;

  // Re-run the backfill expression to simulate the migration's UPDATE
  // (the migration ran once at deploy; this confirms the SQL is
  // correct).
  await privilegedSql`
    UPDATE claim SET project_id = (
      SELECT a.project_id FROM activity a WHERE a.claim_id = claim.id LIMIT 1
    )
    WHERE id = ${CLAIM_1_WITH_ACTIVITY} AND project_id IS NULL
  `;

  const rows = await privilegedSql<{ project_id: string | null }[]>`
    SELECT project_id FROM claim WHERE id = ${CLAIM_1_WITH_ACTIVITY}
  `;
  assert.equal(
    rows[0]!.project_id,
    PROJECT_1_ID,
    'claim.project_id must backfill from activity.project_id',
  );
});

test('migration 0019: claims without activities keep project_id NULL', async () => {
  await privilegedSql`SELECT set_config('app.current_tenant_id', ${TENANT_ID}, true)`;
  await privilegedSql`INSERT INTO claim (id, tenant_id, subject_tenant_id, fiscal_year, project_id)
                       VALUES (${CLAIM_1_NO_ACTIVITY}, ${TENANT_ID}, ${SUBJECT_ID}, 2031, NULL)`;
  // Backfill should leave it NULL (no activity rows reference C1B).
  await privilegedSql`
    UPDATE claim SET project_id = (
      SELECT a.project_id FROM activity a WHERE a.claim_id = claim.id LIMIT 1
    )
    WHERE id = ${CLAIM_1_NO_ACTIVITY} AND project_id IS NULL
  `;
  const rows = await privilegedSql<{ project_id: string | null }[]>`
    SELECT project_id FROM claim WHERE id = ${CLAIM_1_NO_ACTIVITY}
  `;
  assert.equal(rows[0]!.project_id, null, 'claims with no activities must keep project_id NULL');
});

// ---------------------------------------------------------------------------
// Task 1.2 — expenditure.claim_id
// Tests verify column existence, index, and round-trip behaviour for
// migration 0020.
// ---------------------------------------------------------------------------

test('migration 0020: expenditure.claim_id column exists and is nullable', async () => {
  const rows = await privilegedSql<
    { column_name: string; is_nullable: string; data_type: string }[]
  >`
    SELECT column_name, is_nullable, data_type
      FROM information_schema.columns
     WHERE table_name = 'expenditure' AND column_name = 'claim_id'
  `;
  assert.equal(rows.length, 1, 'expenditure.claim_id column must exist');
  assert.equal(rows[0]!.is_nullable, 'YES', 'expenditure.claim_id must be nullable');
  assert.equal(rows[0]!.data_type, 'uuid', 'expenditure.claim_id must be uuid');
});

test('migration 0020: expenditure_claim_id_idx index exists', async () => {
  const rows = await privilegedSql<{ indexname: string }[]>`
    SELECT indexname FROM pg_indexes
     WHERE tablename = 'expenditure' AND indexname = 'expenditure_claim_id_idx'
  `;
  assert.equal(rows.length, 1, 'expenditure_claim_id_idx index must exist');
});

test('migration 0020: round-trip insert with claim_id set', async () => {
  await privilegedSql`SELECT set_config('app.current_tenant_id', ${TENANT_ID}, true)`;
  await privilegedSql`INSERT INTO project (id, tenant_id, subject_tenant_id, name, started_at)
                       VALUES (${PROJECT_2_ID}, ${TENANT_ID}, ${SUBJECT_ID},
                               'P5A T1.2 Project', '2026-01-01T00:00:00Z')`;
  await privilegedSql`INSERT INTO claim (id, tenant_id, subject_tenant_id, fiscal_year, project_id)
                       VALUES (${CLAIM_2_ID}, ${TENANT_ID}, ${SUBJECT_ID}, 2032, ${PROJECT_2_ID})`;
  await privilegedSql`
    INSERT INTO expenditure (
      id, tenant_id, subject_tenant_id, source, vendor_name,
      expenditure_date, total_amount, currency, claim_id
    ) VALUES (
      ${EXPENDITURE_2_ID}, ${TENANT_ID}, ${SUBJECT_ID}, 'manual', 'P5A T1.2 Vendor',
      '2031-08-15'::date, '99.99', 'AUD', ${CLAIM_2_ID}
    )
  `;
  const rows = await privilegedSql<{ claim_id: string | null }[]>`
    SELECT claim_id FROM expenditure WHERE id = ${EXPENDITURE_2_ID}
  `;
  assert.equal(
    rows[0]!.claim_id,
    CLAIM_2_ID,
    'expenditure.claim_id must round-trip the inserted value',
  );
});

// ---------------------------------------------------------------------------
// Task 1.3 — expenditure_line.line_number
// Tests verify NOT NULL DEFAULT 1, the (expenditure_id, line_number) unique
// index, and that ORDER BY line_number ASC supersedes ORDER BY id ASC for
// the multi-line picker callsites in preview-rules.ts.
// ---------------------------------------------------------------------------

test('migration 0021: expenditure_line.line_number column exists with NOT NULL DEFAULT 1', async () => {
  const rows = await privilegedSql<
    {
      column_name: string;
      is_nullable: string;
      data_type: string;
      column_default: string | null;
    }[]
  >`
    SELECT column_name, is_nullable, data_type, column_default
      FROM information_schema.columns
     WHERE table_name = 'expenditure_line' AND column_name = 'line_number'
  `;
  assert.equal(rows.length, 1, 'expenditure_line.line_number column must exist');
  assert.equal(rows[0]!.is_nullable, 'NO', 'expenditure_line.line_number must be NOT NULL');
  assert.equal(rows[0]!.data_type, 'integer', 'expenditure_line.line_number must be integer');
  assert.match(
    rows[0]!.column_default ?? '',
    /^1\b/,
    'expenditure_line.line_number must default to 1',
  );
});

test('migration 0021: (expenditure_id, line_number) unique index exists', async () => {
  const rows = await privilegedSql<{ indexname: string; indexdef: string }[]>`
    SELECT indexname, indexdef FROM pg_indexes
     WHERE tablename = 'expenditure_line'
       AND indexname = 'expenditure_line_number_unique'
  `;
  assert.equal(rows.length, 1, 'expenditure_line_number_unique index must exist');
  assert.match(rows[0]!.indexdef, /UNIQUE/i, 'index must be UNIQUE');
});

test('migration 0021: ORDER BY line_number picks line_number=1 regardless of UUID order', async () => {
  await privilegedSql`SELECT set_config('app.current_tenant_id', ${TENANT_ID}, true)`;
  await privilegedSql`
    INSERT INTO expenditure (
      id, tenant_id, subject_tenant_id, source, vendor_name,
      expenditure_date, total_amount, currency
    ) VALUES (
      ${EXPENDITURE_3_ID}, ${TENANT_ID}, ${SUBJECT_ID}, 'manual', 'P5A T1.3 Multi-line Vendor',
      '2031-09-15'::date, '300.00', 'AUD'
    )
  `;
  // Insert lines with line_numbers 3, 1, 2 in that order. UUIDs L3A
  // (line_number=3), L3B (line_number=1), L3C (line_number=2) — picking
  // by UUID asc would get L3A first; picking by line_number asc must
  // get L3B first.
  await privilegedSql`
    INSERT INTO expenditure_line (id, expenditure_id, description, account_code, amount, line_number)
    VALUES
      (${LINE_3A_ID}, ${EXPENDITURE_3_ID}, 'Third line', '400', '100.00', 3),
      (${LINE_3B_ID}, ${EXPENDITURE_3_ID}, 'First line', '400', '100.00', 1),
      (${LINE_3C_ID}, ${EXPENDITURE_3_ID}, 'Second line', '400', '100.00', 2)
  `;

  // ORDER BY line_number ASC, id ASC must return L3B first.
  const rows = await privilegedSql<{ id: string; line_number: number }[]>`
    SELECT id, line_number FROM expenditure_line
     WHERE expenditure_id = ${EXPENDITURE_3_ID}
     ORDER BY line_number ASC, id ASC
  `;
  assert.equal(
    rows[0]!.id,
    LINE_3B_ID,
    'first row must be the line_number=1 line, not the lowest UUID',
  );
  assert.equal(rows[0]!.line_number, 1);
  assert.equal(rows[1]!.line_number, 2);
  assert.equal(rows[2]!.line_number, 3);
});

test('migration 0021: duplicate (expenditure_id, line_number) is rejected by unique index', async () => {
  await privilegedSql`SELECT set_config('app.current_tenant_id', ${TENANT_ID}, true)`;
  // LINE_3B already has line_number=1; inserting another line_number=1
  // for the same expenditure must violate the unique index.
  const dupId = '00000000-0000-4000-8000-00005a00130d';
  await assert.rejects(
    () => privilegedSql`
      INSERT INTO expenditure_line (id, expenditure_id, description, account_code, amount, line_number)
      VALUES (${dupId}, ${EXPENDITURE_3_ID}, 'Duplicate', '400', '100.00', 1)
    `,
    /unique|duplicate/i,
    'inserting a duplicate (expenditure_id, line_number) must be rejected',
  );
});

// ---------------------------------------------------------------------------
// P6 Task 1.1 — migration 0026 EXPENDITURE_CLASSIFIED kind
// Round-trip: a raw INSERT with kind='EXPENDITURE_CLASSIFIED' must succeed
// post-migration. Pre-migration the same row would fail the
// `event_kind_valid` CHECK with a 23514 violation. Uses privilegedSql to
// bypass RLS on event since the suite-wide before() hook already seeds
// the tenant + subject_tenant fixtures used here. The payload follows
// `ExpenditureClassifiedPayload` in @cpa/schemas/event.ts; the
// `${object}` jsonb bind pattern (no manual JSON.stringify) follows the
// audit-log.ts JSDoc (postgres-js auto-serialises objects to jsonb when
// the placeholder is not preceded by ::text).
// ---------------------------------------------------------------------------

test('migration 0026: event_kind_valid CHECK admits EXPENDITURE_CLASSIFIED', async () => {
  await privilegedSql`SELECT set_config('app.current_tenant_id', ${TENANT_ID}, true)`;
  // Bind the payload object directly (no manual JSON.stringify) and
  // force `::text::jsonb` server-side parsing — same canonical pattern
  // documented in audit-log.ts (and chain.ts as of P6 Task 0.1) so the
  // value lands as a jsonb object regardless of which client opened
  // the tx. privilegedSql's default JSON.stringify serializer handles
  // the object → text conversion at the wire boundary.
  await privilegedSql`
    INSERT INTO event (
      id, tenant_id, subject_tenant_id, kind, payload,
      hash, captured_at, captured_by_user_id
    ) VALUES (
      ${EVENT_26_ID}, ${TENANT_ID}, ${SUBJECT_ID}, 'EXPENDITURE_CLASSIFIED',
      ${JSON.stringify({
        _v: 1,
        expenditure_id: '00000000-0000-4000-8000-000000abc001',
        decision: 'eligible',
        eligibility_probability: 0.92,
        statutory_anchor: 's.355-25',
        suggested_activity_id: null,
        rationale: 'unit test fixture',
        uncertainty_reason: null,
        model: 'claude-haiku-4-5',
        prompt_version: 'classify-expenditure@1.0.0',
        idempotency_key: 'fixture-key',
      })}::text::jsonb,
      ${'a6'.padEnd(64, '0')}, '2026-05-01T00:00:00Z', ${USER_ID}
    )
  `;
  const rows = await privilegedSql<{ id: string; kind: string }[]>`
    SELECT id, kind FROM event WHERE id = ${EVENT_26_ID}
  `;
  assert.equal(rows.length, 1, 'EXPENDITURE_CLASSIFIED row must be admitted by the CHECK');
  assert.equal(rows[0]!.kind, 'EXPENDITURE_CLASSIFIED');
});

// ---------------------------------------------------------------------------
// P6 Task 1.2 — migration 0027 ACTIVITY_REGISTER_DRAFTED kind
// Round-trip: a raw INSERT with kind='ACTIVITY_REGISTER_DRAFTED' must succeed
// post-migration. Pre-migration the same row would fail the
// `event_kind_valid` CHECK with a 23514 violation. Same privilegedSql /
// jsonb-double-cast pattern as the 0026 test above. The payload follows
// `ActivityRegisterDraftedPayload` in @cpa/schemas/event.ts and intentionally
// includes a non-empty `proposed_activities` array so the round-trip
// exercises the nested `ProposedActivity` shape (not just the top-level
// fields).
// ---------------------------------------------------------------------------

test('migration 0027: event_kind_valid CHECK admits ACTIVITY_REGISTER_DRAFTED', async () => {
  await privilegedSql`SELECT set_config('app.current_tenant_id', ${TENANT_ID}, true)`;
  // Two distinct event ids the cluster pretends to have drawn from —
  // they do NOT need to refer to real `event` rows for the CHECK
  // round-trip; the payload is jsonb so referential integrity is
  // not enforced here. They exist just so the inserted row exercises
  // the nested `ProposedActivity.clustered_event_ids` shape.
  const clusteredEventA = '00000000-0000-4000-8000-000000abe001';
  const clusteredEventB = '00000000-0000-4000-8000-000000abe002';
  const unclusteredTail = '00000000-0000-4000-8000-000000abe003';
  const proposedActivityId = '00000000-0000-4000-8000-000000abf001';

  await privilegedSql`
    INSERT INTO event (
      id, tenant_id, subject_tenant_id, kind, payload,
      hash, captured_at, captured_by_user_id
    ) VALUES (
      ${EVENT_27_ID}, ${TENANT_ID}, ${SUBJECT_ID}, 'ACTIVITY_REGISTER_DRAFTED',
      ${JSON.stringify({
        _v: 1,
        project_id: '00000000-0000-4000-8000-000000abd001',
        proposed_activities: [
          {
            proposed_id: proposedActivityId,
            name: 'RL sample-efficiency study',
            kind: 'core',
            statutory_anchor: 's.355-25',
            rationale: 'Cluster spans hypothesis + experiment events on PPO efficiency.',
            clustered_event_ids: [clusteredEventA, clusteredEventB],
            confidence: 0.81,
            proposed_hypothesis:
              'PPO with auxiliary task pretraining converges in <50% of baseline samples.',
            proposed_uncertainty: 'Sample-efficiency gap on sparse-reward envs is unknown.',
          },
        ],
        unclustered_event_ids: [unclusteredTail],
        total_input_events: 3,
        events_truncated: false,
        synthesizer_notes: 'unit test fixture',
        model: 'claude-sonnet-4-5',
        prompt_version: 'synthesize-register@1.0.0',
        idempotency_key: 'fixture-key-27',
      })}::text::jsonb,
      ${'a7'.padEnd(64, '0')}, '2026-05-01T00:00:00Z', ${USER_ID}
    )
  `;
  const rows = await privilegedSql<
    { id: string; kind: string; payload: { proposed_activities: { proposed_id: string }[] } }[]
  >`
    SELECT id, kind, payload FROM event WHERE id = ${EVENT_27_ID}
  `;
  assert.equal(rows.length, 1, 'ACTIVITY_REGISTER_DRAFTED row must be admitted by the CHECK');
  assert.equal(rows[0]!.kind, 'ACTIVITY_REGISTER_DRAFTED');
  // Sanity-check the nested ProposedActivity round-tripped through
  // jsonb intact — this is what makes the test exercise the nested
  // shape, not just the top-level kind admission.
  assert.equal(
    rows[0]!.payload.proposed_activities.length,
    1,
    'payload.proposed_activities must round-trip with one entry',
  );
  assert.equal(
    rows[0]!.payload.proposed_activities[0]!.proposed_id,
    proposedActivityId,
    'nested ProposedActivity.proposed_id must round-trip via jsonb',
  );
});

// ---------------------------------------------------------------------------
// P6 Task 1.3 — migration 0028 NARRATIVE_DRAFTED kind
// Round-trip: a raw INSERT with kind='NARRATIVE_DRAFTED' must succeed
// post-migration. Pre-migration the same row would fail the
// `event_kind_valid` CHECK with a 23514 violation. Same privilegedSql /
// jsonb-double-cast pattern as the 0026 / 0027 tests above. The payload
// follows `NarrativeDraftedPayload` in @cpa/schemas/event.ts and carries
// METADATA ONLY (narrative_draft_id + content_hash + segment counts) —
// the actual segments live in the narrative_draft table created by 0029
// (Task 1.4), not inline on the chain.
// ---------------------------------------------------------------------------

test('migration 0028: event_kind_valid CHECK admits NARRATIVE_DRAFTED', async () => {
  await privilegedSql`SELECT set_config('app.current_tenant_id', ${TENANT_ID}, true)`;
  // The narrative_draft_id and activity_id are sentinels — they do
  // NOT need to refer to real rows for the CHECK round-trip; the
  // payload is jsonb so referential integrity is not enforced here.
  // They exist just so the inserted row exercises the metadata-only
  // shape of NarrativeDraftedPayload.
  const narrativeDraftId = '00000000-0000-4000-8000-000000abf101';
  const activityId = '00000000-0000-4000-8000-000000abf102';

  await privilegedSql`
    INSERT INTO event (
      id, tenant_id, subject_tenant_id, kind, payload,
      hash, captured_at, captured_by_user_id
    ) VALUES (
      ${EVENT_28_ID}, ${TENANT_ID}, ${SUBJECT_ID}, 'NARRATIVE_DRAFTED',
      ${JSON.stringify({
        _v: 1,
        narrative_draft_id: narrativeDraftId,
        activity_id: activityId,
        section_kind: 'new_knowledge',
        version: 1,
        // Lowercase hex sha256 sentinel — matches the
        // ^[a-f0-9]{64}$ regex on NarrativeDraftedPayload.content_hash.
        content_hash: 'a'.repeat(64),
        model: 'claude-sonnet-4-5',
        prompt_version: 'draft-narrative@1.0.0',
        segment_count: 7,
        claim_segment_count: 4,
        idempotency_key: 'fixture-key-28',
      })}::text::jsonb,
      ${'a8'.padEnd(64, '0')}, '2026-05-01T00:00:00Z', ${USER_ID}
    )
  `;
  const rows = await privilegedSql<
    {
      id: string;
      kind: string;
      payload: { narrative_draft_id: string; content_hash: string; section_kind: string };
    }[]
  >`
    SELECT id, kind, payload FROM event WHERE id = ${EVENT_28_ID}
  `;
  assert.equal(rows.length, 1, 'NARRATIVE_DRAFTED row must be admitted by the CHECK');
  assert.equal(rows[0]!.kind, 'NARRATIVE_DRAFTED');
  // Sanity-check the metadata-only payload round-tripped through
  // jsonb intact — confirms the chain stores narrative_draft_id and
  // content_hash (the auditor's two anchors into the persisted
  // narrative_draft row) verbatim.
  assert.equal(
    rows[0]!.payload.narrative_draft_id,
    narrativeDraftId,
    'payload.narrative_draft_id must round-trip via jsonb',
  );
  assert.equal(
    rows[0]!.payload.content_hash,
    'a'.repeat(64),
    'payload.content_hash must round-trip via jsonb',
  );
  assert.equal(
    rows[0]!.payload.section_kind,
    'new_knowledge',
    'payload.section_kind must round-trip via jsonb',
  );
});

// ---------------------------------------------------------------------------
// P6 Task 1.4 — migration 0029 narrative_draft table + RLS isolation.
// Two assertions in one test:
//   1. Column existence (NOT NULL ordinal-position list matches the
//      Task 1.4 spec verbatim) — guards against accidental column
//      reorders or drops.
//   2. RLS positive control — seed one draft per tenant via the
//      privileged client, then verify a TENANT_A session can read its
//      own draft and CANNOT see the TENANT_B row through the
//      `narrative_draft_tenant_isolation` policy.
// Uses privilegedSql to seed (cpa is the table owner so RLS still
// applies even with FORCE — except when the role is a superuser, which
// cpa IS in the dev harness — that's why migrations.test.ts inserts
// run privileged), then sql.begin() with a per-tx GUC flip to exercise
// the policy from the cpa_app role (which is non-superuser, non-owner —
// RLS DOES apply).
//
// Segments are bound via the canonical `${object}::text::jsonb` pattern
// documented in audit-log.ts (and chain.ts as of P6 Task 0.1) so the
// jsonb column lands as a parsed object, not a JSON-encoded string.
// ---------------------------------------------------------------------------

test('migration 0029: narrative_draft table exists with expected columns and RLS isolation', async () => {
  // ---- 1. Column existence assertion -------------------------------------
  const cols = await privilegedSql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
     WHERE table_name = 'narrative_draft'
     ORDER BY ordinal_position
  `;
  const expected = [
    'tenant_id',
    'id',
    'activity_id',
    'section_kind',
    'current_version',
    'status',
    'segments',
    'content_hash',
    'model',
    'prompt_version',
    'idempotency_key',
    'created_at',
    'updated_at',
    'created_by_user_id',
  ];
  assert.deepEqual(
    cols.map((c) => c.column_name),
    expected,
    'narrative_draft columns must match the Task 1.4 spec in declared order',
  );

  // ---- 2. Seed one project + claim + activity + draft per tenant ---------
  // Both inserts go through privilegedSql (cpa is the migration role,
  // RLS-bypassing because it's the table owner + superuser) so we can
  // span tenants without juggling the GUC for the seed itself. The
  // RLS check below uses the cpa_app role (sql) which is non-owner +
  // non-superuser, so the policy actually fires.
  await privilegedSql`SELECT set_config('app.current_tenant_id', ${TENANT_ID}, true)`;
  await privilegedSql`INSERT INTO project (id, tenant_id, subject_tenant_id, name, started_at)
                       VALUES (${PROJECT_4A_ID}, ${TENANT_ID}, ${SUBJECT_ID},
                               'P6 T1.4 Tenant A Project', '2026-01-01T00:00:00Z')`;
  await privilegedSql`INSERT INTO claim (id, tenant_id, subject_tenant_id, fiscal_year, project_id)
                       VALUES (${CLAIM_4A_ID}, ${TENANT_ID}, ${SUBJECT_ID}, 2034, ${PROJECT_4A_ID})`;
  await privilegedSql`INSERT INTO activity (id, tenant_id, project_id, claim_id, code, kind, title)
                       VALUES (${ACTIVITY_4A_ID}, ${TENANT_ID}, ${PROJECT_4A_ID},
                               ${CLAIM_4A_ID}, 'CA-01', 'core', 'P6 T1.4 Tenant A Activity')`;
  await privilegedSql`SELECT set_config('app.current_tenant_id', ${TENANT_B_ID}, true)`;
  await privilegedSql`INSERT INTO project (id, tenant_id, subject_tenant_id, name, started_at)
                       VALUES (${PROJECT_4B_ID}, ${TENANT_B_ID}, ${SUBJECT_B_ID},
                               'P6 T1.4 Tenant B Project', '2026-01-01T00:00:00Z')`;
  await privilegedSql`INSERT INTO claim (id, tenant_id, subject_tenant_id, fiscal_year, project_id)
                       VALUES (${CLAIM_4B_ID}, ${TENANT_B_ID}, ${SUBJECT_B_ID}, 2034, ${PROJECT_4B_ID})`;
  await privilegedSql`INSERT INTO activity (id, tenant_id, project_id, claim_id, code, kind, title)
                       VALUES (${ACTIVITY_4B_ID}, ${TENANT_B_ID}, ${PROJECT_4B_ID},
                               ${CLAIM_4B_ID}, 'CA-01', 'core', 'P6 T1.4 Tenant B Activity')`;

  // Each draft is one segment for brevity — the RLS positive control
  // doesn't care about segment shape, it cares about tenant isolation.
  // The `JSON.stringify(...)::text::jsonb` pattern matches the canonical
  // chain.ts / audit-log.ts idiom: explicit JSON.stringify on the JS
  // side + ::text::jsonb cast on the SQL side keeps the wire type pinned
  // to TEXT and forces server-side jsonb parsing. We use stringify
  // explicitly here (rather than relying on postgres-js's object
  // serializer) because the segments value is an ARRAY — postgres-js
  // may try to detect a Postgres-array bind for raw `[...]` literals,
  // which is the wrong shape for a jsonb column.
  const draftSegmentsA = [{ type: 'prose', text: 'Tenant A new-knowledge prose segment.' }];
  const draftSegmentsB = [{ type: 'prose', text: 'Tenant B new-knowledge prose segment.' }];
  await privilegedSql`SELECT set_config('app.current_tenant_id', ${TENANT_ID}, true)`;
  await privilegedSql`
    INSERT INTO narrative_draft (
      tenant_id, id, activity_id, section_kind, current_version, status,
      segments, content_hash, model, prompt_version, idempotency_key,
      created_by_user_id
    ) VALUES (
      ${TENANT_ID}, ${DRAFT_4A_ID}, ${ACTIVITY_4A_ID}, 'new_knowledge', 1, 'complete',
      ${JSON.stringify(draftSegmentsA)}::text::jsonb,
      ${'a'.repeat(64)}, 'claude-sonnet-4-5', 'draft-narrative@1.0.0', NULL,
      ${USER_ID}
    )
  `;
  await privilegedSql`SELECT set_config('app.current_tenant_id', ${TENANT_B_ID}, true)`;
  await privilegedSql`
    INSERT INTO narrative_draft (
      tenant_id, id, activity_id, section_kind, current_version, status,
      segments, content_hash, model, prompt_version, idempotency_key,
      created_by_user_id
    ) VALUES (
      ${TENANT_B_ID}, ${DRAFT_4B_ID}, ${ACTIVITY_4B_ID}, 'new_knowledge', 1, 'complete',
      ${JSON.stringify(draftSegmentsB)}::text::jsonb,
      ${'b'.repeat(64)}, 'claude-sonnet-4-5', 'draft-narrative@1.0.0', NULL,
      ${USER_B_ID}
    )
  `;

  // ---- 3. RLS positive control via the cpa_app role ----------------------
  // sql is the non-owner, non-superuser handle — RLS DOES apply. Set
  // the GUC to TENANT_ID inside a transaction; the SELECT must see
  // ONLY the tenant-A draft, not the tenant-B one.
  const visibleAsA = await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${TENANT_ID}, true)`;
    return tx<{ id: string }[]>`SELECT id FROM narrative_draft ORDER BY id`;
  });
  assert.equal(
    visibleAsA.length,
    1,
    'TENANT_A session must see exactly one narrative_draft row through RLS',
  );
  assert.equal(
    visibleAsA[0]!.id,
    DRAFT_4A_ID,
    'TENANT_A session must see only its own draft (tenant-B draft is invisible)',
  );

  // Symmetric assertion for TENANT_B — guards against an accidental
  // policy that always returned tenant-A regardless of GUC.
  const visibleAsB = await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${TENANT_B_ID}, true)`;
    return tx<{ id: string }[]>`SELECT id FROM narrative_draft ORDER BY id`;
  });
  assert.equal(visibleAsB.length, 1, 'TENANT_B session must see exactly one row through RLS');
  assert.equal(visibleAsB[0]!.id, DRAFT_4B_ID, 'TENANT_B session must see only its own draft');
});

// ---------------------------------------------------------------------------
// P6 Task 1.5 — migration 0030 narrative_draft_version (append-only history).
// Six assertions in one test:
//   1. Column existence (NOT NULL ordinal-position list matches the
//      Task 1.5 spec verbatim) — guards against accidental column
//      reorders or drops.
//   2. Initial version insert (parent_version=NULL, version=1,
//      generation_kind='initial') — happy path for the first version
//      of a draft.
//   3. section_regen version insert (parent_version=1, version=2,
//      generation_kind='section_regen') — happy path for lineage.
//   4. UNIQUE violation on duplicate (tenant_id, draft_id, version) —
//      attempting another version=2 against the same draft must be
//      rejected by the unique index (worker-retry safety).
//   5. Append-only enforcement: an UPDATE attempt as the cpa_app role
//      must fail with a permission-denied error (the migration grants
//      only SELECT, INSERT — no UPDATE / DELETE).
//   6. RLS positive control — a TENANT_A session via cpa_app must see
//      its own version rows but NOT the TENANT_B row.
//
// Reuses Task 1.4's DRAFT_4A_ID / DRAFT_4B_ID parents seeded by the
// 0029 test which runs earlier in this file (Node's test runner
// preserves declaration order within a file). Segments are bound via
// the canonical `${JSON.stringify(arr)}::text::jsonb` pattern (same
// as the 0029 test) — explicit JSON.stringify on the JS side because
// segments is an ARRAY, and postgres-js may try to detect a Postgres-
// array bind for raw `[...]` literals (wrong shape for jsonb).
// ---------------------------------------------------------------------------

test('migration 0030: narrative_draft_version append-only table + RLS isolation', async () => {
  // ---- 1. Column existence assertion -------------------------------------
  const cols = await privilegedSql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
     WHERE table_name = 'narrative_draft_version'
     ORDER BY ordinal_position
  `;
  const expected = [
    'tenant_id',
    'id',
    'draft_id',
    'version',
    'segments',
    'content_hash',
    'model',
    'prompt_version',
    'parent_version',
    'generation_kind',
    'created_at',
    'created_by_user_id',
  ];
  assert.deepEqual(
    cols.map((c) => c.column_name),
    expected,
    'narrative_draft_version columns must match the Task 1.5 spec in declared order',
  );

  // ---- 2. Initial version insert (parent_version=NULL) -------------------
  const initialSegmentsA = [
    { type: 'prose', text: 'Tenant A initial new-knowledge prose segment.' },
  ];
  await privilegedSql`SELECT set_config('app.current_tenant_id', ${TENANT_ID}, true)`;
  await privilegedSql`
    INSERT INTO narrative_draft_version (
      tenant_id, id, draft_id, version, segments, content_hash, model,
      prompt_version, parent_version, generation_kind, created_by_user_id
    ) VALUES (
      ${TENANT_ID}, ${DRAFT_VERSION_5A_INITIAL_ID}, ${DRAFT_4A_ID}, 1,
      ${JSON.stringify(initialSegmentsA)}::text::jsonb,
      ${'a'.repeat(64)}, 'claude-sonnet-4-5', 'draft-narrative@1.0.0',
      NULL, 'initial', ${USER_ID}
    )
  `;

  // Verify the initial row landed with parent_version IS NULL — confirms
  // the column is genuinely nullable (no NOT NULL drift) and round-trips
  // a NULL bind correctly.
  const initialRow = await privilegedSql<
    {
      version: number;
      parent_version: number | null;
      generation_kind: string;
    }[]
  >`SELECT version, parent_version, generation_kind
      FROM narrative_draft_version WHERE id = ${DRAFT_VERSION_5A_INITIAL_ID}`;
  assert.equal(initialRow.length, 1, 'initial version row must round-trip');
  assert.equal(initialRow[0]!.version, 1, 'initial version must be 1');
  assert.equal(
    initialRow[0]!.parent_version,
    null,
    'initial version must have NULL parent_version',
  );
  assert.equal(
    initialRow[0]!.generation_kind,
    'initial',
    'initial version must have generation_kind=initial',
  );

  // ---- 3. section_regen version insert (parent_version=1, version=2) ----
  const regenSegmentsA = [
    { type: 'prose', text: 'Tenant A regenerated new-knowledge prose segment.' },
  ];
  await privilegedSql`
    INSERT INTO narrative_draft_version (
      tenant_id, id, draft_id, version, segments, content_hash, model,
      prompt_version, parent_version, generation_kind, created_by_user_id
    ) VALUES (
      ${TENANT_ID}, ${DRAFT_VERSION_5A_REGEN_ID}, ${DRAFT_4A_ID}, 2,
      ${JSON.stringify(regenSegmentsA)}::text::jsonb,
      ${'c'.repeat(64)}, 'claude-sonnet-4-5', 'draft-narrative@1.0.0',
      1, 'section_regen', ${USER_ID}
    )
  `;

  const regenRow = await privilegedSql<
    {
      version: number;
      parent_version: number | null;
      generation_kind: string;
    }[]
  >`SELECT version, parent_version, generation_kind
      FROM narrative_draft_version WHERE id = ${DRAFT_VERSION_5A_REGEN_ID}`;
  assert.equal(regenRow.length, 1, 'section_regen version row must round-trip');
  assert.equal(regenRow[0]!.version, 2, 'regen version must be 2');
  assert.equal(regenRow[0]!.parent_version, 1, 'regen must point at parent_version=1');
  assert.equal(
    regenRow[0]!.generation_kind,
    'section_regen',
    'regen must have generation_kind=section_regen',
  );

  // ---- 4. UNIQUE violation on duplicate (tenant_id, draft_id, version) --
  // Worker-retry safety: a second version=2 against the same draft must
  // fail loudly. The unique index is the structural guard.
  const dupId = '00000000-0000-4000-8000-00006a00150d';
  const dupSegments = [{ type: 'prose', text: 'Duplicate version=2 attempt.' }];
  await assert.rejects(
    () => privilegedSql`
      INSERT INTO narrative_draft_version (
        tenant_id, id, draft_id, version, segments, content_hash, model,
        prompt_version, parent_version, generation_kind, created_by_user_id
      ) VALUES (
        ${TENANT_ID}, ${dupId}, ${DRAFT_4A_ID}, 2,
        ${JSON.stringify(dupSegments)}::text::jsonb,
        ${'d'.repeat(64)}, 'claude-sonnet-4-5', 'draft-narrative@1.0.0',
        1, 'section_regen', ${USER_ID}
      )
    `,
    /unique|duplicate/i,
    'duplicate (tenant_id, draft_id, version) must be rejected by the unique index',
  );

  // ---- 5. Append-only enforcement: UPDATE denied to cpa_app -------------
  // The migration grants only SELECT, INSERT to cpa_app — no UPDATE /
  // DELETE. Postgres surfaces "permission denied for table
  // narrative_draft_version" (SQLSTATE 42501) when the role lacks the
  // privilege. This is the structural append-only enforcement (mirrors
  // audit_log from migration 0022).
  await assert.rejects(
    () =>
      sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${TENANT_ID}, true)`;
        await tx`
          UPDATE narrative_draft_version
             SET content_hash = ${'e'.repeat(64)}
           WHERE id = ${DRAFT_VERSION_5A_INITIAL_ID}
        `;
      }),
    /permission denied/i,
    'UPDATE on narrative_draft_version as cpa_app must fail (append-only GRANT)',
  );

  // ---- 6. RLS positive control: seed a tenant-B version + cross-tenant --
  // Seed one tenant-B row (privilegedSql bypasses RLS as table owner +
  // superuser) so the cross-tenant SELECT below has something to NOT see.
  const initialSegmentsB = [
    { type: 'prose', text: 'Tenant B initial new-knowledge prose segment.' },
  ];
  await privilegedSql`SELECT set_config('app.current_tenant_id', ${TENANT_B_ID}, true)`;
  await privilegedSql`
    INSERT INTO narrative_draft_version (
      tenant_id, id, draft_id, version, segments, content_hash, model,
      prompt_version, parent_version, generation_kind, created_by_user_id
    ) VALUES (
      ${TENANT_B_ID}, ${DRAFT_VERSION_5B_INITIAL_ID}, ${DRAFT_4B_ID}, 1,
      ${JSON.stringify(initialSegmentsB)}::text::jsonb,
      ${'b'.repeat(64)}, 'claude-sonnet-4-5', 'draft-narrative@1.0.0',
      NULL, 'initial', ${USER_B_ID}
    )
  `;

  // sql is the cpa_app handle (non-owner, non-superuser) — RLS DOES
  // apply. TENANT_A session must see ONLY its own two version rows
  // (the initial + the section_regen seeded above), NOT the tenant-B
  // row.
  const visibleAsA = await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${TENANT_ID}, true)`;
    return tx<{ id: string }[]>`SELECT id FROM narrative_draft_version ORDER BY id`;
  });
  assert.equal(
    visibleAsA.length,
    2,
    'TENANT_A session must see exactly two narrative_draft_version rows through RLS',
  );
  const visibleIds = visibleAsA.map((r) => r.id).sort();
  assert.deepEqual(
    visibleIds,
    [DRAFT_VERSION_5A_INITIAL_ID, DRAFT_VERSION_5A_REGEN_ID].sort(),
    'TENANT_A session must see only its own version rows (tenant-B row is invisible)',
  );

  // Symmetric assertion for TENANT_B — guards against an accidental
  // policy that always returned tenant-A regardless of GUC.
  const visibleAsB = await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${TENANT_B_ID}, true)`;
    return tx<{ id: string }[]>`SELECT id FROM narrative_draft_version ORDER BY id`;
  });
  assert.equal(visibleAsB.length, 1, 'TENANT_B session must see exactly one row through RLS');
  assert.equal(
    visibleAsB[0]!.id,
    DRAFT_VERSION_5B_INITIAL_ID,
    'TENANT_B session must see only its own version row',
  );
});

// ---------------------------------------------------------------------------
// P6 Task 6.1 — migration 0034 mapping_rule scalar-string backfill
//
// The migration is idempotent and ALREADY ran on the test DB by the time
// this test executes (the `pnpm db:migrate` runner applies the full
// journal before the suite starts). To exercise the backfill SQL
// behaviorally, this test takes Option A from the task spec:
//
//   1. Seed two mapping_rule rows whose `conditions` / `action` columns
//      hold jsonb SCALAR STRINGS (the bug shape). We construct the
//      scalar via a `to_jsonb(text)` cast so postgres-js doesn't try to
//      decode the bind value as a JSON object/array — the wire shape we
//      want is a jsonb scalar whose underlying text content happens to
//      look like a JSON-serialised array/object.
//   2. Re-run the two UPDATE statements from the migration inline. They
//      WHERE-filter on jsonb_typeof(...) = 'string', so only the bug-
//      shape rows are touched.
//   3. Assert jsonb_typeof flipped to 'array' and 'object' respectively
//      — proves the backfill re-encoded the scalar back into a structural
//      jsonb value.
//   4. Re-run the same SQL again — assert `jsonb_typeof` is unchanged
//      and the row content is byte-identical (idempotency: the WHERE
//      filter excludes already-correct rows).
//   5. cleanup() (defined above + after()) drops the rows.
//
// We DON'T use `pnpm db:migrate` here because the migration has already
// run and the runner has no public "re-run idx N" surface. Inlining the
// two UPDATEs is the same SQL the migration ships — a future revert of
// the migration body would still surface here as a behavioral regression.
// ---------------------------------------------------------------------------

test('migration 0034: mapping_rule scalar-string backfill re-encodes conditions to array', async () => {
  await privilegedSql`SELECT set_config('app.current_tenant_id', ${TENANT_ID}, true)`;
  // Seed a user row owned by the suite — mapping_rule.created_by_user_id
  // is NOT NULL FK to user.id. Re-using the suite-wide USER_ID would
  // collide with cleanup ordering (the suite-level after() drops it
  // before this test's cleanup runs in some interleavings), so we own
  // a dedicated fixture user.
  await privilegedSql`
    INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
    VALUES (
      ${MAPPING_RULE_61_USER_ID}, 'p6-6-1@example.com', 'microsoft',
      'microsoft:p6-6-1', 'P6 Task 6.1 User'
    )
  `;

  // The bug shape: a jsonb SCALAR whose decoded text is the string
  // representation of an array. `to_jsonb(text)` produces a jsonb
  // scalar string; jsonb_typeof on it returns 'string'. This is what
  // the pre-fix drizzle-mutated single-cast pattern wrote.
  const conditionsBugText = '["vendor=Acme"]';
  // For the action row, the bug shape is a jsonb scalar whose decoded
  // text is the string representation of an object (the action shape).
  const actionBugText = '{"kind":"map","activity_id":"00000000-0000-4000-8000-000000abc999"}';

  // Insert the conditions-bug row. action is a valid object so it
  // doesn't collide with the second test's premise.
  await privilegedSql`
    INSERT INTO mapping_rule (
      tenant_id, id, name, priority, enabled,
      conditions, action, created_by_user_id
    ) VALUES (
      ${TENANT_ID}, ${MAPPING_RULE_61_CONDITIONS_ID},
      'P6 T6.1 conditions-bug fixture', 100, true,
      to_jsonb(${conditionsBugText}::text),
      ${JSON.stringify({ kind: 'flag_for_review' })}::text::jsonb,
      ${MAPPING_RULE_61_USER_ID}
    )
  `;

  // Insert the action-bug row. conditions is a valid array so the
  // first UPDATE doesn't touch it.
  await privilegedSql`
    INSERT INTO mapping_rule (
      tenant_id, id, name, priority, enabled,
      conditions, action, created_by_user_id
    ) VALUES (
      ${TENANT_ID}, ${MAPPING_RULE_61_ACTION_ID},
      'P6 T6.1 action-bug fixture', 101, true,
      ${JSON.stringify([])}::text::jsonb,
      to_jsonb(${actionBugText}::text),
      ${MAPPING_RULE_61_USER_ID}
    )
  `;

  // Sanity check: pre-backfill, both rows hold jsonb scalar strings
  // in their respective bug columns.
  const preTypes = await privilegedSql<
    { id: string; conditions_type: string; action_type: string }[]
  >`
    SELECT id,
           jsonb_typeof(conditions) AS conditions_type,
           jsonb_typeof(action)     AS action_type
      FROM mapping_rule
     WHERE id IN (${MAPPING_RULE_61_CONDITIONS_ID}, ${MAPPING_RULE_61_ACTION_ID})
     ORDER BY id
  `;
  assert.equal(preTypes.length, 2, 'both fixture rows must round-trip');
  const preByConditionsId = preTypes.find((r) => r.id === MAPPING_RULE_61_CONDITIONS_ID)!;
  const preByActionId = preTypes.find((r) => r.id === MAPPING_RULE_61_ACTION_ID)!;
  assert.equal(
    preByConditionsId.conditions_type,
    'string',
    'pre-backfill: conditions-bug row must hold a jsonb scalar string',
  );
  assert.equal(
    preByActionId.action_type,
    'string',
    'pre-backfill: action-bug row must hold a jsonb scalar string',
  );

  // ---- Run the two UPDATE statements from migration 0034 inline. -------
  // These are byte-identical to the migration body — a future revert
  // would surface as a regression here.
  await privilegedSql`
    UPDATE mapping_rule
       SET conditions = (conditions #>> '{}')::jsonb
     WHERE jsonb_typeof(conditions) = 'string'
  `;
  await privilegedSql`
    UPDATE mapping_rule
       SET action = (action #>> '{}')::jsonb
     WHERE jsonb_typeof(action) = 'string'
  `;

  // ---- Post-backfill assertions ----------------------------------------
  const postTypes = await privilegedSql<
    {
      id: string;
      conditions_type: string;
      action_type: string;
      conditions: unknown;
      action: unknown;
    }[]
  >`
    SELECT id,
           jsonb_typeof(conditions) AS conditions_type,
           jsonb_typeof(action)     AS action_type,
           conditions, action
      FROM mapping_rule
     WHERE id IN (${MAPPING_RULE_61_CONDITIONS_ID}, ${MAPPING_RULE_61_ACTION_ID})
     ORDER BY id
  `;
  const postByConditionsId = postTypes.find((r) => r.id === MAPPING_RULE_61_CONDITIONS_ID)!;
  const postByActionId = postTypes.find((r) => r.id === MAPPING_RULE_61_ACTION_ID)!;
  assert.equal(
    postByConditionsId.conditions_type,
    'array',
    'post-backfill: conditions-bug row must now hold a jsonb array',
  );
  assert.deepEqual(
    postByConditionsId.conditions,
    ['vendor=Acme'],
    'post-backfill: conditions content must round-trip as the parsed array',
  );
  assert.equal(
    postByActionId.action_type,
    'object',
    'post-backfill: action-bug row must now hold a jsonb object',
  );
  assert.deepEqual(
    postByActionId.action,
    { kind: 'map', activity_id: '00000000-0000-4000-8000-000000abc999' },
    'post-backfill: action content must round-trip as the parsed object',
  );

  // ---- Idempotency: re-run the SQL — already-correct rows must be -----
  // skipped by the WHERE filter and the values stay byte-identical.
  await privilegedSql`
    UPDATE mapping_rule
       SET conditions = (conditions #>> '{}')::jsonb
     WHERE jsonb_typeof(conditions) = 'string'
  `;
  await privilegedSql`
    UPDATE mapping_rule
       SET action = (action #>> '{}')::jsonb
     WHERE jsonb_typeof(action) = 'string'
  `;

  const idempotentTypes = await privilegedSql<
    { id: string; conditions: unknown; action: unknown }[]
  >`
    SELECT id, conditions, action
      FROM mapping_rule
     WHERE id IN (${MAPPING_RULE_61_CONDITIONS_ID}, ${MAPPING_RULE_61_ACTION_ID})
     ORDER BY id
  `;
  const idemByConditionsId = idempotentTypes.find((r) => r.id === MAPPING_RULE_61_CONDITIONS_ID)!;
  const idemByActionId = idempotentTypes.find((r) => r.id === MAPPING_RULE_61_ACTION_ID)!;
  assert.deepEqual(
    idemByConditionsId.conditions,
    postByConditionsId.conditions,
    'idempotent re-run must leave conditions unchanged',
  );
  assert.deepEqual(
    idemByActionId.action,
    postByActionId.action,
    'idempotent re-run must leave action unchanged',
  );
});

// ---------------------------------------------------------------------------
// P6 follow-up — migration 0035: audit_log REVOKE UPDATE, DELETE
//
// Migration 0022 created audit_log with `GRANT SELECT, INSERT ON audit_log
// TO cpa_app`, but migration 0002's `ALTER DEFAULT PRIVILEGES ... GRANT
// SELECT, INSERT, UPDATE, DELETE ON TABLES TO cpa_app` had already
// auto-granted ALL CRUD to cpa_app on every newly-created table. So the
// 0022 GRANT was a no-op (additive), and cpa_app could in fact UPDATE and
// DELETE audit_log rows — defeating the append-only intent.
//
// Migration 0035 retroactively REVOKEs UPDATE, DELETE from cpa_app on
// audit_log. The two tests below verify that:
//   1. UPDATE as cpa_app fails with `permission denied`.
//   2. DELETE as cpa_app fails with `permission denied`.
// They mirror the test in this file at line ~880 ("Append-only enforcement:
// UPDATE denied to cpa_app") that proves the same REVOKE works on
// narrative_draft_version (migration 0030).
//
// SETUP: insert one audit_log row via privilegedSql (cpa role bypasses
// RLS as table owner + superuser, and has full CRUD via the migration).
// Then attempt UPDATE / DELETE via sql.begin (cpa_app role) — the
// permission denied is raised at the privilege check before RLS evaluates
// rows, so the GUC value doesn't matter for the negative-path assertion.
// ---------------------------------------------------------------------------

test('migration 0035: audit_log UPDATE rejected as cpa_app (append-only enforcement)', async () => {
  // Seed an audit_log row as cpa (privilegedSql bypasses RLS).
  await privilegedSql`
    INSERT INTO audit_log (id, firm_id, kind, payload, actor_user_id)
    VALUES (
      ${AUDIT_LOG_C1_ID}, ${TENANT_C_ID}, 'P6H_TEST_KIND',
      ${JSON.stringify({ note: 'p6h follow-up audit_log row' })}::text::jsonb,
      ${USER_C_ID}
    )
  `;

  // Sanity check the row is visible to privilegedSql.
  const seeded = await privilegedSql<{ id: string }[]>`
    SELECT id FROM audit_log WHERE id = ${AUDIT_LOG_C1_ID}
  `;
  assert.equal(seeded.length, 1, 'audit_log seed row must round-trip to privilegedSql');

  // UPDATE as cpa_app must fail with permission denied (sqlstate 42501).
  // Set BOTH GUCs the audit_log RLS policy expects (current_firm_id
  // is the audit_log policy's predicate) plus current_tenant_id for
  // good measure — although the privilege check fires before RLS, so
  // the GUC values are belt-and-suspenders here.
  await assert.rejects(
    () =>
      sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${TENANT_C_ID}, true)`;
        await tx`SELECT set_config('app.current_firm_id', ${TENANT_C_ID}, true)`;
        await tx`
          UPDATE audit_log
             SET kind = 'TAMPERED'
           WHERE id = ${AUDIT_LOG_C1_ID}
        `;
      }),
    /permission denied/i,
    'UPDATE on audit_log as cpa_app must fail (append-only REVOKE in 0035)',
  );
});

test('migration 0035: audit_log DELETE rejected as cpa_app (append-only enforcement)', async () => {
  // Reuse the AUDIT_LOG_C1_ID row seeded by the UPDATE test above.
  // node:test runs tests in file order within a single file, so by
  // the time this test runs the seed is in place. (Cleanup() drops it
  // in after() — irrelevant here since after() runs once at suite end.)
  // If the previous test's seed somehow didn't land we re-seed
  // idempotently via ON CONFLICT DO NOTHING.
  await privilegedSql`
    INSERT INTO audit_log (id, firm_id, kind, payload, actor_user_id)
    VALUES (
      ${AUDIT_LOG_C1_ID}, ${TENANT_C_ID}, 'P6H_TEST_KIND',
      ${JSON.stringify({ note: 'p6h follow-up audit_log row' })}::text::jsonb,
      ${USER_C_ID}
    )
    ON CONFLICT (id) DO NOTHING
  `;

  await assert.rejects(
    () =>
      sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${TENANT_C_ID}, true)`;
        await tx`SELECT set_config('app.current_firm_id', ${TENANT_C_ID}, true)`;
        await tx`DELETE FROM audit_log WHERE id = ${AUDIT_LOG_C1_ID}`;
      }),
    /permission denied/i,
    'DELETE on audit_log as cpa_app must fail (append-only REVOKE in 0035)',
  );

  // Confirm the row is still there — REVOKE worked, the row survived.
  const stillThere = await privilegedSql<{ id: string }[]>`
    SELECT id FROM audit_log WHERE id = ${AUDIT_LOG_C1_ID}
  `;
  assert.equal(stillThere.length, 1, 'audit_log row must survive the rejected DELETE');
});

// ---------------------------------------------------------------------------
// P6 follow-up — migration 0036: partial unique index on
// (tenant_id, payload->>'proposed_id') WHERE kind='ACTIVITY_CREATED' AND
// payload->>'proposed_id' IS NOT NULL.
//
// The Agent B accept endpoint (Theme 4) pre-loads existing
// ACTIVITY_CREATED-with-proposed_id rows once per request, then inserts.
// Two concurrent requests for the same proposed_id both pre-load empty
// and both try to insert — only frontend serialization saves us today.
// The partial unique index closes the race structurally: the second
// concurrent INSERT fails with sqlstate 23505, which the route handler
// can catch and treat as idempotent.
//
// Tests use insertEventWithChain (the canonical insert path for `event`)
// rather than raw INSERTs, so they exercise the same code path the
// production accept endpoint uses. event.captured_at differs per insert
// to avoid `event_hash_unique` collisions (canonicaliseEvent includes
// captured_at, so different timestamps → different hashes).
// ---------------------------------------------------------------------------

test('migration 0036: duplicate (tenant_id, proposed_id) ACTIVITY_CREATED rejected by partial unique index', async () => {
  // First insert succeeds.
  await insertEventWithChain({
    tenant_id: TENANT_C_ID,
    subject_tenant_id: SUBJECT_C_ID,
    kind: 'ACTIVITY_CREATED',
    payload: { _v: 1, proposed_id: 'p1', activity_code: 'CA-01' },
    classification: null,
    captured_at: new Date('2026-05-01T10:00:00Z'),
    captured_by_user_id: USER_C_ID,
    captured_by_employee_id: null,
    override_of_event_id: null,
    override_new_kind: null,
    override_reason: null,
  });

  // Second insert for SAME tenant + SAME proposed_id must fail. We use a
  // different captured_at so the hash differs (otherwise event_hash_unique
  // would fire first — we want to prove the PARTIAL UNIQUE INDEX is what
  // rejects this insert, not the hash uniqueness).
  await assert.rejects(
    () =>
      insertEventWithChain({
        tenant_id: TENANT_C_ID,
        subject_tenant_id: SUBJECT_C_ID,
        kind: 'ACTIVITY_CREATED',
        payload: { _v: 1, proposed_id: 'p1', activity_code: 'CA-02' },
        classification: null,
        captured_at: new Date('2026-05-01T10:01:00Z'),
        captured_by_user_id: USER_C_ID,
        captured_by_employee_id: null,
        override_of_event_id: null,
        override_new_kind: null,
        override_reason: null,
      }),
    (err: Error) => {
      // The partial unique index is named
      // event_activity_created_proposed_id_unique. Postgres surfaces
      // either the index name or "duplicate key" in the message; match
      // either to be implementation-tolerant.
      return /event_activity_created_proposed_id_unique|duplicate key|unique/i.test(err.message);
    },
    'second ACTIVITY_CREATED with same (tenant_id, proposed_id) must be rejected by partial unique index',
  );
});

test('migration 0036: ACTIVITY_CREATED with NULL proposed_id is NOT subject to the index', async () => {
  // Manually-created activities (P4 POST /v1/activities) emit
  // ACTIVITY_CREATED with no proposed_id field. The partial index's
  // WHERE clause filters those out — so two such events for the same
  // tenant must both succeed.
  await insertEventWithChain({
    tenant_id: TENANT_C_ID,
    subject_tenant_id: SUBJECT_C_ID,
    kind: 'ACTIVITY_CREATED',
    // No proposed_id field at all (the manually-created path).
    payload: { _v: 1, activity_code: 'CA-MANUAL-A' },
    classification: null,
    captured_at: new Date('2026-05-01T10:02:00Z'),
    captured_by_user_id: USER_C_ID,
    captured_by_employee_id: null,
    override_of_event_id: null,
    override_new_kind: null,
    override_reason: null,
  });

  await insertEventWithChain({
    tenant_id: TENANT_C_ID,
    subject_tenant_id: SUBJECT_C_ID,
    kind: 'ACTIVITY_CREATED',
    payload: { _v: 1, activity_code: 'CA-MANUAL-B' },
    classification: null,
    captured_at: new Date('2026-05-01T10:03:00Z'),
    captured_by_user_id: USER_C_ID,
    captured_by_employee_id: null,
    override_of_event_id: null,
    override_new_kind: null,
    override_reason: null,
  });

  // Both should be present.
  const rows = await privilegedSql<{ id: string }[]>`
    SELECT id FROM event
     WHERE tenant_id = ${TENANT_C_ID}
       AND kind = 'ACTIVITY_CREATED'
       AND payload->>'proposed_id' IS NULL
  `;
  assert.equal(
    rows.length,
    2,
    'two ACTIVITY_CREATED events with no proposed_id must coexist (partial index excludes NULLs)',
  );
});

test('migration 0036: same proposed_id but DIFFERENT tenant_id is allowed', async () => {
  // Cross-tenant uniqueness probe: each firm's drafts mint
  // proposed_ids independently, so 'p1' from TENANT_C and 'p1' from
  // TENANT_D must not collide.
  //
  // TENANT_C already has an ACTIVITY_CREATED with proposed_id='p1'
  // from the first test in this group (migration 0036 test 1). We
  // insert one for TENANT_D with the same proposed_id and assert it
  // succeeds.
  await insertEventWithChain({
    tenant_id: TENANT_D_ID,
    subject_tenant_id: SUBJECT_D_ID,
    kind: 'ACTIVITY_CREATED',
    payload: { _v: 1, proposed_id: 'p1', activity_code: 'CD-01' },
    classification: null,
    captured_at: new Date('2026-05-01T10:04:00Z'),
    captured_by_user_id: USER_D_ID,
    captured_by_employee_id: null,
    override_of_event_id: null,
    override_new_kind: null,
    override_reason: null,
  });

  // Both tenants' rows must be present.
  const rows = await privilegedSql<{ tenant_id: string }[]>`
    SELECT tenant_id FROM event
     WHERE tenant_id IN (${TENANT_C_ID}, ${TENANT_D_ID})
       AND kind = 'ACTIVITY_CREATED'
       AND payload->>'proposed_id' = 'p1'
  `;
  const tenants = rows.map((r) => r.tenant_id).sort();
  assert.deepEqual(
    tenants,
    [TENANT_C_ID, TENANT_D_ID].sort(),
    'both tenants must keep their ACTIVITY_CREATED proposed_id=p1 row (index is tenant-scoped)',
  );
});

test('migration 0036: other event kinds with the same payload key are NOT indexed', async () => {
  // The partial index's WHERE clause filters to kind='ACTIVITY_CREATED'
  // only. Other kinds with a `proposed_id` field in payload (synthetic
  // — HYPOTHESIS payload doesn't normally carry one) must NOT be
  // affected. Two HYPOTHESIS events with the same (tenant_id,
  // proposed_id) must both succeed.
  await insertEventWithChain({
    tenant_id: TENANT_C_ID,
    subject_tenant_id: SUBJECT_C_ID,
    kind: 'HYPOTHESIS',
    // Synthetic — payload would normally have hypothesis-shape; we
    // only need the proposed_id key to prove the index ignores
    // non-ACTIVITY_CREATED kinds.
    payload: { _v: 1, proposed_id: 'p1', text: 'first hypothesis' },
    classification: null,
    captured_at: new Date('2026-05-01T10:05:00Z'),
    captured_by_user_id: USER_C_ID,
    captured_by_employee_id: null,
    override_of_event_id: null,
    override_new_kind: null,
    override_reason: null,
  });

  await insertEventWithChain({
    tenant_id: TENANT_C_ID,
    subject_tenant_id: SUBJECT_C_ID,
    kind: 'HYPOTHESIS',
    payload: { _v: 1, proposed_id: 'p1', text: 'second hypothesis' },
    classification: null,
    captured_at: new Date('2026-05-01T10:06:00Z'),
    captured_by_user_id: USER_C_ID,
    captured_by_employee_id: null,
    override_of_event_id: null,
    override_new_kind: null,
    override_reason: null,
  });

  const rows = await privilegedSql<{ id: string }[]>`
    SELECT id FROM event
     WHERE tenant_id = ${TENANT_C_ID}
       AND kind = 'HYPOTHESIS'
       AND payload->>'proposed_id' = 'p1'
  `;
  assert.equal(
    rows.length,
    2,
    'two HYPOTHESIS events with same (tenant_id, proposed_id) must coexist (partial index filters by kind)',
  );
});
