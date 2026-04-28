import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from '../client.js';

const TENANT_A_ID = '00000000-0000-4000-8000-00000000000a';
const TENANT_B_ID = '00000000-0000-4000-8000-00000000000b';
const SUBJECT_A1_ID = '00000000-0000-4000-8000-0000000000a1';
const SUBJECT_B1_ID = '00000000-0000-4000-8000-0000000000b1';
// Used as the would-be id for the cross-tenant INSERT smuggling test.
// Kept defensively in cleanup so a future WITH CHECK regression doesn't leak.
const SMUGGLED_ID = '00000000-0000-4000-8000-0000000000ff';
const USER_X_ID = '00000000-0000-4000-8000-0000000000ee';
const TOK_A_ID = '00000000-0000-4000-8000-0000000000ca';
const TOK_B_ID = '00000000-0000-4000-8000-0000000000cb';

// P4 fixture IDs — one row per tenant for each of the 6 P4 tables.
// Suffix scheme: aNNN = tenant A, bNNN = tenant B. NNN is a stable
// per-table number (701 = project, 702 = claim, 703 = activity,
// 704 = expenditure, 705 = expenditure_line, 706 = mapping_rule).
const PROJECT_A_ID = '00000000-0000-4000-8000-00000000a701';
const PROJECT_B_ID = '00000000-0000-4000-8000-00000000b701';
const CLAIM_A_ID = '00000000-0000-4000-8000-00000000a702';
const CLAIM_B_ID = '00000000-0000-4000-8000-00000000b702';
const ACTIVITY_A_ID = '00000000-0000-4000-8000-00000000a703';
const ACTIVITY_B_ID = '00000000-0000-4000-8000-00000000b703';
const EXPENDITURE_A_ID = '00000000-0000-4000-8000-00000000a704';
const EXPENDITURE_B_ID = '00000000-0000-4000-8000-00000000b704';
const EXP_LINE_A_ID = '00000000-0000-4000-8000-00000000a705';
const EXP_LINE_B_ID = '00000000-0000-4000-8000-00000000b705';
const MAPPING_RULE_A_ID = '00000000-0000-4000-8000-00000000a706';
const MAPPING_RULE_B_ID = '00000000-0000-4000-8000-00000000b706';
// Smuggling target IDs for cross-tenant INSERT rejection tests; cleaned
// up defensively in `after` like SMUGGLED_ID.
const PROJECT_SMUGGLED_ID = '00000000-0000-4000-8000-00000000af71';
const CLAIM_SMUGGLED_ID = '00000000-0000-4000-8000-00000000af72';
const ACTIVITY_SMUGGLED_ID = '00000000-0000-4000-8000-00000000af73';
const EXPENDITURE_SMUGGLED_ID = '00000000-0000-4000-8000-00000000af74';
const MAPPING_RULE_SMUGGLED_ID = '00000000-0000-4000-8000-00000000af76';

before(async () => {
  // tenant + user tables are global (no RLS) — direct inserts work as cpa_app via GRANT.
  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT_A_ID}, 'Firm A', 'firm-a', 'mixed'),
                   (${TENANT_B_ID}, 'Firm B', 'firm-b', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id)
            VALUES (${USER_X_ID}, 'rls-test-user@example.com', 'microsoft', 'microsoft:rls-test')`;

  // subject_tenant is RLS-protected. Each INSERT must run with the per-tx
  // GUC matching the row's tenant_id (so WITH CHECK passes).
  // Using set_config(name, value, is_local=true) instead of `SET LOCAL` because
  // SET is a utility statement and does not accept bind parameters; set_config()
  // is a regular function and behaves identically (transaction-scoped when
  // is_local=true, equivalent to `SET LOCAL`).
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${TENANT_A_ID}, true)`;
    await tx`INSERT INTO subject_tenant (id, tenant_id, name, kind)
             VALUES (${SUBJECT_A1_ID}, ${TENANT_A_ID}, 'Claimant A1', 'claimant')`;
  });
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${TENANT_B_ID}, true)`;
    await tx`INSERT INTO subject_tenant (id, tenant_id, name, kind)
             VALUES (${SUBJECT_B1_ID}, ${TENANT_B_ID}, 'Claimant B1', 'claimant')`;
  });

  // P4 fixture — seed one of each P4 entity per tenant for the new
  // RLS tests. All 6 tables that gain a tenant_isolation policy in
  // 0012/0013 (project, claim, activity, expenditure,
  // expenditure_mapping_rule) are seeded inside the active tenant's
  // GUC so WITH CHECK passes. expenditure_line has no RLS / no
  // tenant_id (see expenditure_line.ts JSDoc) but is seeded inside
  // the parent expenditure's GUC for clarity.
  //
  // FK ordering within each tenant's tx:
  //   project (no FKs to seed-time rows beyond tenant + subject_tenant)
  //   -> claim (-> tenant + subject_tenant)
  //   -> activity (-> project + claim + tenant)
  //   -> expenditure (-> tenant + subject_tenant)
  //   -> expenditure_line (-> expenditure)
  //   -> expenditure_mapping_rule (-> tenant + activity)
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${TENANT_A_ID}, true)`;
    await tx`INSERT INTO project (id, tenant_id, subject_tenant_id, name, started_at)
             VALUES (${PROJECT_A_ID}, ${TENANT_A_ID}, ${SUBJECT_A1_ID}, 'Project A1', '2024-07-01T00:00:00Z')`;
    await tx`INSERT INTO claim (id, tenant_id, subject_tenant_id, fiscal_year, stage)
             VALUES (${CLAIM_A_ID}, ${TENANT_A_ID}, ${SUBJECT_A1_ID}, 2025, 'engagement')`;
    await tx`INSERT INTO activity (id, tenant_id, project_id, claim_id, code, kind, title)
             VALUES (${ACTIVITY_A_ID}, ${TENANT_A_ID}, ${PROJECT_A_ID}, ${CLAIM_A_ID}, 'CA-01', 'core', 'Activity A1')`;
    await tx`INSERT INTO expenditure (id, tenant_id, subject_tenant_id, source, vendor_name, expenditure_date, total_amount, currency)
             VALUES (${EXPENDITURE_A_ID}, ${TENANT_A_ID}, ${SUBJECT_A1_ID}, 'manual', 'Vendor A', '2025-01-15', '1000.00', 'AUD')`;
    await tx`INSERT INTO expenditure_line (id, expenditure_id, description, amount)
             VALUES (${EXP_LINE_A_ID}, ${EXPENDITURE_A_ID}, 'Line A', '1000.00')`;
    await tx`INSERT INTO expenditure_mapping_rule (id, tenant_id, activity_id, rd_percent, priority)
             VALUES (${MAPPING_RULE_A_ID}, ${TENANT_A_ID}, ${ACTIVITY_A_ID}, 80, 100)`;
  });
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${TENANT_B_ID}, true)`;
    await tx`INSERT INTO project (id, tenant_id, subject_tenant_id, name, started_at)
             VALUES (${PROJECT_B_ID}, ${TENANT_B_ID}, ${SUBJECT_B1_ID}, 'Project B1', '2024-07-01T00:00:00Z')`;
    await tx`INSERT INTO claim (id, tenant_id, subject_tenant_id, fiscal_year, stage)
             VALUES (${CLAIM_B_ID}, ${TENANT_B_ID}, ${SUBJECT_B1_ID}, 2025, 'engagement')`;
    await tx`INSERT INTO activity (id, tenant_id, project_id, claim_id, code, kind, title)
             VALUES (${ACTIVITY_B_ID}, ${TENANT_B_ID}, ${PROJECT_B_ID}, ${CLAIM_B_ID}, 'CA-01', 'core', 'Activity B1')`;
    await tx`INSERT INTO expenditure (id, tenant_id, subject_tenant_id, source, vendor_name, expenditure_date, total_amount, currency)
             VALUES (${EXPENDITURE_B_ID}, ${TENANT_B_ID}, ${SUBJECT_B1_ID}, 'manual', 'Vendor B', '2025-01-15', '2000.00', 'AUD')`;
    await tx`INSERT INTO expenditure_line (id, expenditure_id, description, amount)
             VALUES (${EXP_LINE_B_ID}, ${EXPENDITURE_B_ID}, 'Line B', '2000.00')`;
    await tx`INSERT INTO expenditure_mapping_rule (id, tenant_id, activity_id, rd_percent, priority)
             VALUES (${MAPPING_RULE_B_ID}, ${TENANT_B_ID}, ${ACTIVITY_B_ID}, 50, 100)`;
  });
});

after(async () => {
  // Clean up — DELETEs on RLS-protected tables also need the GUC because
  // policy USING applies to DELETE.
  //
  // Reverse FK order:
  //   1. expenditure_line (FK -> expenditure)            no RLS
  //   2. expenditure_mapping_rule (FK -> tenant + activity)  RLS
  //   3. activity (FK -> tenant + project + claim)       RLS
  //   4. claim (FK -> tenant + subject_tenant)           RLS
  //   5. expenditure (FK -> tenant + subject_tenant)     RLS
  //   6. project (FK -> tenant + subject_tenant)         RLS
  //   7. delegation_token (FK -> subject_tenant + user)  RLS
  //   8. subject_tenant (FK -> tenant)                   RLS
  //   9. user, tenant                                    no RLS
  //
  // expenditure_line has no RLS so a direct delete works without GUC,
  // but doing it inside the parent's GUC keeps the per-tenant grouping
  // tidy.
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${TENANT_A_ID}, true)`;
    await tx`DELETE FROM expenditure_line WHERE id = ${EXP_LINE_A_ID}`;
    await tx`DELETE FROM expenditure_mapping_rule WHERE id = ${MAPPING_RULE_A_ID}`;
    await tx`DELETE FROM activity WHERE id = ${ACTIVITY_A_ID}`;
    await tx`DELETE FROM claim WHERE id = ${CLAIM_A_ID}`;
    await tx`DELETE FROM expenditure WHERE id = ${EXPENDITURE_A_ID}`;
    await tx`DELETE FROM project WHERE id = ${PROJECT_A_ID}`;
  });
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${TENANT_B_ID}, true)`;
    // Defensive belt-and-braces: include smuggled IDs in case a future
    // WITH CHECK regression lets a cross-tenant INSERT succeed. These
    // would land under tenant B (the cross-tenant target) for the rule
    // and mapping-rule tests; for the others the smuggled rows claim
    // tenant B too, so they end up in B's deletion bucket regardless of
    // which tenant context the cleanup runs under (RLS policy on tenant B's
    // GUC matches tenant_id = B). The expenditure_line smuggle path is
    // not testable (no tenant_id, no RLS) so there is no smuggle ID for it.
    await tx`DELETE FROM expenditure_line WHERE id = ${EXP_LINE_B_ID}`;
    await tx`DELETE FROM expenditure_mapping_rule WHERE id IN (${MAPPING_RULE_B_ID}, ${MAPPING_RULE_SMUGGLED_ID})`;
    await tx`DELETE FROM activity WHERE id IN (${ACTIVITY_B_ID}, ${ACTIVITY_SMUGGLED_ID})`;
    await tx`DELETE FROM claim WHERE id IN (${CLAIM_B_ID}, ${CLAIM_SMUGGLED_ID})`;
    await tx`DELETE FROM expenditure WHERE id IN (${EXPENDITURE_B_ID}, ${EXPENDITURE_SMUGGLED_ID})`;
    await tx`DELETE FROM project WHERE id IN (${PROJECT_B_ID}, ${PROJECT_SMUGGLED_ID})`;
  });

  // delegation_token rows next (they FK to subject_tenant + user).
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${TENANT_A_ID}, true)`;
    await tx`DELETE FROM delegation_token WHERE id = ${TOK_A_ID}`;
  });
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${TENANT_B_ID}, true)`;
    await tx`DELETE FROM delegation_token WHERE id = ${TOK_B_ID}`;
  });
  // audit_score_snapshot rows must be cleared before the parent
  // subject_tenant. The recomputeAllActive() job in apps/api iterates
  // every non-deleted claimant and writes a snapshot per claimant —
  // when that test runs in parallel with this one (turbo's test scheduler
  // is non-deterministic), it can land snapshots referencing our
  // SUBJECT_*_ID rows mid-test, blocking the subject_tenant DELETE on
  // FK `audit_score_snapshot_subject_tenant_id_subject_tenant_id_fk`.
  // Defensive clear by subject_tenant_id keeps cleanup deterministic
  // regardless of who else writes snapshots concurrently.
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${TENANT_A_ID}, true)`;
    await tx`DELETE FROM audit_score_snapshot WHERE subject_tenant_id = ${SUBJECT_A1_ID}`;
  });
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${TENANT_B_ID}, true)`;
    await tx`DELETE FROM audit_score_snapshot WHERE subject_tenant_id IN (${SUBJECT_B1_ID}, ${SMUGGLED_ID})`;
  });
  // Then subject_tenants (FK target of delegation_token + audit_score_snapshot).
  // Including the smuggled-B id is a defensive belt-and-braces — if the
  // WITH CHECK assertion above ever regresses and the insert succeeds,
  // this DELETE will tidy up before the tenant DELETE so we don't leak
  // orphan rows.
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${TENANT_A_ID}, true)`;
    await tx`DELETE FROM subject_tenant WHERE id = ${SUBJECT_A1_ID}`;
  });
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${TENANT_B_ID}, true)`;
    await tx`DELETE FROM subject_tenant WHERE id IN (${SUBJECT_B1_ID}, ${SMUGGLED_ID})`;
  });
  // Global tables — no RLS, direct delete.
  await sql`DELETE FROM "user" WHERE id = ${USER_X_ID}`;
  await sql`DELETE FROM tenant WHERE id IN (${TENANT_A_ID}, ${TENANT_B_ID})`;
  await sql.end();
});

test('RLS: tenant A context sees only tenant A subject_tenants', async () => {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${TENANT_A_ID}, true)`;
    const rows = await tx<{ id: string; name: string }[]>`
      SELECT id, name FROM subject_tenant ORDER BY name
    `;
    assert.equal(rows.length, 1, 'should see exactly 1 subject_tenant');
    assert.equal(rows[0]?.id, SUBJECT_A1_ID);
    assert.equal(rows[0]?.name, 'Claimant A1');
  });
});

test('RLS: tenant B context sees only tenant B subject_tenants', async () => {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${TENANT_B_ID}, true)`;
    const rows = await tx<{ id: string; name: string }[]>`
      SELECT id, name FROM subject_tenant ORDER BY name
    `;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, SUBJECT_B1_ID);
    assert.equal(rows[0]?.name, 'Claimant B1');
  });
});

test('RLS: unset context does not leak cross-tenant data', async () => {
  // Postgres custom-GUC quirk: once `set_config('app.current_tenant_id', ..., is_local)`
  // has been called on a connection (even with is_local=true, which reverts the value
  // at tx end), the GUC stays "recognized" — and current_setting('app.current_tenant_id',
  // true) returns '' (empty string), NOT NULL, on subsequent reads. Because postgres-js
  // pools connections, every subject_tenant connection in this test has been touched
  // by a prior tx, so the policy expression `(current_setting(...))::uuid` errors with
  // "invalid input syntax for type uuid: ''" instead of returning 0 rows.
  //
  // Both outcomes are valid fail-safes — neither leaks cross-tenant data — so this test
  // asserts the *security property*: with no tenant context, the query MUST NOT return
  // any rows from any tenant. Either an error or a 0-row result satisfies this.
  let rowCount: number | 'errored' = 'errored';
  try {
    await sql.begin(async (tx) => {
      const rows = await tx`SELECT id FROM subject_tenant`;
      rowCount = rows.length;
    });
  } catch {
    rowCount = 'errored';
  }
  if (rowCount === 'errored') {
    // Acceptable: the policy's ::uuid cast on '' threw before any rows were returned.
    return;
  }
  assert.equal(rowCount, 0, 'no rows visible without RLS context');
});

test('RLS: cross-tenant INSERT is rejected (WITH CHECK enforces tenant_id match)', async () => {
  // While in tenant A context, attempting to INSERT a row claiming tenant B should fail.
  let caught: unknown = null;
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${TENANT_A_ID}, true)`;
      await tx`INSERT INTO subject_tenant (id, tenant_id, name, kind)
               VALUES (${SMUGGLED_ID}, ${TENANT_B_ID}, 'Smuggled B', 'claimant')`;
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught !== null, 'INSERT with mismatched tenant_id should throw');
  const message = String((caught as Error)?.message ?? caught);
  assert.match(
    message,
    /row-level security/i,
    `error should mention row-level security; got: ${message}`,
  );
});

test('RLS: tenant A context sees only its own delegation_tokens', async () => {
  // Seed one delegation_token per tenant inside the active tenant's GUC.
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${TENANT_A_ID}, true)`;
    await tx`INSERT INTO delegation_token (id, issuer_tenant_id, subject_tenant_id, issued_to_email, scope, issued_by_user_id, expires_at)
             VALUES (${TOK_A_ID}, ${TENANT_A_ID}, ${SUBJECT_A1_ID}, 'a@bank.com', '{"read":["assurance_report"]}'::jsonb, ${USER_X_ID}, NOW() + INTERVAL '30 days')`;
  });
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${TENANT_B_ID}, true)`;
    await tx`INSERT INTO delegation_token (id, issuer_tenant_id, subject_tenant_id, issued_to_email, scope, issued_by_user_id, expires_at)
             VALUES (${TOK_B_ID}, ${TENANT_B_ID}, ${SUBJECT_B1_ID}, 'b@bank.com', '{"read":["assurance_report"]}'::jsonb, ${USER_X_ID}, NOW() + INTERVAL '30 days')`;
  });

  // Read back as tenant A — should see only A's token.
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${TENANT_A_ID}, true)`;
    const rows = await tx<{ id: string; issued_to_email: string }[]>`
      SELECT id, issued_to_email FROM delegation_token ORDER BY issued_to_email
    `;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.issued_to_email, 'a@bank.com');
  });
});

// ---------------------------------------------------------------------------
// P4 RLS isolation tests — F7
//
// One read-isolation + one cross-tenant-INSERT-rejection test per
// RLS-protected P4 table (project, claim, activity, expenditure,
// expenditure_mapping_rule), plus 2 atypical tests for expenditure_line
// (which has no direct RLS by design — see expenditure_line.ts JSDoc).
// ---------------------------------------------------------------------------

// project ---------------------------------------------------------------------

test('RLS: project — tenant A context sees only tenant A rows', async () => {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${TENANT_A_ID}, true)`;
    const rows = await tx<{ id: string }[]>`SELECT id FROM "project" ORDER BY id`;
    assert.equal(rows.length, 1, 'should see exactly 1 project');
    assert.equal(rows[0]?.id, PROJECT_A_ID);
  });
});

test('RLS: project — cross-tenant INSERT rejected', async () => {
  let caught: unknown = null;
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${TENANT_A_ID}, true)`;
      await tx`INSERT INTO "project" (id, tenant_id, subject_tenant_id, name, started_at)
               VALUES (${PROJECT_SMUGGLED_ID}, ${TENANT_B_ID}, ${SUBJECT_B1_ID}, 'Smuggled Project', '2024-07-01T00:00:00Z')`;
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught !== null, 'INSERT with mismatched tenant_id should throw');
  assert.match(String((caught as Error)?.message ?? caught), /row-level security/i);
});

// claim -----------------------------------------------------------------------

test('RLS: claim — tenant A context sees only tenant A rows', async () => {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${TENANT_A_ID}, true)`;
    const rows = await tx<{ id: string }[]>`SELECT id FROM "claim" ORDER BY id`;
    assert.equal(rows.length, 1, 'should see exactly 1 claim');
    assert.equal(rows[0]?.id, CLAIM_A_ID);
  });
});

test('RLS: claim — cross-tenant INSERT rejected', async () => {
  let caught: unknown = null;
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${TENANT_A_ID}, true)`;
      await tx`INSERT INTO "claim" (id, tenant_id, subject_tenant_id, fiscal_year, stage)
               VALUES (${CLAIM_SMUGGLED_ID}, ${TENANT_B_ID}, ${SUBJECT_B1_ID}, 2024, 'engagement')`;
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught !== null, 'INSERT with mismatched tenant_id should throw');
  assert.match(String((caught as Error)?.message ?? caught), /row-level security/i);
});

// activity --------------------------------------------------------------------

test('RLS: activity — tenant A context sees only tenant A rows', async () => {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${TENANT_A_ID}, true)`;
    const rows = await tx<{ id: string }[]>`SELECT id FROM "activity" ORDER BY id`;
    assert.equal(rows.length, 1, 'should see exactly 1 activity');
    assert.equal(rows[0]?.id, ACTIVITY_A_ID);
  });
});

test('RLS: activity — cross-tenant INSERT rejected', async () => {
  // The smuggled row claims tenant B and references tenant B's project +
  // claim, so it would be a self-consistent cross-tenant insert if it
  // weren't for the WITH CHECK clause on the activity_tenant_isolation
  // policy.
  let caught: unknown = null;
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${TENANT_A_ID}, true)`;
      await tx`INSERT INTO "activity" (id, tenant_id, project_id, claim_id, code, kind, title)
               VALUES (${ACTIVITY_SMUGGLED_ID}, ${TENANT_B_ID}, ${PROJECT_B_ID}, ${CLAIM_B_ID}, 'CA-99', 'core', 'Smuggled Activity')`;
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught !== null, 'INSERT with mismatched tenant_id should throw');
  assert.match(String((caught as Error)?.message ?? caught), /row-level security/i);
});

// expenditure ----------------------------------------------------------------

test('RLS: expenditure — tenant A context sees only tenant A rows', async () => {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${TENANT_A_ID}, true)`;
    const rows = await tx<{ id: string }[]>`SELECT id FROM "expenditure" ORDER BY id`;
    assert.equal(rows.length, 1, 'should see exactly 1 expenditure');
    assert.equal(rows[0]?.id, EXPENDITURE_A_ID);
  });
});

test('RLS: expenditure — cross-tenant INSERT rejected', async () => {
  let caught: unknown = null;
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${TENANT_A_ID}, true)`;
      await tx`INSERT INTO "expenditure" (id, tenant_id, subject_tenant_id, source, vendor_name, expenditure_date, total_amount, currency)
               VALUES (${EXPENDITURE_SMUGGLED_ID}, ${TENANT_B_ID}, ${SUBJECT_B1_ID}, 'manual', 'Smuggled Vendor', '2025-02-01', '500.00', 'AUD')`;
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught !== null, 'INSERT with mismatched tenant_id should throw');
  assert.match(String((caught as Error)?.message ?? caught), /row-level security/i);
});

// expenditure_mapping_rule ---------------------------------------------------

test('RLS: expenditure_mapping_rule — tenant A context sees only tenant A rows', async () => {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${TENANT_A_ID}, true)`;
    const rows = await tx<{ id: string }[]>`SELECT id FROM "expenditure_mapping_rule" ORDER BY id`;
    assert.equal(rows.length, 1, 'should see exactly 1 expenditure_mapping_rule');
    assert.equal(rows[0]?.id, MAPPING_RULE_A_ID);
  });
});

test('RLS: expenditure_mapping_rule — cross-tenant INSERT rejected', async () => {
  let caught: unknown = null;
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${TENANT_A_ID}, true)`;
      await tx`INSERT INTO "expenditure_mapping_rule" (id, tenant_id, activity_id, rd_percent, priority)
               VALUES (${MAPPING_RULE_SMUGGLED_ID}, ${TENANT_B_ID}, ${ACTIVITY_B_ID}, 60, 50)`;
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught !== null, 'INSERT with mismatched tenant_id should throw');
  assert.match(String((caught as Error)?.message ?? caught), /row-level security/i);
});

// expenditure_line — atypical (no direct RLS) --------------------------------

test('RLS: expenditure_line — direct SELECT as cpa_app DOES return cross-tenant rows (intentional)', async () => {
  // expenditure_line has no tenant_id column and no RLS. This test confirms
  // the design choice: a raw `SELECT * FROM expenditure_line` does NOT filter
  // by tenant. Tenant isolation depends on the route layer always joining
  // through expenditure (the parent table, which IS RLS-protected).
  //
  // If this test starts FAILING (i.e., rows is filtered to 1), someone has
  // added RLS to expenditure_line without updating the access-path contract.
  // See expenditure_line.ts:26-47 JSDoc for the rationale.
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${TENANT_A_ID}, true)`;
    const rows = await tx<{ id: string }[]>`SELECT id FROM expenditure_line ORDER BY id`;
    assert.equal(
      rows.length,
      2,
      'expenditure_line is intentionally NOT RLS-protected — both lines visible',
    );
  });
});

test('RLS: expenditure_line — JOIN through expenditure correctly filters by tenant', async () => {
  // The route-layer pattern: always JOIN expenditure_line to expenditure to
  // pick up tenant_id from the parent. Verifies the access-path-based
  // isolation works as documented in expenditure_line.ts.
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${TENANT_A_ID}, true)`;
    const rows = await tx<{ id: string }[]>`
      SELECT el.id FROM expenditure_line el
      JOIN expenditure e ON el.expenditure_id = e.id
      ORDER BY el.id
    `;
    assert.equal(rows.length, 1, 'JOIN through parent expenditure filters to 1 line');
    assert.equal(rows[0]?.id, EXP_LINE_A_ID);
  });
});
