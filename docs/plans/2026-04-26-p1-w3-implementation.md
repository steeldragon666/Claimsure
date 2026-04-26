# P1 W3 — Tenant & User Endpoints Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute this plan task-by-task.

**Goal:** Ship `/v1/tenants/*` + `/v1/users/*` endpoints — tenant switching, firm-membership management — on top of the W2 auth + RLS infrastructure.

**Architecture:** New routes in `apps/api/src/routes/{tenants,users}/`. New helper module `packages/auth/src/authorize.ts` for `requireSession` + `requireAdmin` preHandlers. New helper `getOrAddTenantUser` in `@cpa/auth/users.ts` for race-safe membership management. New `@cpa/schemas` modules for `TenantRef` + `UserRef`. Migration 0005 adds a partial unique index to `tenant_user`.

**Tech Stack:** Same as W2 — Fastify 5, fastify-type-provider-zod, jose, postgres-js, @cpa/auth. No new packages.

**Source design:** [P1 W3 design](./2026-04-26-p1-w3-tenant-and-user-endpoints-design.md), all 5 decisions locked.

**Branch:** Continue on `p1/identity-tenancy` (currently at `0d5bb88`). No new branch.

---

## Task graph (swarm-friendly)

```
T1 (migration 0005)               — solo, prerequisites for T6
T2 (@cpa/schemas TenantRef + UserRef)  — solo, prerequisites for routes
T3 (authorize.ts hooks)           — solo, prerequisites for routes
Batch A (T4 + T5):
  T4 (getOrAddTenantUser helper)  — parallel
  T5 (GET /v1/tenants)            — parallel (depends only on existing lookupActiveTenant)
T6 (POST /v1/tenants/switch)      — solo (uses signSession with possibly-changed JWT shape)
Batch B (T7 + T8 + T9):
  T7 (GET /v1/users + GET /v1/users/:id)  — parallel
  T8 (POST /v1/users)             — parallel (depends on T4)
  T9 (PATCH /v1/users/:id)        — parallel (depends on T4 for last-admin check?)
T10 (DELETE /v1/users/:id with last-admin guard)  — solo
T11 (integration tests covering tenant switch + user CRUD round-trip)  — solo
T12 (cold-start verify + push)    — solo
```

12 tasks total. Roughly 5 phases:
1. Foundations (T1+T2+T3): migration + schemas + authorize hooks
2. Tenant routes (T4 + T5 parallel; T6 solo)
3. User routes (T7+T8+T9 parallel; T10 solo)
4. Verification (T11 + T12)

---

## Pre-flight checklist

- [ ] Working in `cpa-platform-worktrees/p1/` on `p1/identity-tenancy` at `0d5bb88` (or later)
- [ ] Postgres up, all 4 migrations applied (0000-0004)
- [ ] All W2 tests pass: `pnpm test` should report ~64 tests
- [ ] `.env` has DATABASE_URL_APP set

---

## Task 1: Migration 0005 — partial unique index on `tenant_user(tenant_id, user_id)`

**Why first:** T4's `getOrAddTenantUser` and T8's POST /v1/users use ON CONFLICT against this index.

**Files:**
- Create: `packages/db/migrations/0005_tenant_user_active_uniq.sql`
- Modify: `packages/db/migrations/meta/_journal.json`

**Step 1: Write the migration**

```sql
-- 0005_tenant_user_active_uniq.sql
-- Partial unique index on (tenant_id, user_id) for non-deleted membership rows.
--
-- Why: T4's getOrAddTenantUser uses INSERT ... ON CONFLICT (tenant_id, user_id)
-- DO UPDATE to be race-safe across concurrent admin operations. ON CONFLICT
-- needs a unique target. The partial filter (deleted_at IS NULL) means
-- soft-deleted memberships don't block re-adding the same user.
--
-- This mirrors migration 0004's pattern on the user table.

CREATE UNIQUE INDEX "tenant_user_active_uniq"
  ON "tenant_user" (tenant_id, user_id)
  WHERE deleted_at IS NULL;
```

**Step 2: Append journal entry**

```json
{
  "idx": 5,
  "version": "7",
  "when": <Date.now()>,
  "tag": "0005_tenant_user_active_uniq",
  "breakpoints": true
}
```

**Step 3: Apply + verify**

```bash
pnpm --filter @cpa/db migrate
docker exec cpa-postgres psql -U cpa -d cpa_dev -c "SELECT indexname FROM pg_indexes WHERE tablename='tenant_user' AND indexname='tenant_user_active_uniq';"
# expects 1 row
```

**Step 4: Commit**

---

## Task 2: `@cpa/schemas` — `TenantRef` + `UserRef`

**Files:**
- Create: `packages/schemas/src/tenant.ts`
- Create: `packages/schemas/src/user.ts`
- Modify: `packages/schemas/src/index.ts`

**Step 1: Write TenantRef**

```ts
// packages/schemas/src/tenant.ts
import { z } from 'zod';
import { Uuid } from './primitives.js';

export const RoleEnum = z.enum(['admin', 'consultant', 'viewer']);
export type Role = z.infer<typeof RoleEnum>;

export const TenantRef = z.object({
  id: Uuid,
  name: z.string().min(1),
  slug: z.string().min(1),
  role: RoleEnum,
  isDefault: z.boolean(),
});
export type TenantRef = z.infer<typeof TenantRef>;
```

**Step 2: Write UserRef**

```ts
// packages/schemas/src/user.ts
import { z } from 'zod';
import { Uuid, Iso8601 } from './primitives.js';
import { RoleEnum } from './tenant.js';

export const UserRef = z.object({
  id: Uuid,
  email: z.string().email(),
  displayName: z.string().nullable(),
  role: RoleEnum,
  isDefault: z.boolean(),
  addedAt: Iso8601,    // tenant_user.created_at
});
export type UserRef = z.infer<typeof UserRef>;
```

**Step 3: Append index.ts**

```ts
export * from './tenant.js';
export * from './user.js';
```

**Step 4: Verify gates + commit**

---

## Task 3: `@cpa/auth/authorize.ts` — preHandler hooks

**Files:**
- Create: `packages/auth/src/authorize.ts`
- Create: `packages/auth/src/authorize.test.ts`
- Modify: `packages/auth/src/index.ts`

**Step 1: Write tests FIRST**

```ts
// authorize.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { requireSession, requireAdmin } from './authorize.js';

test('requireSession: 401 when no req.user', async () => {
  const app = Fastify({ logger: false });
  app.get('/x', { preHandler: requireSession }, async () => ({ ok: true }));
  const res = await app.inject({ method: 'GET', url: '/x' });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('requireSession: 403 when req.user has no active tenant', async () => {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (req) => {
    req.user = { id: 'u', email: 'e', tenantId: null, role: null };
  });
  app.get('/x', { preHandler: requireSession }, async () => ({ ok: true }));
  const res = await app.inject({ method: 'GET', url: '/x' });
  assert.equal(res.statusCode, 403);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'no_active_tenant');
  await app.close();
});

test('requireAdmin: 403 when role !== admin', async () => {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (req) => {
    req.user = { id: 'u', email: 'e', tenantId: 't', role: 'consultant' };
  });
  app.get('/x', { preHandler: requireAdmin }, async () => ({ ok: true }));
  const res = await app.inject({ method: 'GET', url: '/x' });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('requireAdmin: passes when role === admin', async () => {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (req) => {
    req.user = { id: 'u', email: 'e', tenantId: 't', role: 'admin' };
  });
  app.get('/x', { preHandler: requireAdmin }, async () => ({ ok: true }));
  const res = await app.inject({ method: 'GET', url: '/x' });
  assert.equal(res.statusCode, 200);
  await app.close();
});
```

**Step 2: Implement**

(Per design doc; ~25 lines.)

**Step 3: Update barrel + commit**

---

## Task 4: `getOrAddTenantUser` helper in `@cpa/auth/users.ts`

**Why:** POST /v1/users + (optionally) PATCH /v1/users use this to add or un-soft-delete a `tenant_user` row race-safely.

**Files:**
- Modify: `packages/auth/src/users.ts`
- Modify: `packages/auth/src/users.test.ts` (add tests)

**Function signature:**

```ts
export interface GetOrAddTenantUserInput {
  tenantId: string;
  userId: string;
  role: 'admin' | 'consultant' | 'viewer';
  isDefault: boolean;
}

export interface GetOrAddTenantUserResult {
  row: {
    id: string;
    tenantId: string;
    userId: string;
    role: 'admin' | 'consultant' | 'viewer';
    isDefault: boolean;
    addedAt: Date;
  };
  status: 'created' | 'undeleted' | 'already_member';
}

export async function getOrAddTenantUser(
  input: GetOrAddTenantUserInput,
): Promise<GetOrAddTenantUserResult>;
```

**Step 1: Write 4 tests**
- creates new (status='created')
- finds existing non-deleted (status='already_member')
- un-soft-deletes (status='undeleted')
- concurrent calls converge (Promise.all → no duplicate row, both see consistent result)

**Step 2: Implement using `sql.begin()` for the SELECT-then-branch transaction**

> **Implementer note:** Tenant_user is RLS-protected. The active tenant must be set in the connection's `app.current_tenant_id` GUC. Pass `tenantId` as the GUC value at the start of the transaction. Do not use `privilegedSql` here — we want the RLS guarantee to verify the membership belongs to the active tenant.

**Step 3: Commit**

---

## Task 5: `GET /v1/tenants` — list user's available tenants

**Files:**
- Create: `apps/api/src/routes/tenants/list.ts`
- Create: `apps/api/src/routes/tenants/list.test.ts`
- Modify: `apps/api/src/app.ts` (register)

**Implementation:** wraps `lookupActiveTenant(req.user.id)`, returns `{ activeTenantId, availableTenants[] }`. preHandler is `requireSession`. ~15 lines.

---

## Task 6: `POST /v1/tenants/switch` — re-issue JWT with new active tenant

**Files:**
- Create: `apps/api/src/routes/tenants/switch.ts`
- Create: `apps/api/src/routes/tenants/switch.test.ts`
- Modify: `apps/api/src/app.ts`

**Implementation:** validates body `{ tenantId: uuid }`, re-fetches memberships via `lookupActiveTenant` (don't trust cookie's stale list), verifies `tenantId` is in the list, signs new JWT, sets new `cpa_session` cookie, returns `{ user, activeTenant, availableTenants }`. ~50 lines.

**Tests:** happy path; 404 when tenant not in user's memberships; 400 when body shape invalid.

---

## Task 7: `GET /v1/users` + `GET /v1/users/:id`

**Files:**
- Create: `apps/api/src/routes/users/list.ts`
- Create: `apps/api/src/routes/users/get.ts`
- Tests + register.

**Query:** uses `req.tx` or `sql` (RLS-scoped to current tenant via session middleware's GUC). Returns `UserRef[]`.

---

## Task 8: `POST /v1/users`

**Files:**
- Create: `apps/api/src/routes/users/add.ts`
- Tests + register.

**Behavior:** look up user by email via `privilegedSql` (no tenant scope); if missing 404; else call `getOrAddTenantUser`. Returns 201 + UserRef on `created` or `undeleted`; 409 on `already_member`.

---

## Task 9: `PATCH /v1/users/:id`

**Files:**
- Create: `apps/api/src/routes/users/update.ts`
- Tests + register.

**Behavior:** validate body `{ role?, isDefault? }`. If body has `role` and target is the LAST admin and new role !== 'admin' → 409 last_admin. If body has `isDefault: true` → unset `is_default` on all other tenant_user rows for THIS user (across THIS firm only — actually `is_default` is per `(tenant, user)` pair so it's already scoped). Then UPDATE.

---

## Task 10: `DELETE /v1/users/:id`

**Files:**
- Create: `apps/api/src/routes/users/remove.ts`
- Tests + register.

**Behavior:** if target is the LAST admin → 409 last_admin. Else `UPDATE tenant_user SET deleted_at = NOW()`. Returns 204.

---

## Task 11: Integration smoke test — full tenant-switch + user-CRUD round-trip

**Files:**
- Create: `apps/api/src/routes/tenants/switch.integration.test.ts`

**Scenario:**
1. Sign-in user (use `signSession` directly; skip OIDC for this test)
2. Seed 2 tenants, 1 user with admin in both, 1 user with consultant in tenant A only
3. GET /v1/tenants → both tenants visible
4. POST /v1/tenants/switch to tenant B → 200 + new cookie
5. GET /v1/users (now scoped to tenant B) → only the admin visible (tenant A's consultant is filtered out by RLS)
6. POST /v1/users with the consultant's email → adds them to tenant B as consultant
7. GET /v1/users → 2 rows now
8. DELETE /v1/users/:consultant-id → 204
9. GET /v1/users?includeDeleted=true → 2 rows; without flag, 1 row

This single test exercises the entire W3 surface end-to-end.

---

## Task 12: Cold-start verify + push

```bash
pnpm install --frozen-lockfile && pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm format:check
git push origin p1/identity-tenancy
```

Test count target: ~86 across 5 packages.

---

## W3 Acceptance criteria

- [x] Migration 0005 applied
- [x] @cpa/schemas: TenantRef + UserRef
- [x] @cpa/auth: requireSession + requireAdmin + getOrAddTenantUser
- [x] /v1/tenants/* endpoints
- [x] /v1/users/* endpoints with admin gating
- [x] Last-admin protection (409) on demote and delete
- [x] Soft-delete + un-soft-delete via getOrAddTenantUser
- [x] Integration smoke test passing
- [x] Cold-start green; pushed; CI green

## Out of scope (carried)

- Email-based invitations (P3+)
- Tenant CREATE/UPDATE/DELETE endpoints (CLI seed for P1; admin UI in W4 + P2)
- Audit log (P2)
- Rate limiting (P3)
- 2FA / step-up auth on admin actions (P3+)

## Estimated time

- 1 focused autonomous-loop pass (3-4 hours wall-clock with swarm)
