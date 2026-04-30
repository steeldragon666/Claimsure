import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { sql, privilegedSql } from '@cpa/db/client';

/**
 * Positive-control RLS tests for the `audit_log` table.
 *
 * NEW PRECEDENT: this is the canonical pattern for asserting that an
 * RLS policy `USING (firm_id = current_setting('app.current_firm_id',
 * true)::uuid)` actually blocks cross-firm reads when the GUC is set
 * to one firm. Prior RLS regressions on tenant-scoped tables (event /
 * subject_tenant / project / claim / activity / expenditure /
 * mapping_rule) all rely on the parallel `app.current_tenant_id` GUC;
 * this file establishes the same "positive-control" idiom for the new
 * firm GUC introduced by P5 Task 2.1.
 *
 * Naming: in this codebase, "firm" = `tenant` (the consultant firm
 * that owns the white-label root). The audit_log table FK references
 * `tenant(id)` and the GUC `app.current_firm_id` carries that same
 * tenant id; the parallel `app.current_tenant_id` is preserved to keep
 * other RLS-protected tables working unchanged.
 *
 * The two assertions below are MANDATORY before Task 2.4 (the writer
 * wiring in mapping-rules.ts) lands — RLS leakage on the audit table
 * would silently expose one firm's mapping-rule lifecycle history to
 * another. See risk register §3 for the GUC-unset assertion rationale.
 */

const FIRM_A = '00000000-0000-4000-8000-0000000a1d01';
const FIRM_B = '00000000-0000-4000-8000-0000000a1d02';
const ADMIN_A = '00000000-0000-4000-8000-0000000a1da1';
const ADMIN_B = '00000000-0000-4000-8000-0000000a1da2';

// kind value for the seeded rows. Any non-empty string passes the
// `audit_log_kind_nonempty` CHECK; we use a deliberately distinctive
// value so the SELECTs below can scope to *just* the rows this test
// inserted (defending against bleed from other parallel suites).
const TEST_KIND = 'TEST_KIND_AUDIT_RLS';

const cleanup = async (): Promise<void> => {
  // Order: child rows first (audit_log → tenant via firm_id FK with ON
  // DELETE CASCADE), then users, then tenants. Even though CASCADE would
  // wipe audit rows when the tenant goes, scoping the DELETE on
  // audit_log to TEST_KIND keeps unrelated rows intact between runs.
  await privilegedSql`DELETE FROM audit_log WHERE kind = ${TEST_KIND}`;
  await privilegedSql`DELETE FROM "user" WHERE id IN (${ADMIN_A}, ${ADMIN_B})`;
  await privilegedSql`DELETE FROM tenant WHERE id IN (${FIRM_A}, ${FIRM_B})`;
};

before(async () => {
  await cleanup();
  // tenant + user are global (no RLS) — direct privileged inserts
  // mirror the rls.test.ts pattern.
  await privilegedSql`
    INSERT INTO tenant (id, name, slug, primary_idp)
    VALUES (${FIRM_A}, 'Firm A audit-rls', 'firm-a-audit-rls', 'mixed'),
           (${FIRM_B}, 'Firm B audit-rls', 'firm-b-audit-rls', 'mixed')
  `;
  await privilegedSql`
    INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
    VALUES (${ADMIN_A}, 'audit-rls-admin-a@example.com', 'microsoft', 'microsoft:audit-rls-admin-a', 'Audit RLS Admin A'),
           (${ADMIN_B}, 'audit-rls-admin-b@example.com', 'microsoft', 'microsoft:audit-rls-admin-b', 'Audit RLS Admin B')
  `;

  // Insert one audit_log row per firm directly via privilegedSql (RLS
  // is bypassed for the migration role, so the WITH CHECK won't trip).
  // Empty object payload satisfies `audit_log_payload_object` CHECK
  // (jsonb_typeof = 'object'). Pass `${{}}` directly — postgres-js
  // auto-encodes; do NOT `JSON.stringify(...)::jsonb` (see
  // artefact-links.test.ts:907-911 for the documented double-encoding
  // bug).
  await privilegedSql`
    INSERT INTO audit_log (firm_id, kind, payload, actor_user_id)
    VALUES (${FIRM_A}, ${TEST_KIND}, ${{}}, ${ADMIN_A}),
           (${FIRM_B}, ${TEST_KIND}, ${{}}, ${ADMIN_B})
  `;
});

after(async () => {
  await cleanup();
  await sql.end();
  await privilegedSql.end();
});

// ---------------------------------------------------------------------------
// Positive-control RLS tests — keystone for P5 Theme 2
// ---------------------------------------------------------------------------

test('audit_log RLS: FIRM_A session cannot read FIRM_B rows', async () => {
  // Open a tx as the application role (cpa_app via `sql`), set the
  // firm GUC to FIRM_A, and read audit_log. The RLS policy uses
  // `current_setting('app.current_firm_id', true)::uuid` so only rows
  // matching FIRM_A are visible.
  const rows = await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_firm_id', ${FIRM_A}, true)`;
    return tx<{ firm_id: string }[]>`
      SELECT firm_id FROM audit_log WHERE kind = ${TEST_KIND}
    `;
  });

  assert.equal(rows.length, 1, 'should see exactly 1 row (FIRM_A only)');
  assert.equal(rows[0]?.firm_id, FIRM_A, 'visible row must belong to FIRM_A');
});

test('audit_log RLS: GUC unset → query returns no rows (fail-safe)', async () => {
  // No set_config — the GUC is unset (or empty after the post-response
  // hook clears it). Migration 0003 wraps current_setting in NULLIF so
  // the empty-string sentinel resolves to NULL, and `firm_id = NULL`
  // never matches → the policy denies the row. This is the fail-safe
  // path called out in risk register §3: GUC plumbing missed in some
  // auth path → silent leak. The fail-safe here is "deny everything".
  const rows = await sql.begin(async (tx) => {
    // Defensive: explicitly clear the GUC to '' inside the same tx
    // before the SELECT. set_config(name, '', true) is the safe
    // sentinel — current_setting('app.current_firm_id', true) returns
    // '' (not NULL), and NULLIF('', '')::uuid → NULL → no match.
    await tx`SELECT set_config('app.current_firm_id', '', true)`;
    return tx<{ firm_id: string }[]>`
      SELECT firm_id FROM audit_log WHERE kind = ${TEST_KIND}
    `;
  });

  assert.equal(rows.length, 0, 'GUC unset must return zero rows (fail-safe)');
});

test('audit_log RLS: privilegedSql bypasses RLS — sanity check', async () => {
  // Sanity: the migration role is the table owner, so its sessions
  // bypass RLS. This is the OPPOSITE of the application path. We rely
  // on this in the seed above — if it ever stops working, the seed
  // breaks first.
  const rows = await privilegedSql<{ firm_id: string }[]>`
    SELECT firm_id FROM audit_log WHERE kind = ${TEST_KIND} ORDER BY firm_id
  `;
  assert.equal(rows.length, 2, 'privilegedSql must see both firm rows');
  assert.equal(rows[0]?.firm_id, FIRM_A);
  assert.equal(rows[1]?.firm_id, FIRM_B);
});
