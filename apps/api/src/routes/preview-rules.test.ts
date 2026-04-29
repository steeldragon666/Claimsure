import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { signSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../app.js';

/**
 * T-B10 — apply-rules preview endpoints.
 *
 * Tests run against real Postgres + RLS (same harness as B9). Fixtures
 * pin the b10 segment in their UUIDs so a partial run leaves no stale
 * rows that perturb other suites; `cleanup()` runs in both `before`
 * and `after` so the seed is idempotent across reruns.
 *
 * Coverage matrix:
 *   - 401 / 403 / 404 (cross-firm, unknown id)
 *   - Single happy paths: 0 rules, 1 match, 2 matches, disabled rule skipped
 *   - Batch happy paths: claim with 3 expenditures, mixed match/no-match
 *   - The summary counts.
 *   - Engine error surfacing: InvalidRuleError → 500 (raw-SQL inserts a
 *     malformed apportion rule, bypassing B9's write-time validator).
 *   - Cap-and-flag: BATCH_CAP+1 expenditures triggers truncated=true and
 *     limits the response array to BATCH_CAP.
 */

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

const TENANT_A = '00000000-0000-4000-8000-0000000b1001';
const TENANT_B = '00000000-0000-4000-8000-0000000b1002';
const ADMIN_USER = '00000000-0000-4000-8000-0000000b1010';
const VIEWER_USER = '00000000-0000-4000-8000-0000000b1011';
const CONSULTANT_USER = '00000000-0000-4000-8000-0000000b1012';
const SUBJECT_A = '00000000-0000-4000-8000-0000000b1021';
const SUBJECT_B = '00000000-0000-4000-8000-0000000b1022';
// Firm A expenditures: one Acme INVOICE, one non-Acme BANK_TX, one
// soft-voided RECEIPT (must be excluded from batch).
const EXP_ACME_INVOICE = '00000000-0000-4000-8000-0000000b1031';
const EXP_OTHER_BANK = '00000000-0000-4000-8000-0000000b1032';
const EXP_VOIDED = '00000000-0000-4000-8000-0000000b1033';
const EXP_FIRM_B = '00000000-0000-4000-8000-0000000b1034';
// Firm A claim — fiscal_year 2025 covers 2024-07-01..2025-06-30.
const CLAIM_A = '00000000-0000-4000-8000-0000000b1041';
const CLAIM_B = '00000000-0000-4000-8000-0000000b1042';
// Mapping rules. RULE_ACME matches Acme contact; RULE_DISABLED is
// soft-archived; RULE_CATCH_ALL matches every expenditure.
const RULE_ACME = '00000000-0000-4000-8000-0000000b1051';
const RULE_CATCH_ALL = '00000000-0000-4000-8000-0000000b1052';
const RULE_DISABLED = '00000000-0000-4000-8000-0000000b1053';
const RULE_FIRM_B = '00000000-0000-4000-8000-0000000b1054';
// Activity ids referenced in actions. We don't need real activity
// rows because the `mapping_rule.action` jsonb has no FK to activity
// (rules carry their action as opaque jsonb — same as B9 tests).
const ACTIVITY_X = '00000000-0000-4000-8000-0000000b1091';
const ACTIVITY_Y = '00000000-0000-4000-8000-0000000b1092';

const cleanup = async (): Promise<void> => {
  await privilegedSql`DELETE FROM expenditure_line WHERE expenditure_id IN (
    ${EXP_ACME_INVOICE}, ${EXP_OTHER_BANK}, ${EXP_VOIDED}, ${EXP_FIRM_B}
  )`;
  await privilegedSql`DELETE FROM expenditure WHERE id IN (
    ${EXP_ACME_INVOICE}, ${EXP_OTHER_BANK}, ${EXP_VOIDED}, ${EXP_FIRM_B}
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
            VALUES (${TENANT_A}, 'Firm A B10', 'firm-a-b10', 'mixed'),
                   (${TENANT_B}, 'Firm B B10', 'firm-b-b10', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${ADMIN_USER}, 'b10-admin@example.com', 'microsoft', 'microsoft:b10-admin', 'B10 Admin'),
                   (${VIEWER_USER}, 'b10-viewer@example.com', 'microsoft', 'microsoft:b10-viewer', 'B10 Viewer'),
                   (${CONSULTANT_USER}, 'b10-cons@example.com', 'microsoft', 'microsoft:b10-cons', 'B10 Consultant')`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT_A}, ${ADMIN_USER}, 'admin', true),
                              (gen_random_uuid(), ${TENANT_A}, ${VIEWER_USER}, 'viewer', true),
                              (gen_random_uuid(), ${TENANT_A}, ${CONSULTANT_USER}, 'consultant', true)`;
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                       VALUES (${SUBJECT_A}, ${TENANT_A}, 'Acme R&D', 'claimant'),
                              (${SUBJECT_B}, ${TENANT_B}, 'Other Corp', 'claimant')`;

  // Three firm-A expenditures + one firm-B (cross-firm positive
  // control). expenditure_date all within FY2025 (2024-07-01..2025-06-30).
  // Total amounts as 'N.NN' strings — postgres NUMERIC(12,2) parses
  // them losslessly.
  await privilegedSql`
    INSERT INTO expenditure (
      id, tenant_id, subject_tenant_id, source, source_external_id,
      vendor_name, reference, expenditure_date, total_amount, currency,
      raw_payload, voided_at
    ) VALUES
    (${EXP_ACME_INVOICE}, ${TENANT_A}, ${SUBJECT_A}, 'xero_invoice', 'inv-1',
     'Acme Industries', 'INV-001', '2024-08-15'::date, '1500.00', 'AUD',
     '{}'::jsonb, NULL),
    (${EXP_OTHER_BANK}, ${TENANT_A}, ${SUBJECT_A}, 'xero_bank_tx', 'bt-1',
     'Officeworks', 'BT-001', '2024-09-10'::date, '250.00', 'AUD',
     '{}'::jsonb, NULL),
    (${EXP_VOIDED}, ${TENANT_A}, ${SUBJECT_A}, 'xero_receipt', 'rcpt-1',
     'Coffee Shop', 'RCT-001', '2024-10-05'::date, '15.50', 'AUD',
     '{}'::jsonb, NOW()),
    (${EXP_FIRM_B}, ${TENANT_B}, ${SUBJECT_B}, 'xero_invoice', 'inv-fb',
     'Firm B Vendor', 'FB-001', '2024-08-15'::date, '500.00', 'AUD',
     '{}'::jsonb, NULL)
  `;

  // Lines: each expenditure gets a single line so account_code +
  // description are deterministic. Acme invoice uses '400'
  // (consulting), Officeworks uses '404' (office supplies).
  await privilegedSql`
    INSERT INTO expenditure_line (expenditure_id, description, account_code, amount)
    VALUES
    (${EXP_ACME_INVOICE}, 'R&D consulting Q1', '400', '1500.00'),
    (${EXP_OTHER_BANK}, 'Stationery', '404', '250.00'),
    (${EXP_VOIDED}, 'Coffee meetings', '404', '15.50'),
    (${EXP_FIRM_B}, 'Firm B work', '400', '500.00')
  `;

  await privilegedSql`
    INSERT INTO claim (
      id, tenant_id, subject_tenant_id, fiscal_year, stage
    ) VALUES
    (${CLAIM_A}, ${TENANT_A}, ${SUBJECT_A}, 2025, 'engagement'),
    (${CLAIM_B}, ${TENANT_B}, ${SUBJECT_B}, 2025, 'engagement')
  `;

  // Rules:
  //   RULE_ACME (priority 10) — matches contact_name contains "Acme",
  //     case-insensitive. Action: map_to_activity ACTIVITY_X.
  //   RULE_CATCH_ALL (priority 100) — empty conditions → matches
  //     everything. Action: flag_for_review.
  //   RULE_DISABLED (priority 5) — would match Acme but enabled=false.
  //   RULE_FIRM_B — cross-firm rule, must NOT see firm-A expenditures.
  await privilegedSql`
    INSERT INTO mapping_rule (
      tenant_id, id, name, priority, enabled, conditions, action, created_by_user_id
    ) VALUES
    (${TENANT_A}, ${RULE_ACME}, 'Acme R&D consulting', 10, true,
     ${JSON.stringify([
       { field: 'contact_name', op: 'contains', value: 'Acme', case_insensitive: true },
     ])}::jsonb,
     ${JSON.stringify({ type: 'map_to_activity', activity_id: ACTIVITY_X })}::jsonb,
     ${ADMIN_USER}),
    (${TENANT_A}, ${RULE_CATCH_ALL}, 'Catch-all', 100, true,
     ${'[]'}::jsonb,
     ${JSON.stringify({ type: 'flag_for_review', reason: 'unmatched' })}::jsonb,
     ${ADMIN_USER}),
    (${TENANT_A}, ${RULE_DISABLED}, 'Disabled Acme rule', 5, false,
     ${JSON.stringify([
       { field: 'contact_name', op: 'contains', value: 'Acme', case_insensitive: true },
     ])}::jsonb,
     ${JSON.stringify({ type: 'map_to_activity', activity_id: ACTIVITY_Y })}::jsonb,
     ${ADMIN_USER}),
    (${TENANT_B}, ${RULE_FIRM_B}, 'Firm B rule', 10, true,
     ${'[]'}::jsonb,
     ${JSON.stringify({ type: 'flag_for_review', reason: 'firm B' })}::jsonb,
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

const adminJwt = (): Promise<string> => jwtFor(ADMIN_USER, 'b10-admin@example.com', 'admin');
const viewerJwt = (): Promise<string> => jwtFor(VIEWER_USER, 'b10-viewer@example.com', 'viewer');
const consultantJwt = (): Promise<string> =>
  jwtFor(CONSULTANT_USER, 'b10-cons@example.com', 'consultant');

// ---------------------------------------------------------------------------
// POST /v1/expenditures/:id/preview-rules
// ---------------------------------------------------------------------------

test('POST /v1/expenditures/:id/preview-rules: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/expenditures/${EXP_ACME_INVOICE}/preview-rules`,
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /v1/expenditures/:id/preview-rules: 403 for viewer', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/expenditures/${EXP_ACME_INVOICE}/preview-rules`,
    cookies: { cpa_session: await viewerJwt() },
  });
  assert.equal(res.statusCode, 403);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'forbidden');
  await app.close();
});

test('POST /v1/expenditures/:id/preview-rules: 404 for cross-firm expenditure', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/expenditures/${EXP_FIRM_B}/preview-rules`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 404);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'expenditure_not_found');
  await app.close();
});

test('POST /v1/expenditures/:id/preview-rules: 404 for unknown id', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/expenditures/00000000-0000-4000-8000-000000abcdef/preview-rules',
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('POST /v1/expenditures/:id/preview-rules: 200 returns matches in priority order', async () => {
  // Acme invoice → matches RULE_ACME (priority 10) and RULE_CATCH_ALL
  // (priority 100) but NOT RULE_DISABLED. Output is priority ASC so
  // RULE_ACME comes first.
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/expenditures/${EXP_ACME_INVOICE}/preview-rules`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    matches: Array<{
      rule_id: string;
      rule_name: string;
      priority: number;
      action: { type: string };
    }>;
  }>();
  assert.equal(body.matches.length, 2);
  assert.equal(body.matches[0]!.rule_id, RULE_ACME);
  assert.equal(body.matches[0]!.priority, 10);
  assert.equal(body.matches[0]!.action.type, 'map_to_activity');
  assert.equal(body.matches[1]!.rule_id, RULE_CATCH_ALL);
  assert.equal(body.matches[1]!.priority, 100);
  // RULE_DISABLED has priority 5 (would be first if active) — assert
  // it's absent.
  assert.ok(!body.matches.some((m) => m.rule_id === RULE_DISABLED));
  await app.close();
});

test('POST /v1/expenditures/:id/preview-rules: consultant role can preview', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/expenditures/${EXP_ACME_INVOICE}/preview-rules`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(res.statusCode, 200);
  await app.close();
});

test('POST /v1/expenditures/:id/preview-rules: 200 with non-Acme expenditure matches catch-all only', async () => {
  // Officeworks bank-tx — does NOT match RULE_ACME, but DOES match
  // RULE_CATCH_ALL (empty conditions = vacuous truth).
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/expenditures/${EXP_OTHER_BANK}/preview-rules`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ matches: Array<{ rule_id: string }> }>();
  assert.equal(body.matches.length, 1);
  assert.equal(body.matches[0]!.rule_id, RULE_CATCH_ALL);
  await app.close();
});

test('POST /v1/expenditures/:id/preview-rules: 200 with no enabled rules returns empty matches', async () => {
  // Soft-disable both Acme + catch-all rules, restore in finally.
  await privilegedSql`UPDATE mapping_rule SET enabled = false
                       WHERE id IN (${RULE_ACME}, ${RULE_CATCH_ALL})`;
  try {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/expenditures/${EXP_ACME_INVOICE}/preview-rules`,
      cookies: { cpa_session: await adminJwt() },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{ matches: unknown[] }>();
    assert.equal(body.matches.length, 0);
    await app.close();
  } finally {
    await privilegedSql`UPDATE mapping_rule SET enabled = true
                         WHERE id IN (${RULE_ACME}, ${RULE_CATCH_ALL})`;
  }
});

test('POST /v1/expenditures/:id/preview-rules: cross-firm rule never appears in firm-A response', async () => {
  // Positive control: the firm-B rule has priority 10 (would interleave
  // with firm-A rules if RLS leaked). Confirm it's invisible.
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/expenditures/${EXP_ACME_INVOICE}/preview-rules`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ matches: Array<{ rule_id: string }> }>();
  assert.ok(!body.matches.some((m) => m.rule_id === RULE_FIRM_B));
  await app.close();
});

// ---------------------------------------------------------------------------
// POST /v1/claims/:id/preview-rules
// ---------------------------------------------------------------------------

test('POST /v1/claims/:id/preview-rules: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_A}/preview-rules`,
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /v1/claims/:id/preview-rules: 403 for viewer', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_A}/preview-rules`,
    cookies: { cpa_session: await viewerJwt() },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('POST /v1/claims/:id/preview-rules: 404 for cross-firm claim', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_B}/preview-rules`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 404);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'claim_not_found');
  await app.close();
});

test('POST /v1/claims/:id/preview-rules: 404 for unknown id', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/claims/00000000-0000-4000-8000-000000abcdef/preview-rules',
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('POST /v1/claims/:id/preview-rules: 200 batch with mixed match/no-match + summary counts', async () => {
  // Firm A FY2025 has THREE expenditures within the window (Acme,
  // Officeworks, voided). The voided one is filtered out by the
  // `voided_at IS NULL` predicate, so the batch returns 2.
  //
  //   - Acme invoice → RULE_ACME (10) + RULE_CATCH_ALL (100) = 2 matches
  //   - Officeworks  → RULE_CATCH_ALL only                   = 1 match
  //
  // Both have at least one match; expected summary counts:
  //   total_expenditures = 2
  //   with_matches       = 2
  //   without_matches    = 0
  //   total_match_count  = 3
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_A}/preview-rules`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    expenditures: Array<{
      expenditure_id: string;
      kind: string;
      amount: number;
      currency: string;
      matches: Array<{ rule_id: string; priority: number }>;
    }>;
    summary: {
      total_expenditures: number;
      with_matches: number;
      without_matches: number;
      total_match_count: number;
    };
    truncated: boolean;
  }>();
  assert.equal(body.expenditures.length, 2);
  assert.equal(body.summary.total_expenditures, 2);
  assert.equal(body.summary.with_matches, 2);
  assert.equal(body.summary.without_matches, 0);
  assert.equal(body.summary.total_match_count, 3);
  assert.equal(body.truncated, false);
  // Voided expenditure is excluded.
  assert.ok(!body.expenditures.some((e) => e.expenditure_id === EXP_VOIDED));
  // Per-expenditure structure: kind + amount + currency populated;
  // Acme invoice is amount 1500, kind INVOICE.
  const acme = body.expenditures.find((e) => e.expenditure_id === EXP_ACME_INVOICE);
  assert.ok(acme, 'expected Acme expenditure in response');
  assert.equal(acme.kind, 'INVOICE');
  assert.equal(acme.amount, 1500);
  assert.equal(acme.currency, 'AUD');
  assert.equal(acme.matches.length, 2);
  // Acme matches in priority order.
  assert.equal(acme.matches[0]!.rule_id, RULE_ACME);
  assert.equal(acme.matches[0]!.priority, 10);
  assert.equal(acme.matches[1]!.rule_id, RULE_CATCH_ALL);
  await app.close();
});

test('POST /v1/claims/:id/preview-rules: 200 batch where some have matches and some do not', async () => {
  // Disable RULE_CATCH_ALL so Officeworks no longer matches anything.
  await privilegedSql`UPDATE mapping_rule SET enabled = false WHERE id = ${RULE_CATCH_ALL}`;
  try {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/claims/${CLAIM_A}/preview-rules`,
      cookies: { cpa_session: await adminJwt() },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{
      expenditures: Array<{ expenditure_id: string; matches: unknown[] }>;
      summary: {
        total_expenditures: number;
        with_matches: number;
        without_matches: number;
        total_match_count: number;
      };
    }>();
    assert.equal(body.summary.total_expenditures, 2);
    assert.equal(body.summary.with_matches, 1);
    assert.equal(body.summary.without_matches, 1);
    assert.equal(body.summary.total_match_count, 1);
    // Acme has 1 match (RULE_ACME), Officeworks has 0.
    const acme = body.expenditures.find((e) => e.expenditure_id === EXP_ACME_INVOICE)!;
    const office = body.expenditures.find((e) => e.expenditure_id === EXP_OTHER_BANK)!;
    assert.equal(acme.matches.length, 1);
    assert.equal(office.matches.length, 0);
    await app.close();
  } finally {
    await privilegedSql`UPDATE mapping_rule SET enabled = true WHERE id = ${RULE_CATCH_ALL}`;
  }
});

test('POST /v1/claims/:id/preview-rules: 200 returns truncated=false when under cap', async () => {
  // Sanity: the seed has 2 non-voided firm-A expenditures, far below
  // the 500 cap. truncated must be false.
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_A}/preview-rules`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ truncated: boolean }>();
  assert.equal(body.truncated, false);
  await app.close();
});

test('POST /v1/claims/:id/preview-rules: voided expenditures are excluded', async () => {
  // Belt-and-braces: confirm the voided expenditure does NOT appear,
  // even though its date is within the FY2025 window. Mirrors the
  // expenditure.ts header's "voided rows survive for audit but are
  // filtered from apportionment" contract.
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_A}/preview-rules`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ expenditures: Array<{ expenditure_id: string }> }>();
  assert.ok(!body.expenditures.some((e) => e.expenditure_id === EXP_VOIDED));
  await app.close();
});

test('POST /v1/claims/:id/preview-rules: respects fiscal-year window', async () => {
  // Insert an expenditure dated AFTER FY2025 (2025-07-15 = FY2026
  // territory). It must NOT appear in the FY2025 batch.
  const OUT_OF_WINDOW = '00000000-0000-4000-8000-0000000b1099';
  await privilegedSql`
    INSERT INTO expenditure (
      id, tenant_id, subject_tenant_id, source, source_external_id,
      vendor_name, reference, expenditure_date, total_amount, currency,
      raw_payload, voided_at
    ) VALUES (
      ${OUT_OF_WINDOW}, ${TENANT_A}, ${SUBJECT_A}, 'xero_invoice', 'inv-future',
      'Future Vendor', 'INV-FUTURE', '2025-07-15'::date, '999.00', 'AUD',
      '{}'::jsonb, NULL
    )
  `;
  try {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/claims/${CLAIM_A}/preview-rules`,
      cookies: { cpa_session: await adminJwt() },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{ expenditures: Array<{ expenditure_id: string }> }>();
    assert.ok(!body.expenditures.some((e) => e.expenditure_id === OUT_OF_WINDOW));
    await app.close();
  } finally {
    await privilegedSql`DELETE FROM expenditure WHERE id = ${OUT_OF_WINDOW}`;
  }
});

// ---------------------------------------------------------------------------
// Engine error surfacing — InvalidRuleError throws from B8's eager
// action validator. The route does NOT catch + reshape; it lets the
// global error handler emit `error: e.name === 'InvalidRuleError'` at
// 500. We exercise the path by inserting a malformed rule directly via
// privilegedSql, bypassing B9's `validateRuleViaEngine` (which would
// have emitted 400 at the create boundary). This guards the route's
// promise: "if a malformed rule somehow escaped write-time validation,
// it surfaces as 500 rather than silently producing wrong matches."
// ---------------------------------------------------------------------------

test('POST /v1/expenditures/:id/preview-rules: InvalidRuleError from engine surfaces as 500', async () => {
  // Insert an apportion rule whose percentages sum to 50, not 100.
  // The Zod schema accepts each allocation (positive finite number)
  // and the DB has no CHECK on the JSONB shape, so this slips past
  // every layer except B8's eager validator inside `applyRules`.
  // The route deliberately does NOT catch InvalidRuleError — it
  // bubbles to the global error handler, which emits
  // `error: e.name` (= 'InvalidRuleError') at 500.
  const RULE_BAD_APPORTION = '00000000-0000-4000-8000-0000000b1061';
  await privilegedSql`
    INSERT INTO mapping_rule (
      tenant_id, id, name, priority, enabled, conditions, action, created_by_user_id
    ) VALUES (
      ${TENANT_A}, ${RULE_BAD_APPORTION}, 'Bad apportion (sum 50)', 1, true,
      ${'[]'}::jsonb,
      ${JSON.stringify({
        type: 'apportion',
        allocations: [
          { activity_id: ACTIVITY_X, percentage: 30 },
          { activity_id: ACTIVITY_Y, percentage: 20 }, // sum = 50, invalid
        ],
      })}::jsonb,
      ${ADMIN_USER}
    )
  `;
  try {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/expenditures/${EXP_ACME_INVOICE}/preview-rules`,
      cookies: { cpa_session: await adminJwt() },
    });
    assert.equal(res.statusCode, 500);
    const body = res.json<{ error: string; message: string }>();
    assert.equal(body.error, 'InvalidRuleError');
    assert.match(body.message, /apportion percentages must sum to 100/i);
    await app.close();
  } finally {
    await privilegedSql`DELETE FROM mapping_rule WHERE id = ${RULE_BAD_APPORTION}`;
  }
});

// ---------------------------------------------------------------------------
// Cap-and-flag — the batch endpoint hard-caps at BATCH_CAP=500. When
// the underlying claim has more, the response carries `truncated: true`
// and `expenditures.length === 500`. We seed BATCH_CAP+1 rows via a
// single bulk INSERT (`generate_series`) to keep the test cheap; with
// no individual round-trips per row, total seed time stays under the
// other write-heavy tests in this suite.
// ---------------------------------------------------------------------------

test('POST /v1/claims/:id/preview-rules: cap-and-flag emits truncated=true at BATCH_CAP+1 expenditures', async () => {
  const BATCH_CAP = 500;
  // Use a dedicated tenant + subject + claim so the seed doesn't
  // entangle with the fixture (which already has 2 expenditures inside
  // FY2025 for SUBJECT_A). Seeding into a fresh subject keeps the
  // count exact at BATCH_CAP+1 inside the FY window.
  const TENANT_BATCH = '00000000-0000-4000-8000-0000000b1003';
  const ADMIN_BATCH = '00000000-0000-4000-8000-0000000b1013';
  const SUBJECT_BATCH = '00000000-0000-4000-8000-0000000b1023';
  const CLAIM_BATCH = '00000000-0000-4000-8000-0000000b1043';

  // Cleanup any leftovers from a partial previous run.
  await privilegedSql`DELETE FROM expenditure_line
                       WHERE expenditure_id IN (
                         SELECT id FROM expenditure WHERE tenant_id = ${TENANT_BATCH}
                       )`;
  await privilegedSql`DELETE FROM expenditure WHERE tenant_id = ${TENANT_BATCH}`;
  await privilegedSql`DELETE FROM claim WHERE id = ${CLAIM_BATCH}`;
  await privilegedSql`DELETE FROM subject_tenant WHERE id = ${SUBJECT_BATCH}`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id = ${TENANT_BATCH}`;
  await sql`DELETE FROM "user" WHERE id = ${ADMIN_BATCH}`;
  await sql`DELETE FROM tenant WHERE id = ${TENANT_BATCH}`;

  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT_BATCH}, 'Firm Batch B10', 'firm-batch-b10', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${ADMIN_BATCH}, 'b10-batch-admin@example.com', 'microsoft',
                    'microsoft:b10-batch-admin', 'B10 Batch Admin')`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT_BATCH}, ${ADMIN_BATCH}, 'admin', true)`;
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                       VALUES (${SUBJECT_BATCH}, ${TENANT_BATCH}, 'Batch Subject', 'claimant')`;
  await privilegedSql`INSERT INTO claim (id, tenant_id, subject_tenant_id, fiscal_year, stage)
                       VALUES (${CLAIM_BATCH}, ${TENANT_BATCH}, ${SUBJECT_BATCH}, 2025, 'engagement')`;

  // Bulk-insert BATCH_CAP+1 expenditures via generate_series — single
  // round-trip, ~milliseconds vs minutes for per-row inserts. Dates are
  // scattered inside the FY2025 window (2024-07-01..2025-06-30) using
  // a modulo trick so every row is in-window. raw_payload stays empty.
  await privilegedSql`
    INSERT INTO expenditure (
      id, tenant_id, subject_tenant_id, source, source_external_id,
      vendor_name, reference, expenditure_date, total_amount, currency,
      raw_payload, voided_at
    )
    SELECT
      gen_random_uuid(),
      ${TENANT_BATCH},
      ${SUBJECT_BATCH},
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
    // jwtFor() above pins activeTenantId to TENANT_A — sign a JWT
    // scoped to TENANT_BATCH directly so RLS sees the right tenant.
    const tenantBatchJwt = await signSession(
      {
        sub: ADMIN_BATCH,
        email: 'b10-batch-admin@example.com',
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
      url: `/v1/claims/${CLAIM_BATCH}/preview-rules`,
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
    await privilegedSql`DELETE FROM expenditure WHERE tenant_id = ${TENANT_BATCH}`;
    await privilegedSql`DELETE FROM claim WHERE id = ${CLAIM_BATCH}`;
    await privilegedSql`DELETE FROM subject_tenant WHERE id = ${SUBJECT_BATCH}`;
    await privilegedSql`DELETE FROM tenant_user WHERE tenant_id = ${TENANT_BATCH}`;
    await sql`DELETE FROM "user" WHERE id = ${ADMIN_BATCH}`;
    await sql`DELETE FROM tenant WHERE id = ${TENANT_BATCH}`;
  }
});
