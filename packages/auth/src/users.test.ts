import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql, privilegedSql } from '@cpa/db/client';
import { findOrCreateUser, getOrAddTenantUser, lookupActiveTenant } from './users.js';

const USER_NEW_EXTERNAL_ID = 'microsoft:test-t5-new-oid';
const USER_EXISTING_EXTERNAL_ID = 'microsoft:test-t5-existing-oid';
const USER_EXISTING_ID = '00000000-0000-4000-8000-000000000051';

before(async () => {
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id)
            VALUES (${USER_EXISTING_ID}, 't5-existing@example.com', 'microsoft', ${USER_EXISTING_EXTERNAL_ID})`;
});

after(async () => {
  await sql`DELETE FROM "user" WHERE external_id LIKE 'microsoft:test-t5-%'`;
  // sql.end / privilegedSql.end deferred to the bottom-of-file after() so
  // any later after()s (e.g. T4 cleanup) can still issue queries.
});

test('findOrCreateUser: creates a new user when external_id unseen', async () => {
  const user = await findOrCreateUser({
    primaryIdp: 'microsoft',
    externalId: USER_NEW_EXTERNAL_ID,
    email: 't5-new@example.com',
    displayName: 'New T5 User',
  });
  assert.match(
    user.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    'is uuid v4',
  );
  assert.equal(user.email, 't5-new@example.com');
  assert.equal(user.displayName, 'New T5 User');
  assert.equal(user.primaryIdp, 'microsoft');
  assert.equal(user.externalId, USER_NEW_EXTERNAL_ID);
});

test('findOrCreateUser: finds existing user by (primaryIdp, externalId); does NOT update email', async () => {
  const user = await findOrCreateUser({
    primaryIdp: 'microsoft',
    externalId: USER_EXISTING_EXTERNAL_ID,
    email: 'updated-on-login@example.com',
    displayName: 'Existing T5 User',
  });
  assert.equal(user.id, USER_EXISTING_ID);
  assert.equal(
    user.email,
    't5-existing@example.com',
    'email is NOT overwritten on subsequent login',
  );
});

test('findOrCreateUser: concurrent calls for same external_id resolve to same user (race-free)', async () => {
  const RACE_EXTERNAL_ID = 'microsoft:test-t6-race-oid';
  try {
    const [a, b] = await Promise.all([
      findOrCreateUser({
        primaryIdp: 'microsoft',
        externalId: RACE_EXTERNAL_ID,
        email: 'race@example.com',
        displayName: 'Race A',
      }),
      findOrCreateUser({
        primaryIdp: 'microsoft',
        externalId: RACE_EXTERNAL_ID,
        email: 'race@example.com',
        displayName: 'Race B',
      }),
    ]);
    assert.equal(a.id, b.id, 'both calls resolve to same user_id');
  } finally {
    await sql`DELETE FROM "user" WHERE external_id = ${RACE_EXTERNAL_ID}`;
  }
});

test('findOrCreateUser: bumps last_login_at on existing user', async () => {
  // postgres-js may return timestamptz as string OR Date depending on parser
  // registration timing in this workspace; normalise via new Date(...).
  const beforeRows = await sql<{ last_login_at: string | Date | null }[]>`
    SELECT last_login_at FROM "user" WHERE id = ${USER_EXISTING_ID}
  `;
  // Brief delay so timestamps differ
  await new Promise((r) => setTimeout(r, 50));
  await findOrCreateUser({
    primaryIdp: 'microsoft',
    externalId: USER_EXISTING_EXTERNAL_ID,
    email: 't5-existing@example.com',
    displayName: null,
  });
  const afterRows = await sql<{ last_login_at: string | Date | null }[]>`
    SELECT last_login_at FROM "user" WHERE id = ${USER_EXISTING_ID}
  `;
  const beforeMs = beforeRows[0]?.last_login_at
    ? new Date(beforeRows[0].last_login_at).getTime()
    : null;
  const afterMs = afterRows[0]?.last_login_at
    ? new Date(afterRows[0].last_login_at).getTime()
    : null;
  assert.notEqual(beforeMs, afterMs, 'last_login_at advances');
});

test('lookupActiveTenant: returns is_default tenant first; lists all memberships', async () => {
  const TENANT_A = '00000000-0000-4000-8000-000000000a01';
  const TENANT_B = '00000000-0000-4000-8000-000000000b01';
  const USER_T6 = '00000000-0000-4000-8000-000000000061';
  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT_A}, 'T6 Firm A', 't6-firm-a', 'mixed'),
                   (${TENANT_B}, 'T6 Firm B', 't6-firm-b', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id)
            VALUES (${USER_T6}, 't6-multi@example.com', 'microsoft', 'microsoft:test-t6-multi')`;
  // Insert tenant_user rows via privilegedSql (RLS-bypass) — same client used by lookupActiveTenant
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT_A}, ${USER_T6}, 'consultant', false),
                              (gen_random_uuid(), ${TENANT_B}, ${USER_T6}, 'admin', true)`;
  try {
    const result = await lookupActiveTenant(USER_T6);
    assert.equal(result.activeTenantId, TENANT_B, 'is_default=true wins');
    assert.equal(result.activeRole, 'admin');
    assert.equal(result.availableTenants.length, 2);
    const a = result.availableTenants.find((t) => t.tenantId === TENANT_A);
    const b = result.availableTenants.find((t) => t.tenantId === TENANT_B);
    assert.ok(a && b);
    assert.equal(b?.role, 'admin');
    assert.equal(b?.isDefault, true);
    assert.equal(a?.role, 'consultant');
    assert.equal(a?.isDefault, false);
  } finally {
    await privilegedSql`DELETE FROM tenant_user WHERE user_id = ${USER_T6}`;
    await sql`DELETE FROM "user" WHERE id = ${USER_T6}`;
    await sql`DELETE FROM tenant WHERE id IN (${TENANT_A}, ${TENANT_B})`;
  }
});

test('lookupActiveTenant: returns nulls + empty array for user with no memberships', async () => {
  const FRESH = '00000000-0000-4000-8000-000000000067';
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id)
            VALUES (${FRESH}, 't6-fresh@example.com', 'google', 'google:test-t6-fresh')`;
  try {
    const result = await lookupActiveTenant(FRESH);
    assert.equal(result.activeTenantId, null);
    assert.equal(result.activeRole, null);
    assert.deepEqual(result.availableTenants, []);
  } finally {
    await sql`DELETE FROM "user" WHERE id = ${FRESH}`;
  }
});

// ============================================================
// W3 T4 — getOrAddTenantUser tests
// ============================================================

const T4_TENANT = '00000000-0000-4000-8000-0000000a0040';
const T4_USER = '00000000-0000-4000-8000-0000000a0041';

before(async () => {
  // Idempotent seeds — survive prior-run leftovers without crashing the suite.
  // The tenant_user rows for this pair get cleaned in each test's local cleanup.
  await sql`DELETE FROM tenant_user WHERE tenant_id = ${T4_TENANT}`;
  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${T4_TENANT}, 'T4 Firm', 't4-firm-uniq-seed', 'mixed')
            ON CONFLICT (id) DO NOTHING`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id)
            VALUES (${T4_USER}, 't4-user-seed@example.com', 'microsoft', 'microsoft:t4-user-oid')
            ON CONFLICT (id) DO NOTHING`;
});

after(async () => {
  await sql`DELETE FROM tenant_user WHERE tenant_id = ${T4_TENANT}`;
  await sql`DELETE FROM "user" WHERE id = ${T4_USER}`;
  await sql`DELETE FROM tenant WHERE id = ${T4_TENANT}`;
  // Final teardown — close pools after all other after() hooks have run.
  await sql.end();
  await privilegedSql.end();
});

test('getOrAddTenantUser: creates new row when none exists', async () => {
  const result = await getOrAddTenantUser({
    tenantId: T4_TENANT,
    userId: T4_USER,
    role: 'consultant',
    isDefault: false,
  });
  assert.equal(result.status, 'created');
  assert.equal(result.row.tenantId, T4_TENANT);
  assert.equal(result.row.userId, T4_USER);
  assert.equal(result.row.role, 'consultant');
  assert.equal(result.row.isDefault, false);

  // Cleanup for subsequent test
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id = ${T4_TENANT} AND user_id = ${T4_USER}`;
});

test('getOrAddTenantUser: returns already_member when row exists & not deleted', async () => {
  await getOrAddTenantUser({
    tenantId: T4_TENANT,
    userId: T4_USER,
    role: 'consultant',
    isDefault: false,
  });
  // Second call — same row exists
  const result = await getOrAddTenantUser({
    tenantId: T4_TENANT,
    userId: T4_USER,
    role: 'admin', // requested change is IGNORED on already_member path
    isDefault: true,
  });
  assert.equal(result.status, 'already_member');
  assert.equal(
    result.row.role,
    'consultant',
    'existing role preserved (caller sees what is, not what was asked)',
  );
  assert.equal(result.row.isDefault, false);

  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id = ${T4_TENANT} AND user_id = ${T4_USER}`;
});

test('getOrAddTenantUser: undeletes + applies new role/isDefault when row exists & soft-deleted', async () => {
  // Seed: insert + soft-delete
  await getOrAddTenantUser({
    tenantId: T4_TENANT,
    userId: T4_USER,
    role: 'viewer',
    isDefault: false,
  });
  await privilegedSql`UPDATE tenant_user SET deleted_at = NOW() WHERE tenant_id = ${T4_TENANT} AND user_id = ${T4_USER}`;

  const result = await getOrAddTenantUser({
    tenantId: T4_TENANT,
    userId: T4_USER,
    role: 'admin',
    isDefault: true,
  });
  assert.equal(result.status, 'undeleted');
  assert.equal(result.row.role, 'admin', 'new role applied on undelete');
  assert.equal(result.row.isDefault, true, 'new isDefault applied on undelete');

  // Verify deleted_at really is NULL
  const check = await privilegedSql<{ deleted_at: Date | null }[]>`
    SELECT deleted_at FROM tenant_user WHERE tenant_id = ${T4_TENANT} AND user_id = ${T4_USER}
  `;
  assert.equal(check[0]?.deleted_at, null);

  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id = ${T4_TENANT} AND user_id = ${T4_USER}`;
});

test('getOrAddTenantUser: concurrent calls converge — only one row created (race-safe)', async () => {
  const [a, b] = await Promise.all([
    getOrAddTenantUser({
      tenantId: T4_TENANT,
      userId: T4_USER,
      role: 'consultant',
      isDefault: false,
    }).catch((err) => ({ error: err as Error })),
    getOrAddTenantUser({
      tenantId: T4_TENANT,
      userId: T4_USER,
      role: 'consultant',
      isDefault: false,
    }).catch((err) => ({ error: err as Error })),
  ]);

  // Postgres serializable: one will succeed (created), the other will either
  // succeed (already_member after the first commits) OR error with a
  // unique-violation. Both outcomes are race-safe.
  // What we MUST NOT see: two created rows. Verify with a count.
  const count = await privilegedSql<{ n: string }[]>`
    SELECT COUNT(*)::text AS n FROM tenant_user
    WHERE tenant_id = ${T4_TENANT} AND user_id = ${T4_USER} AND deleted_at IS NULL
  `;
  assert.equal(count[0]?.n, '1', 'exactly one active membership row exists');

  // At least one of a/b succeeded
  const aOk = !('error' in a);
  const bOk = !('error' in b);
  assert.ok(aOk || bOk, 'at least one call succeeded');

  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id = ${T4_TENANT} AND user_id = ${T4_USER}`;
});
