import { sql, privilegedSql } from '@cpa/db/client';

export interface FindOrCreateUserInput {
  primaryIdp: 'microsoft' | 'google';
  externalId: string;
  email: string;
  displayName: string | null;
}

export interface UserRow {
  id: string;
  email: string;
  displayName: string | null;
  primaryIdp: 'microsoft' | 'google';
  externalId: string;
}

export interface AvailableTenantRow {
  tenantId: string;
  name: string;
  slug: string;
  role: 'admin' | 'consultant' | 'viewer';
  isDefault: boolean;
}

export interface ActiveTenantResult {
  activeTenantId: string | null;
  activeRole: 'admin' | 'consultant' | 'viewer' | null;
  availableTenants: AvailableTenantRow[];
}

/**
 * Look up a user by (primaryIdp, externalId). If found, bump
 * last_login_at to NOW() and return. If not found, INSERT and return.
 *
 * email + displayName from the IdP are used ONLY when creating; we
 * deliberately do NOT update them on subsequent logins. Rationale:
 * a malicious IdP-side rename should not change our authoritative
 * email — the audit trail anchors on it.
 *
 * Note: user table is GLOBAL (no RLS) — direct sql writes work as cpa_app.
 *
 * Race-safety: the `user` table has TWO unique constraints we have to
 * handle for concurrent-login correctness:
 *   1. partial unique index on (primary_idp, external_id) WHERE
 *      deleted_at IS NULL  — handled by `ON CONFLICT (...)`.
 *   2. unique constraint on `email` (`user_email_unique`)  — NOT
 *      reachable from a single ON CONFLICT (Postgres has no syntax for
 *      multi-target ON CONFLICT).
 *
 * When two concurrent OIDC logins for the same user (same external_id +
 * same email) hit different DB connections within ~1ms, both INSERTs
 * see no `(primary_idp, external_id)` row yet (neither has committed)
 * and try to insert. The first one wins; the second one is rejected by
 * `user_email_unique` BEFORE the ON CONFLICT branch can run. Without
 * recovery, the second login returns 500 in production.
 *
 * Recovery: catch the email-unique violation and run an UPDATE-RETURNING
 * scoped to (primary_idp, external_id, deleted_at IS NULL) — this both
 * bumps last_login_at AND returns the row, identical to the lucky-path
 * ON CONFLICT branch in one roundtrip (vs. SELECT-then-UPDATE which
 * races against a third concurrent caller).
 *
 * If recovery returns no row, that means we hit `user_email_unique` for
 * a DIFFERENT user (two distinct external_ids trying to claim the same
 * email — a real integrity error, not a race). We re-throw.
 *
 * Concurrency: wrapped in `sql.begin` with `pg_advisory_xact_lock(hashtext(...))`
 * keyed on `(primary_idp, external_id)`. Concurrent same-user logins are
 * serialized at the DB layer, eliminating the pg-pool scheduling artefact
 * that previously caused intermittent flakes (see
 * docs/plans/2026-05-05-ci-test-isolation-design.md). Different external_ids
 * hash to different lock keys → still parallelize.
 */
export async function findOrCreateUser(input: FindOrCreateUserInput): Promise<UserRow> {
  return await sql.begin(async (tx) => {
    // Serialize concurrent same-user logins at the DB layer.
    //
    // hashtext() is deterministic and produces a 32-bit int. Collisions
    // across different (primary_idp, external_id) pairs are harmless: the
    // worst case is two unrelated logins serialize on the same lock key
    // momentarily — no correctness impact, only a tiny throughput penalty
    // for that pair.
    //
    // Why advisory lock instead of relying on ON CONFLICT alone: the
    // existing impl has TWO unique constraints to handle (primary_idp +
    // external_id, AND user_email_unique). Under pg-pool scheduling
    // pressure the email-unique recovery branch occasionally surfaces,
    // and intermittently the recovery query sees state that confuses it.
    // The advisory lock makes only ONE caller per (idp, external_id)
    // active at a time, eliminating the pg-pool-dependent timing entirely.
    //
    // pg_advisory_xact_lock is xact-scoped: postgres releases the lock
    // automatically at COMMIT or ROLLBACK. There is no manual release path.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`${input.primaryIdp}:${input.externalId}`}))`;

    const newId = crypto.randomUUID();
    try {
      const rows = await tx<UserRow[]>`
        INSERT INTO "user" (id, email, display_name, primary_idp, external_id, last_login_at)
        VALUES (${newId}, ${input.email}, ${input.displayName}, ${input.primaryIdp}, ${input.externalId}, NOW())
        ON CONFLICT (primary_idp, external_id) WHERE deleted_at IS NULL
        DO UPDATE SET last_login_at = NOW()
        RETURNING id, email, display_name AS "displayName", primary_idp AS "primaryIdp", external_id AS "externalId"
      `;
      if (!rows[0]) throw new Error('findOrCreateUser: INSERT/ON CONFLICT did not return a row');
      return rows[0];
    } catch (err) {
      if (!isEmailUniqueViolation(err)) throw err;
      // Lost the race on user_email_unique. The other concurrent caller's
      // row is already committed; UPDATE-RETURNING produces the same end
      // state as the lucky-path ON CONFLICT branch (bump last_login_at +
      // return row).
      const recovered = await tx<UserRow[]>`
        UPDATE "user"
           SET last_login_at = NOW()
         WHERE primary_idp = ${input.primaryIdp}
           AND external_id = ${input.externalId}
           AND deleted_at IS NULL
        RETURNING id, email, display_name AS "displayName", primary_idp AS "primaryIdp", external_id AS "externalId"
      `;
      if (!recovered[0]) {
        // No matching (primary_idp, external_id) row → the email collision
        // is between two DIFFERENT users, not a race. Real integrity
        // violation; re-throw the original error.
        throw err;
      }
      return recovered[0];
    }
  });
}

/**
 * Detect a postgres-js unique-violation error specifically on the
 * `user_email_unique` constraint. SQLSTATE 23505 is the unique-violation
 * code. We check both `constraint_name` (when populated by postgres-js)
 * and the message text, so this remains correct across postgres-js
 * versions and across DBs where constraint metadata may be missing.
 */
function isEmailUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; constraint_name?: unknown; message?: unknown };
  if (e.code !== '23505') return false;
  if (e.constraint_name === 'user_email_unique') return true;
  return typeof e.message === 'string' && e.message.includes('user_email_unique');
}

interface PrivilegedTenantUserRow {
  tenant_id: string;
  name: string;
  slug: string;
  role: 'admin' | 'consultant' | 'viewer';
  is_default: boolean;
}

/**
 * Look up the user's active tenant + all firms they belong to.
 *
 * Privileged query — bypasses RLS so we can see the user's memberships
 * across all tenants. THIS function determines the tenant scope; it
 * cannot itself be tenant-scoped.
 *
 * Active = the row with is_default=true if present, else the
 * earliest-created row.
 */
export async function lookupActiveTenant(userId: string): Promise<ActiveTenantResult> {
  const rows = await privilegedSql<PrivilegedTenantUserRow[]>`
    SELECT tu.tenant_id, t.name, t.slug, tu.role, tu.is_default
      FROM tenant_user tu
      JOIN tenant t ON t.id = tu.tenant_id AND t.deleted_at IS NULL
     WHERE tu.user_id = ${userId}
       AND tu.deleted_at IS NULL
     ORDER BY tu.is_default DESC, tu.created_at ASC
  `;

  const availableTenants = rows.map((r) => ({
    tenantId: r.tenant_id,
    name: r.name,
    slug: r.slug,
    role: r.role,
    isDefault: r.is_default,
  }));

  const active = availableTenants[0] ?? null;
  return {
    activeTenantId: active?.tenantId ?? null,
    activeRole: active?.role ?? null,
    availableTenants,
  };
}

export interface GetOrAddTenantUserInput {
  tenantId: string;
  userId: string;
  role: 'admin' | 'consultant' | 'viewer';
  isDefault: boolean;
}

export interface TenantUserRow {
  id: string;
  tenantId: string;
  userId: string;
  role: 'admin' | 'consultant' | 'viewer';
  isDefault: boolean;
  addedAt: Date | string;
}

export interface GetOrAddTenantUserResult {
  row: TenantUserRow;
  status: 'created' | 'undeleted' | 'already_member';
}

interface RawTenantUserRow {
  id: string;
  tenant_id: string;
  user_id: string;
  role: 'admin' | 'consultant' | 'viewer';
  is_default: boolean;
  deleted_at: Date | string | null;
  created_at: Date | string;
}

const toCamel = (r: RawTenantUserRow): TenantUserRow => ({
  id: r.id,
  tenantId: r.tenant_id,
  userId: r.user_id,
  role: r.role,
  isDefault: r.is_default,
  addedAt: r.created_at,
});

/**
 * Add a user to a tenant, or undelete + re-role them if they were
 * previously soft-deleted, or report 'already_member' if a non-deleted
 * row exists.
 *
 * SELECT-then-branch inside a single sql.begin transaction:
 *   - if no row: INSERT new
 *   - if row exists & deleted_at IS NULL: 'already_member' (caller decides
 *     whether 409 or no-op)
 *   - if row exists & soft-deleted: UPDATE deleted_at=NULL + new role + isDefault
 *
 * The transaction sets app.current_tenant_id to the input tenantId via
 * SET LOCAL so RLS USING + WITH CHECK both pass for that tenant. Caller
 * (route handler) is responsible for ensuring tenantId === req.user.tenantId
 * before calling — this helper trusts its caller.
 *
 * Race-safety: the partial unique index on (tenant_id, user_id) WHERE
 * deleted_at IS NULL (migration 0005) means concurrent INSERTs for the
 * same pair don't both succeed. The second one fails with a unique-
 * violation error; the route handler retries by re-running the SELECT
 * branch.
 */
export async function getOrAddTenantUser(
  input: GetOrAddTenantUserInput,
): Promise<GetOrAddTenantUserResult> {
  return await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${input.tenantId}, true)`;

    const existing = await tx<RawTenantUserRow[]>`
      SELECT id, tenant_id, user_id, role, is_default, deleted_at, created_at
        FROM tenant_user
       WHERE tenant_id = ${input.tenantId} AND user_id = ${input.userId}
       FOR UPDATE
    `;

    if (existing[0]) {
      if (existing[0].deleted_at === null) {
        return { row: toCamel(existing[0]), status: 'already_member' as const };
      }
      const updated = await tx<RawTenantUserRow[]>`
        UPDATE tenant_user
           SET deleted_at = NULL,
               role = ${input.role},
               is_default = ${input.isDefault}
         WHERE id = ${existing[0].id}
        RETURNING id, tenant_id, user_id, role, is_default, deleted_at, created_at
      `;
      if (!updated[0]) throw new Error('getOrAddTenantUser: undelete UPDATE returned no row');
      return { row: toCamel(updated[0]), status: 'undeleted' as const };
    }

    const newId = crypto.randomUUID();
    const created = await tx<RawTenantUserRow[]>`
      INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
      VALUES (${newId}, ${input.tenantId}, ${input.userId}, ${input.role}, ${input.isDefault})
      RETURNING id, tenant_id, user_id, role, is_default, deleted_at, created_at
    `;
    if (!created[0]) throw new Error('getOrAddTenantUser: INSERT returned no row');
    return { row: toCamel(created[0]), status: 'created' as const };
  });
}
