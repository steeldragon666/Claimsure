import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { signSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../app.js';

/**
 * P5 Theme 5 Task 5.4 — apply-rules writer endpoints.
 *
 * Tests run against real Postgres + RLS (same harness as B9/B10).
 * Fixtures pin a `b14` segment in their UUIDs so a partial run leaves
 * no stale rows that perturb other suites; `cleanup()` runs in both
 * `before` and `after` so the seed is idempotent across reruns.
 *
 * Coverage matrix (12+ tests per plan lines 555-562):
 *   - 401 (unauth) / 403 (viewer write blocked) / 404 (cross-firm + unknown id)
 *   - 200 happy: 1 expenditure + 1 matching rule → 1 EXPENDITURE_MAPPED event
 *   - 200 apportion: 1 expenditure + 1 apportion-rule → 1 EXPENDITURE_APPORTIONED event
 *     with allocations sum=100
 *   - 200 flag: 1 expenditure + 1 flag_for_review-rule → skipped, no event
 *   - 200 batch happy: 3 expenditures + 1 rule matching all → 3 events
 *   - 200 batch truncated: BATCH_CAP+1 expenditures → truncated=true,
 *     emits up to BATCH_CAP events
 *   - 500 InvalidRuleError: rule with apportion sum=87 in DB → 500 with
 *     error.name = 'InvalidRuleError'
 *
 * **Cleanup pattern**: events FK to subject_tenant + tenant + user
 * (no CASCADE), so the teardown DELETE order is: event → audit_log →
 * mapping_rule → expenditure_line → expenditure → claim →
 * subject_tenant → tenant_user → user → tenant. The chain rows live
 * under `subject_tenant_id`, so we delete by that join scope.
 */

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

const TENANT_A = '00000000-0000-4000-8000-0000000b1401';
const TENANT_B = '00000000-0000-4000-8000-0000000b1402';
const ADMIN_USER = '00000000-0000-4000-8000-0000000b1410';
const VIEWER_USER = '00000000-0000-4000-8000-0000000b1411';
const CONSULTANT_USER = '00000000-0000-4000-8000-0000000b1412';
const SUBJECT_A = '00000000-0000-4000-8000-0000000b1421';
const SUBJECT_B = '00000000-0000-4000-8000-0000000b1422';
// Firm A claim — fiscal_year 2025 covers 2024-07-01..2025-06-30.
const CLAIM_A = '00000000-0000-4000-8000-0000000b1441';
const CLAIM_B = '00000000-0000-4000-8000-0000000b1442';
// Firm A expenditures spanning the FY window. EXP_ACME_INVOICE matches
// an Acme rule (map_to_activity), EXP_LAB_BANK matches an apportion
// rule, EXP_OFFICE_BANK matches the catch-all flag rule, EXP_FIRM_B
// is the cross-firm positive control.
const EXP_ACME_INVOICE = '00000000-0000-4000-8000-0000000b1431';
const EXP_LAB_BANK = '00000000-0000-4000-8000-0000000b1432';
const EXP_OFFICE_BANK = '00000000-0000-4000-8000-0000000b1433';
const EXP_FIRM_B = '00000000-0000-4000-8000-0000000b1434';
// Mapping rules.
const RULE_ACME = '00000000-0000-4000-8000-0000000b1451';
const RULE_LAB_APPORTION = '00000000-0000-4000-8000-0000000b1452';
const RULE_FLAG = '00000000-0000-4000-8000-0000000b1453';
const RULE_FIRM_B = '00000000-0000-4000-8000-0000000b1454';
// Activity ids referenced in actions.
const ACTIVITY_X = '00000000-0000-4000-8000-0000000b1491';
const ACTIVITY_Y = '00000000-0000-4000-8000-0000000b1492';
const ACTIVITY_Z = '00000000-0000-4000-8000-0000000b1493';

const cleanup = async (): Promise<void> => {
  // Order matters — chain events FK subject_tenant + tenant + user.
  // Clear chain rows first via privilegedSql (RLS-bypass — chain reads
  // already scope by subject_tenant_id).
  await privilegedSql`DELETE FROM event WHERE subject_tenant_id IN (${SUBJECT_A}, ${SUBJECT_B})`;
  await privilegedSql`DELETE FROM audit_log WHERE firm_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM expenditure_line WHERE expenditure_id IN (
    ${EXP_ACME_INVOICE}, ${EXP_LAB_BANK}, ${EXP_OFFICE_BANK}, ${EXP_FIRM_B}
  )`;
  await privilegedSql`DELETE FROM expenditure WHERE id IN (
    ${EXP_ACME_INVOICE}, ${EXP_LAB_BANK}, ${EXP_OFFICE_BANK}, ${EXP_FIRM_B}
  )`;
  await privilegedSql`DELETE FROM claim WHERE id IN (${CLAIM_A}, ${CLAIM_B})`;
  await privilegedSql`DELETE FROM mapping_rule WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM subject_tenant WHERE id IN (${SUBJECT_A}, ${SUBJECT_B})`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await sql`DELETE FROM "user" WHERE id IN (${ADMIN_USER}, ${VIEWER_USER}, ${CONSULTANT_USER})`;
  await sql`DELETE FROM tenant WHERE id IN (${TENANT_A}, ${TENANT_B})`;
};

before(async () => {
  await cleanup();
  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT_A}, 'Firm A B14', 'firm-a-b14', 'mixed'),
                   (${TENANT_B}, 'Firm B B14', 'firm-b-b14', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${ADMIN_USER}, 'b14-admin@example.com', 'microsoft', 'microsoft:b14-admin', 'B14 Admin'),
                   (${VIEWER_USER}, 'b14-viewer@example.com', 'microsoft', 'microsoft:b14-viewer', 'B14 Viewer'),
                   (${CONSULTANT_USER}, 'b14-cons@example.com', 'microsoft', 'microsoft:b14-cons', 'B14 Consultant')`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT_A}, ${ADMIN_USER}, 'admin', true),
                              (gen_random_uuid(), ${TENANT_A}, ${VIEWER_USER}, 'viewer', true),
                              (gen_random_uuid(), ${TENANT_A}, ${CONSULTANT_USER}, 'consultant', true)`;
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                       VALUES (${SUBJECT_A}, ${TENANT_A}, 'Acme R&D B14', 'claimant'),
                              (${SUBJECT_B}, ${TENANT_B}, 'Other Corp B14', 'claimant')`;

  // Claims first — expenditure.claim_id references claim(id).
  await privilegedSql`
    INSERT INTO claim (
      id, tenant_id, subject_tenant_id, fiscal_year, stage
    ) VALUES
    (${CLAIM_A}, ${TENANT_A}, ${SUBJECT_A}, 2025, 'engagement'),
    (${CLAIM_B}, ${TENANT_B}, ${SUBJECT_B}, 2025, 'engagement')
  `;

  // Expenditures: three firm-A + one firm-B (cross-firm positive control).
  // expenditure_date all within FY2025 (2024-07-01..2025-06-30).
  await privilegedSql`
    INSERT INTO expenditure (
      id, tenant_id, subject_tenant_id, claim_id, source, source_external_id,
      vendor_name, reference, expenditure_date, total_amount, currency,
      raw_payload, voided_at
    ) VALUES
    (${EXP_ACME_INVOICE}, ${TENANT_A}, ${SUBJECT_A}, ${CLAIM_A}, 'xero_invoice', 'inv-1',
     'Acme Industries', 'INV-001', '2024-08-15'::date, '1500.00', 'AUD',
     '{}'::jsonb, NULL),
    (${EXP_LAB_BANK}, ${TENANT_A}, ${SUBJECT_A}, ${CLAIM_A}, 'xero_bank_tx', 'bt-2',
     'LabCo', 'BT-002', '2024-09-12'::date, '900.00', 'AUD',
     '{}'::jsonb, NULL),
    (${EXP_OFFICE_BANK}, ${TENANT_A}, ${SUBJECT_A}, ${CLAIM_A}, 'xero_bank_tx', 'bt-3',
     'Officeworks', 'BT-003', '2024-10-04'::date, '120.00', 'AUD',
     '{}'::jsonb, NULL),
    (${EXP_FIRM_B}, ${TENANT_B}, ${SUBJECT_B}, ${CLAIM_B}, 'xero_invoice', 'inv-fb',
     'Firm B Vendor', 'FB-001', '2024-08-15'::date, '500.00', 'AUD',
     '{}'::jsonb, NULL)
  `;

  // Lines (one per expenditure for deterministic account_code/description).
  await privilegedSql`
    INSERT INTO expenditure_line (id, expenditure_id, description, account_code, amount)
    VALUES
    (gen_random_uuid(), ${EXP_ACME_INVOICE}, 'R&D consulting Q1', '400', '1500.00'),
    (gen_random_uuid(), ${EXP_LAB_BANK}, 'Lab supplies', '410', '900.00'),
    (gen_random_uuid(), ${EXP_OFFICE_BANK}, 'Stationery', '404', '120.00'),
    (gen_random_uuid(), ${EXP_FIRM_B}, 'Firm B work', '400', '500.00')
  `;

  // Rules:
  //   RULE_ACME       (priority 10)  — contact contains "Acme" → map_to_activity ACTIVITY_X
  //   RULE_LAB_APPORTION (priority 20) — contact contains "LabCo" → apportion 60/40
  //   RULE_FLAG       (priority 100) — empty conditions (catch-all) → flag_for_review
  //   RULE_FIRM_B     (cross-firm)   — must NOT see firm-A expenditures
  await privilegedSql`
    INSERT INTO mapping_rule (
      tenant_id, id, name, priority, enabled, conditions, action, created_by_user_id
    ) VALUES
    (${TENANT_A}, ${RULE_ACME}, 'Acme map', 10, true,
     ${[{ field: 'contact_name', op: 'contains', value: 'Acme', case_insensitive: true }]},
     ${{ type: 'map_to_activity', activity_id: ACTIVITY_X }},
     ${ADMIN_USER}),
    (${TENANT_A}, ${RULE_LAB_APPORTION}, 'Lab apportion', 20, true,
     ${[{ field: 'contact_name', op: 'contains', value: 'LabCo', case_insensitive: true }]},
     ${{
       type: 'apportion',
       allocations: [
         { activity_id: ACTIVITY_Y, percentage: 60 },
         { activity_id: ACTIVITY_Z, percentage: 40 },
       ],
     }},
     ${ADMIN_USER}),
    (${TENANT_A}, ${RULE_FLAG}, 'Catch-all flag', 100, true,
     ${[]},
     ${{ type: 'flag_for_review', reason: 'unmatched' }},
     ${ADMIN_USER}),
    (${TENANT_B}, ${RULE_FIRM_B}, 'Firm B rule', 10, true,
     ${[]},
     ${{ type: 'flag_for_review', reason: 'firm B' }},
     ${ADMIN_USER})
  `;
});

after(async () => {
  await cleanup();
  await sql.end();
  await privilegedSql.end();
});

const jwtFor = (
  userId: string,
  email: string,
  role: 'admin' | 'consultant' | 'viewer',
): Promise<string> =>
  signSession(
    {
      sub: userId,
      email,
      primaryIdp: 'microsoft',
      activeTenantId: TENANT_A,
      activeRole: role,
      availableTenants: [],
    },
    SESSION_SECRET,
    { ttlSeconds: 3600 },
  );

const adminJwt = (): Promise<string> => jwtFor(ADMIN_USER, 'b14-admin@example.com', 'admin');
const viewerJwt = (): Promise<string> => jwtFor(VIEWER_USER, 'b14-viewer@example.com', 'viewer');
const consultantJwt = (): Promise<string> =>
  jwtFor(CONSULTANT_USER, 'b14-cons@example.com', 'consultant');

// Helpers to count chain events for a subject_tenant — used by happy
// paths to confirm the correct number of events landed.
const countEventsForSubject = async (subjectId: string): Promise<number> => {
  const rows = await privilegedSql<{ total: string }[]>`
    SELECT COUNT(*)::text AS total FROM event WHERE subject_tenant_id = ${subjectId}
  `;
  return parseInt(rows[0]?.total ?? '0', 10);
};

// Clear chain rows between tests so each one starts from a clean
// `event_count = 0`. The cleanup() at suite teardown handles the
// final wipe; this per-test wipe keeps the assertions simple.
const clearChain = async (): Promise<void> => {
  await privilegedSql`DELETE FROM event WHERE subject_tenant_id IN (${SUBJECT_A}, ${SUBJECT_B})`;
};

// ---------------------------------------------------------------------------
// POST /v1/expenditures/:id/apply-rules — single
// ---------------------------------------------------------------------------

test('POST /v1/expenditures/:id/apply-rules: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/expenditures/${EXP_ACME_INVOICE}/apply-rules`,
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /v1/expenditures/:id/apply-rules: 403 for viewer (write blocked)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/expenditures/${EXP_ACME_INVOICE}/apply-rules`,
    cookies: { cpa_session: await viewerJwt() },
  });
  assert.equal(res.statusCode, 403);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'forbidden');
  await app.close();
});

test('POST /v1/expenditures/:id/apply-rules: 404 for cross-firm expenditure', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/expenditures/${EXP_FIRM_B}/apply-rules`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 404);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'expenditure_not_found');
  await app.close();
});

test('POST /v1/expenditures/:id/apply-rules: 404 for nonexistent id', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/expenditures/00000000-0000-4000-8000-000000abcdef/apply-rules',
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('POST /v1/expenditures/:id/apply-rules: happy path emits EXPENDITURE_MAPPED', async () => {
  await clearChain();
  // Acme invoice → matches RULE_ACME (map_to_activity) + RULE_FLAG
  // (catch-all flag). One chain event written (MAPPED), one skipped.
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/expenditures/${EXP_ACME_INVOICE}/apply-rules`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    matched: number;
    emitted: Array<{ kind: string; event_id: string }>;
    skipped: Array<{ rule_id: string; reason: string }>;
  }>();
  assert.equal(body.matched, 2);
  assert.equal(body.emitted.length, 1);
  assert.equal(body.emitted[0]!.kind, 'EXPENDITURE_MAPPED');
  assert.match(body.emitted[0]!.event_id, /^[0-9a-f-]{36}$/);
  assert.equal(body.skipped.length, 1);
  assert.equal(body.skipped[0]!.rule_id, RULE_FLAG);
  // Confirm chain row landed.
  assert.equal(await countEventsForSubject(SUBJECT_A), 1);
  // Inspect the row payload.
  const rows = await privilegedSql<{ kind: string; payload: Record<string, unknown> }[]>`
    SELECT kind, payload FROM event WHERE subject_tenant_id = ${SUBJECT_A}
  `;
  assert.equal(rows[0]!.kind, 'EXPENDITURE_MAPPED');
  assert.equal(rows[0]!.payload['_v'], 1);
  assert.equal(rows[0]!.payload['expenditure_id'], EXP_ACME_INVOICE);
  assert.equal(rows[0]!.payload['claim_id'], CLAIM_A);
  assert.equal(rows[0]!.payload['activity_id'], ACTIVITY_X);
  assert.equal(rows[0]!.payload['rule_id'], RULE_ACME);
  await app.close();
});

test('POST /v1/expenditures/:id/apply-rules: apportion path emits EXPENDITURE_APPORTIONED', async () => {
  await clearChain();
  // LabCo bank tx → matches RULE_LAB_APPORTION (apportion) + RULE_FLAG.
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/expenditures/${EXP_LAB_BANK}/apply-rules`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    matched: number;
    emitted: Array<{ kind: string; event_id: string }>;
    skipped: Array<{ rule_id: string; reason: string }>;
  }>();
  assert.equal(body.matched, 2);
  assert.equal(body.emitted.length, 1);
  assert.equal(body.emitted[0]!.kind, 'EXPENDITURE_APPORTIONED');
  assert.equal(body.skipped.length, 1);
  // Verify the persisted payload's allocations sum to 100.
  const rows = await privilegedSql<{ payload: Record<string, unknown> }[]>`
    SELECT payload FROM event
     WHERE subject_tenant_id = ${SUBJECT_A} AND kind = 'EXPENDITURE_APPORTIONED'
  `;
  assert.equal(rows.length, 1);
  const allocations = rows[0]!.payload['allocations'] as Array<{
    activity_id: string;
    percentage: number;
  }>;
  assert.equal(allocations.length, 2);
  const sum = allocations.reduce((s, a) => s + a.percentage, 0);
  assert.ok(Math.abs(sum - 100) <= 0.001, `apportion allocations must sum to 100; got ${sum}`);
  await app.close();
});

test('POST /v1/expenditures/:id/apply-rules: flag-only rule writes nothing to chain', async () => {
  await clearChain();
  // Officeworks bank tx — only RULE_FLAG matches (empty conditions).
  // No chain event should land; one skipped entry.
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/expenditures/${EXP_OFFICE_BANK}/apply-rules`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    matched: number;
    emitted: Array<unknown>;
    skipped: Array<{ rule_id: string; reason: string }>;
  }>();
  assert.equal(body.matched, 1);
  assert.equal(body.emitted.length, 0);
  assert.equal(body.skipped.length, 1);
  assert.equal(body.skipped[0]!.rule_id, RULE_FLAG);
  assert.equal(body.skipped[0]!.reason, 'unmatched');
  assert.equal(await countEventsForSubject(SUBJECT_A), 0);
  await app.close();
});

test('POST /v1/expenditures/:id/apply-rules: cross-firm rule never appears in firm-A response', async () => {
  await clearChain();
  // Positive control: the firm-B rule (priority 10) must not be visible.
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/expenditures/${EXP_OFFICE_BANK}/apply-rules`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ skipped: Array<{ rule_id: string }> }>();
  assert.ok(!body.skipped.some((s) => s.rule_id === RULE_FIRM_B));
  await app.close();
});

// ---------------------------------------------------------------------------
// POST /v1/claims/:id/apply-rules — batch
// ---------------------------------------------------------------------------

test('POST /v1/claims/:id/apply-rules: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_A}/apply-rules`,
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /v1/claims/:id/apply-rules: 403 for viewer', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_A}/apply-rules`,
    cookies: { cpa_session: await viewerJwt() },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('POST /v1/claims/:id/apply-rules: 404 for cross-firm claim', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_B}/apply-rules`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 404);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'claim_not_found');
  await app.close();
});

test('POST /v1/claims/:id/apply-rules: batch happy path emits multiple events', async () => {
  await clearChain();
  // Claim A has 3 non-voided expenditures within FY2025:
  //   - Acme invoice  → matches RULE_ACME (MAPPED) + RULE_FLAG
  //   - LabCo bank tx → matches RULE_LAB_APPORTION (APPORTIONED) + RULE_FLAG
  //   - Officeworks   → matches RULE_FLAG only
  // Expected: 2 chain events written (1 MAPPED + 1 APPORTIONED),
  // 3 skipped (one per expenditure that hits RULE_FLAG).
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_A}/apply-rules`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    expenditures: Array<{
      expenditure_id: string;
      matched: number;
      emitted: Array<{ kind: string }>;
      skipped: Array<{ rule_id: string }>;
    }>;
    summary: {
      total_expenditures: number;
      total_matched: number;
      total_emitted: number;
      total_skipped: number;
    };
    truncated: boolean;
  }>();
  assert.equal(body.summary.total_expenditures, 3);
  assert.equal(body.summary.total_emitted, 2);
  assert.equal(body.summary.total_skipped, 3);
  assert.equal(body.truncated, false);

  const acme = body.expenditures.find((e) => e.expenditure_id === EXP_ACME_INVOICE);
  assert.ok(acme);
  assert.equal(acme.emitted.length, 1);
  assert.equal(acme.emitted[0]!.kind, 'EXPENDITURE_MAPPED');

  const lab = body.expenditures.find((e) => e.expenditure_id === EXP_LAB_BANK);
  assert.ok(lab);
  assert.equal(lab.emitted.length, 1);
  assert.equal(lab.emitted[0]!.kind, 'EXPENDITURE_APPORTIONED');

  const office = body.expenditures.find((e) => e.expenditure_id === EXP_OFFICE_BANK);
  assert.ok(office);
  assert.equal(office.emitted.length, 0);

  // Verify the chain landed two events.
  assert.equal(await countEventsForSubject(SUBJECT_A), 2);
  await app.close();
});

test('POST /v1/claims/:id/apply-rules: 404 for unknown id', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/claims/00000000-0000-4000-8000-000000abcdef/apply-rules',
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

// ---------------------------------------------------------------------------
// Engine error surfacing — InvalidRuleError throws from B8's eager
// action validator. The route does NOT catch + reshape; it lets the
// global error handler emit `error: e.name` at 500.
// ---------------------------------------------------------------------------

test('POST /v1/expenditures/:id/apply-rules: InvalidRuleError from engine surfaces as 500', async () => {
  await clearChain();
  // Insert an apportion rule whose percentages sum to 87 (not 100).
  // The Zod schema accepts each allocation (positive finite number)
  // and the DB has no CHECK on the JSONB shape, so this slips past
  // every layer except B8's eager validator inside `applyRules`.
  // Priority 1 so it sorts BEFORE everything else and triggers
  // immediately on the Acme invoice.
  const RULE_BAD_APPORTION = '00000000-0000-4000-8000-0000000b1461';
  await privilegedSql`
    INSERT INTO mapping_rule (
      tenant_id, id, name, priority, enabled, conditions, action, created_by_user_id
    ) VALUES (
      ${TENANT_A}, ${RULE_BAD_APPORTION}, 'Bad apportion (sum 87)', 1, true,
      ${[]},
      ${{
        type: 'apportion',
        allocations: [
          { activity_id: ACTIVITY_X, percentage: 50 },
          { activity_id: ACTIVITY_Y, percentage: 37 }, // sum = 87, invalid
        ],
      }},
      ${ADMIN_USER}
    )
  `;
  try {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/expenditures/${EXP_ACME_INVOICE}/apply-rules`,
      cookies: { cpa_session: await adminJwt() },
    });
    assert.equal(res.statusCode, 500);
    const body = res.json<{ error: string; message: string }>();
    assert.equal(body.error, 'InvalidRuleError');
    assert.match(body.message, /apportion percentages must sum to 100/i);
    // Confirm no chain row landed when the engine rejects.
    assert.equal(await countEventsForSubject(SUBJECT_A), 0);
    await app.close();
  } finally {
    await privilegedSql`DELETE FROM mapping_rule WHERE id = ${RULE_BAD_APPORTION}`;
  }
});

// ---------------------------------------------------------------------------
// Cap-and-flag — the batch endpoint hard-caps at BATCH_CAP=500. When
// the underlying claim has more, the response carries `truncated: true`
// and processes the first BATCH_CAP rows. This test seeds BATCH_CAP+1
// rows via a single bulk INSERT (`generate_series`), runs the endpoint
// against a FLAG-ONLY rule set (so no chain writes are needed — the
// matching rule just emits skipped entries), and confirms truncated
// surfaces correctly. A flag-only rule keeps the test cheap (no
// per-row chain write loop).
// ---------------------------------------------------------------------------

test('POST /v1/claims/:id/apply-rules: cap-and-flag emits truncated=true at BATCH_CAP+1 expenditures', async () => {
  const BATCH_CAP = 500;
  const TENANT_BATCH = '00000000-0000-4000-8000-0000000b1403';
  const ADMIN_BATCH = '00000000-0000-4000-8000-0000000b1413';
  const SUBJECT_BATCH = '00000000-0000-4000-8000-0000000b1423';
  const CLAIM_BATCH = '00000000-0000-4000-8000-0000000b1443';
  const RULE_BATCH_FLAG = '00000000-0000-4000-8000-0000000b1463';

  // Cleanup any leftovers from a partial previous run.
  await privilegedSql`DELETE FROM event WHERE subject_tenant_id = ${SUBJECT_BATCH}`;
  await privilegedSql`DELETE FROM expenditure_line
                       WHERE expenditure_id IN (
                         SELECT id FROM expenditure WHERE tenant_id = ${TENANT_BATCH}
                       )`;
  await privilegedSql`DELETE FROM expenditure WHERE tenant_id = ${TENANT_BATCH}`;
  await privilegedSql`DELETE FROM claim WHERE id = ${CLAIM_BATCH}`;
  await privilegedSql`DELETE FROM mapping_rule WHERE tenant_id = ${TENANT_BATCH}`;
  await privilegedSql`DELETE FROM subject_tenant WHERE id = ${SUBJECT_BATCH}`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id = ${TENANT_BATCH}`;
  await sql`DELETE FROM "user" WHERE id = ${ADMIN_BATCH}`;
  await sql`DELETE FROM tenant WHERE id = ${TENANT_BATCH}`;

  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT_BATCH}, 'Firm Batch B14', 'firm-batch-b14', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${ADMIN_BATCH}, 'b14-batch-admin@example.com', 'microsoft',
                    'microsoft:b14-batch-admin', 'B14 Batch Admin')`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT_BATCH}, ${ADMIN_BATCH}, 'admin', true)`;
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                       VALUES (${SUBJECT_BATCH}, ${TENANT_BATCH}, 'Batch Subject B14', 'claimant')`;
  await privilegedSql`INSERT INTO claim (id, tenant_id, subject_tenant_id, fiscal_year, stage)
                       VALUES (${CLAIM_BATCH}, ${TENANT_BATCH}, ${SUBJECT_BATCH}, 2025, 'engagement')`;
  // Flag-only rule so the batch doesn't trigger BATCH_CAP chain writes
  // (each insertEventWithChain takes a per-subject lock — running 500
  // of them serialised through one connection would slow the test
  // unnecessarily). The flag rule still gives us a meaningful "matched"
  // count and a truncated=true assertion.
  await privilegedSql`
    INSERT INTO mapping_rule (
      tenant_id, id, name, priority, enabled, conditions, action, created_by_user_id
    ) VALUES (
      ${TENANT_BATCH}, ${RULE_BATCH_FLAG}, 'Batch flag', 10, true,
      ${[]},
      ${{ type: 'flag_for_review', reason: 'batch flag' }},
      ${ADMIN_BATCH}
    )
  `;

  // Bulk-insert BATCH_CAP+1 expenditures via generate_series.
  await privilegedSql`
    INSERT INTO expenditure (
      id, tenant_id, subject_tenant_id, claim_id, source, source_external_id,
      vendor_name, reference, expenditure_date, total_amount, currency,
      raw_payload, voided_at
    )
    SELECT
      gen_random_uuid(),
      ${TENANT_BATCH},
      ${SUBJECT_BATCH},
      ${CLAIM_BATCH},
      'xero_invoice',
      'inv-batch-' || s,
      'Batch Vendor',
      'BATCH-' || s,
      ('2024-07-01'::date + ((s % 365) || ' days')::interval)::date,
      '100.00',
      'AUD',
      '{}'::jsonb,
      NULL
    FROM generate_series(1, ${BATCH_CAP + 1}) AS s
  `;

  try {
    const tenantBatchJwt = await signSession(
      {
        sub: ADMIN_BATCH,
        email: 'b14-batch-admin@example.com',
        primaryIdp: 'microsoft',
        activeTenantId: TENANT_BATCH,
        activeRole: 'admin',
        availableTenants: [],
      },
      SESSION_SECRET,
      { ttlSeconds: 3600 },
    );

    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/claims/${CLAIM_BATCH}/apply-rules`,
      cookies: { cpa_session: tenantBatchJwt },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{
      expenditures: unknown[];
      summary: { total_expenditures: number };
      truncated: boolean;
    }>();
    assert.equal(body.truncated, true, 'expected truncated=true at BATCH_CAP+1');
    assert.equal(body.expenditures.length, BATCH_CAP);
    assert.equal(body.summary.total_expenditures, BATCH_CAP);
    await app.close();
  } finally {
    await privilegedSql`DELETE FROM event WHERE subject_tenant_id = ${SUBJECT_BATCH}`;
    await privilegedSql`DELETE FROM expenditure WHERE tenant_id = ${TENANT_BATCH}`;
    await privilegedSql`DELETE FROM claim WHERE id = ${CLAIM_BATCH}`;
    await privilegedSql`DELETE FROM mapping_rule WHERE tenant_id = ${TENANT_BATCH}`;
    await privilegedSql`DELETE FROM subject_tenant WHERE id = ${SUBJECT_BATCH}`;
    await privilegedSql`DELETE FROM tenant_user WHERE tenant_id = ${TENANT_BATCH}`;
    await sql`DELETE FROM "user" WHERE id = ${ADMIN_BATCH}`;
    await sql`DELETE FROM tenant WHERE id = ${TENANT_BATCH}`;
  }
});
