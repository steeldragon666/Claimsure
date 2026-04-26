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
});

after(async () => {
  // Clean up — DELETEs on RLS-protected tables also need the GUC because
  // policy USING applies to DELETE.
  // delegation_token rows first (they FK to subject_tenant + user).
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${TENANT_A_ID}, true)`;
    await tx`DELETE FROM delegation_token WHERE id = ${TOK_A_ID}`;
  });
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${TENANT_B_ID}, true)`;
    await tx`DELETE FROM delegation_token WHERE id = ${TOK_B_ID}`;
  });
  // Then subject_tenants (FK target of delegation_token). Including the
  // smuggled-B id is a defensive belt-and-braces — if the WITH CHECK
  // assertion above ever regresses and the insert succeeds, this DELETE
  // will tidy up before the tenant DELETE so we don't leak orphan rows.
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
