import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql, privilegedSql } from '@cpa/db/client';
import { onboardTenant, type OnboardArgs } from './onboard-tenant.js';

// Fixed UUIDv4 for the test admin user — lets us seed once and assert by id.
const TEST_USER_ID = '00000000-0000-4000-8000-0000000c1100';
const TEST_USER_EMAIL = 'onboard-cli-test@example.com';

// All fixture rows are tagged with this slug prefix so cleanup is a single
// LIKE pattern, even if a prior run was interrupted before after() ran.
const SLUG_PREFIX = 'onboard-cli-test';

/**
 * Wipe any leftover fixture rows from a prior interrupted run before this
 * suite touches the DB. Same query as after() so the two are symmetric.
 */
async function cleanupFixtures(): Promise<void> {
  // tenant_user is RLS-protected; use privilegedSql to delete across tenants
  // without needing a per-tenant set_config dance.
  await privilegedSql`DELETE FROM tenant_user WHERE user_id = ${TEST_USER_ID}`;
  // tenant + user are global tables — direct sql writes work as cpa_app via GRANT.
  await sql`DELETE FROM tenant WHERE slug LIKE ${SLUG_PREFIX + '%'}`;
  await sql`DELETE FROM "user" WHERE id = ${TEST_USER_ID}`;
}

before(async () => {
  await cleanupFixtures();
});

after(async () => {
  await cleanupFixtures();
  await sql.end();
  await privilegedSql.end();
});

test('onboardTenant: happy path — creates tenant + tenant_user when user exists', async () => {
  // Seed the admin user. In production this row would have been created by
  // the OIDC callback when the admin first signed in; we synthesize it here.
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id)
            VALUES (${TEST_USER_ID}, ${TEST_USER_EMAIL}, 'microsoft', 'microsoft:onboard-cli-test')
            ON CONFLICT (id) DO NOTHING`;

  const args: OnboardArgs = {
    name: 'Onboard CLI Test Firm',
    slug: 'onboard-cli-test-happy',
    adminEmail: TEST_USER_EMAIL,
    primaryIdp: 'mixed',
  };
  const result = await onboardTenant(args);
  assert.equal(result.kind, 'ok');
  if (result.kind !== 'ok') return;
  assert.match(
    result.tenantId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  assert.equal(result.userId, TEST_USER_ID);

  // Verify tenant_user row created with admin + is_default. Use privilegedSql
  // because tenant_user is RLS-protected and we have no app.current_tenant_id
  // set on this connection.
  const row = await privilegedSql<{ role: string; is_default: boolean }[]>`
    SELECT role, is_default FROM tenant_user
     WHERE tenant_id = ${result.tenantId} AND user_id = ${TEST_USER_ID}
  `;
  assert.equal(row[0]?.role, 'admin');
  assert.equal(row[0]?.is_default, true);
});

test('onboardTenant: returns user_not_found when admin email matches no user', async () => {
  const result = await onboardTenant({
    name: 'No-Such-User Firm',
    slug: 'onboard-cli-test-nouser',
    adminEmail: 'never-existed-cli-test@example.com',
    primaryIdp: 'microsoft',
  });
  assert.equal(result.kind, 'user_not_found');
});

test('onboardTenant: returns slug_conflict when slug already exists', async () => {
  // The happy-path test (run earlier in this file) leaves a default
  // tenant_user for TEST_USER_ID. `tenant_user_one_default_per_user_uniq`
  // permits only ONE is_default row per user, so the first onboardTenant
  // below would collide on that constraint (a 23505 on a DIFFERENT index
  // than slug) unless we clear the prior membership first. Cleanup is
  // idempotent and safe — onboardTenant re-creates the membership it needs.
  await privilegedSql`DELETE FROM tenant_user WHERE user_id = ${TEST_USER_ID}`;
  // Idempotent re-seed — earlier tests may have run in isolation.
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id)
            VALUES (${TEST_USER_ID}, ${TEST_USER_EMAIL}, 'microsoft', 'microsoft:onboard-cli-test')
            ON CONFLICT (id) DO NOTHING`;
  // First call succeeds.
  const first = await onboardTenant({
    name: 'Slug Test',
    slug: 'onboard-cli-test-slug',
    adminEmail: TEST_USER_EMAIL,
    primaryIdp: 'mixed',
  });
  assert.equal(first.kind, 'ok');
  // Second call with same slug must fail with slug_conflict — and crucially
  // must NOT have created an orphan tenant_user row (the rollback path).
  const result = await onboardTenant({
    name: 'Slug Test 2',
    slug: 'onboard-cli-test-slug',
    adminEmail: TEST_USER_EMAIL,
    primaryIdp: 'mixed',
  });
  assert.equal(result.kind, 'slug_conflict');
});
