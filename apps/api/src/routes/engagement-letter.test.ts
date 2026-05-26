import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { sql, privilegedSql } from '@cpa/db/client';

/**
 * Positive-control RLS tests for the `engagement_letter` table
 * (migration 0085, Wizard Step 1).
 *
 * Mirrors the canonical pattern established by `audit-log.test.ts`:
 * seed one row per tenant via the privileged migration role (which
 * bypasses RLS as the table owner), then assert that a session as the
 * application role (`cpa_app`) with the tenant GUC set to TENANT_A
 * sees exactly one row — TENANT_A's — and never TENANT_B's. The
 * security gate is "tenant A session can never read tenant B's
 * engagement_letter rows"; if this leaks the entire feature is a
 * compliance liability (the engagement letter is the legal artefact
 * the claimant signed).
 *
 * Two further controls beyond cross-tenant visibility:
 *   - GUC-unset → zero rows (fail-safe deny path; matches the NULLIF
 *     wrapping in migration 0003).
 *   - privilegedSql still sees both rows (sanity for the seed itself —
 *     if owner-bypass ever stops working, the seed breaks first).
 *
 * Tenant-scoped (not firm-scoped) policy — the GUC is
 * `app.current_tenant_id`, NOT `app.current_firm_id`. The two GUCs
 * carry the same uuid in production but are intentionally separate
 * variables; this table follows the older `tenant_id` convention
 * because the claim it belongs to is tenant-scoped, not firm-scoped.
 *
 * UUID block `0e1` is reserved for this test file's fixtures so a
 * sibling suite seeding parallel rows on the same kind/status cannot
 * collide.
 */

const TENANT_A = '00000000-0000-4000-8000-00000000e1a1';
const TENANT_B = '00000000-0000-4000-8000-00000000e1b1';
const SUBJECT_A = '00000000-0000-4000-8000-00000000e1a2';
const SUBJECT_B = '00000000-0000-4000-8000-00000000e1b2';
const CLAIM_A = '00000000-0000-4000-8000-00000000e1a3';
const CLAIM_B = '00000000-0000-4000-8000-00000000e1b3';
const LETTER_A = '00000000-0000-4000-8000-00000000e1a4';
const LETTER_B = '00000000-0000-4000-8000-00000000e1b4';

const cleanup = async (): Promise<void> => {
  // Order: child rows first. engagement_letter -> claim (CASCADE on
  // claim delete), claim -> subject_tenant + tenant, subject_tenant
  // -> tenant. We DELETE engagement_letter explicitly (rather than
  // relying on CASCADE) so the assertion that this file's rows are
  // gone holds even if a future migration relaxes the FK.
  //
  // engagement_letter and subject_tenant are RLS-protected; use
  // privilegedSql (owner bypass) for cleanup so we don't have to
  // straddle two GUC-scoped transactions.
  await privilegedSql`DELETE FROM engagement_letter WHERE id IN (${LETTER_A}, ${LETTER_B})`;
  await privilegedSql`DELETE FROM claim WHERE id IN (${CLAIM_A}, ${CLAIM_B})`;
  await privilegedSql`DELETE FROM subject_tenant WHERE id IN (${SUBJECT_A}, ${SUBJECT_B})`;
  await privilegedSql`DELETE FROM tenant WHERE id IN (${TENANT_A}, ${TENANT_B})`;
};

before(async () => {
  await cleanup();
  // tenant is global (no RLS) — direct privileged insert.
  await privilegedSql`
    INSERT INTO tenant (id, name, slug, primary_idp)
    VALUES (${TENANT_A}, 'EngLetter Firm A', 'eng-letter-firm-a', 'mixed'),
           (${TENANT_B}, 'EngLetter Firm B', 'eng-letter-firm-b', 'mixed')
  `;
  // subject_tenant + claim are RLS-protected but privilegedSql is the
  // table owner and bypasses RLS, so direct insert works without GUC.
  await privilegedSql`
    INSERT INTO subject_tenant (id, tenant_id, name, kind)
    VALUES (${SUBJECT_A}, ${TENANT_A}, 'EngLetter Claimant A', 'claimant'),
           (${SUBJECT_B}, ${TENANT_B}, 'EngLetter Claimant B', 'claimant')
  `;
  await privilegedSql`
    INSERT INTO claim (id, tenant_id, subject_tenant_id, fiscal_year, stage)
    VALUES (${CLAIM_A}, ${TENANT_A}, ${SUBJECT_A}, 2025, 'engagement'),
           (${CLAIM_B}, ${TENANT_B}, ${SUBJECT_B}, 2025, 'engagement')
  `;
  // One engagement_letter row per tenant — RLS bypassed under the
  // owner role so the WITH CHECK doesn't trip.
  await privilegedSql`
    INSERT INTO engagement_letter (id, tenant_id, claim_id, rendered_markdown, template_version)
    VALUES (${LETTER_A}, ${TENANT_A}, ${CLAIM_A}, 'letter A body', 'v1'),
           (${LETTER_B}, ${TENANT_B}, ${CLAIM_B}, 'letter B body', 'v1')
  `;
});

after(async () => {
  await cleanup();
  await sql.end();
  await privilegedSql.end();
});

// ---------------------------------------------------------------------------
// Positive-control RLS tests — security gate for Wizard Step 1
// ---------------------------------------------------------------------------

test('engagement_letter RLS: TENANT_A session cannot read TENANT_B rows', async () => {
  // Open a tx as the application role (cpa_app via `sql`), set the
  // tenant GUC to TENANT_A, and read engagement_letter. The RLS policy
  // uses `current_setting('app.current_tenant_id', true)::uuid` so
  // only TENANT_A's rows are visible.
  const rows = await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${TENANT_A}, true)`;
    return tx<{ tenant_id: string }[]>`
      SELECT tenant_id FROM engagement_letter
       WHERE id IN (${LETTER_A}, ${LETTER_B})
    `;
  });

  assert.equal(rows.length, 1, 'should see exactly 1 row (TENANT_A only)');
  assert.equal(rows[0]?.tenant_id, TENANT_A, 'visible row must belong to TENANT_A');
});

test('engagement_letter RLS: GUC unset → query returns no rows (fail-safe)', async () => {
  // No set_config — empty GUC. Migration 0085's policy uses the
  // 2-arg `current_setting(..., true)` which returns NULL on unset,
  // and `tenant_id = NULL` is UNKNOWN (treated as false) → policy
  // denies all rows. This is the documented fail-safe path.
  const rows = await sql.begin(async (tx) => {
    // Defensive: explicitly clear the GUC to '' inside the same tx
    // before the SELECT. ''::uuid would error, but the policy here
    // uses the 2-arg current_setting which returns NULL not '' when
    // the GUC was never set. Setting to '' would actually trigger an
    // invalid-uuid cast — so we leave the GUC genuinely unset by
    // performing the SELECT in a fresh tx without any set_config.
    return tx<{ tenant_id: string }[]>`
      SELECT tenant_id FROM engagement_letter
       WHERE id IN (${LETTER_A}, ${LETTER_B})
    `;
  });

  assert.equal(rows.length, 0, 'GUC unset must return zero rows (fail-safe)');
});

test('engagement_letter RLS: privilegedSql bypasses RLS — sanity check', async () => {
  // Sanity: the migration role is the table owner, so its sessions
  // bypass RLS. We rely on this in the seed above — if it ever stops
  // working, the seed breaks first.
  const rows = await privilegedSql<{ tenant_id: string }[]>`
    SELECT tenant_id FROM engagement_letter
     WHERE id IN (${LETTER_A}, ${LETTER_B})
     ORDER BY tenant_id
  `;
  assert.equal(rows.length, 2, 'privilegedSql must see both tenant rows');
  assert.equal(rows[0]?.tenant_id, TENANT_A);
  assert.equal(rows[1]?.tenant_id, TENANT_B);
});

test('engagement_letter RLS: TENANT_A session cannot INSERT under TENANT_B (WITH CHECK)', async () => {
  // Smuggling test: try to insert a row claiming TENANT_B's tenant_id
  // while the session's GUC says TENANT_A. The WITH CHECK clause must
  // reject this. If it succeeded, a tenant could write into another
  // tenant's namespace — same severity class as the read leak.
  let caught: unknown = null;
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${TENANT_A}, true)`;
      await tx`
        INSERT INTO engagement_letter (tenant_id, claim_id, rendered_markdown, template_version)
        VALUES (${TENANT_B}, ${CLAIM_B}, 'smuggled body', 'v1')
      `;
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught !== null, 'cross-tenant INSERT must fail under WITH CHECK');
  assert.match(
    String((caught as Error)?.message ?? caught),
    /row-level security|policy|engagement_letter/i,
    'failure must reference the RLS policy',
  );
});
