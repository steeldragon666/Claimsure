# P1 W3 — Tenant & User Endpoints Design

**Status:** Approved (autonomous-loop locked) 2026-04-26
**Builds on:** [ADR-0002](../decisions/0002-identity-and-tenancy.md), [W2 design](./2026-04-26-p1-w2-auth-design.md)
**Authors:** Aaron Newson + AI pair (Claude Opus 4.7)

## Goal

Wrap the W2 auth-and-RLS plumbing with HTTP endpoints that let consultant firms self-serve their tenant + user data: switch active tenant mid-session; admin users add / re-role / soft-delete other firm members. No new infrastructure — just routes + zod schemas + integration tests on top of what W2 already shipped.

## Decisions (locked autonomously per ADR-0002 patterns)

### Q1 — Tenant switch: re-issue JWT vs force re-login

Re-issue. The session JWT already carries `availableTenants[]` (the user's full membership list), so the server has everything it needs to re-sign with a different `activeTenantId`. No DB roundtrip required for the switch itself; just verify the requested `tenantId` is in `availableTenants` and re-sign.

**Endpoint:** `POST /v1/tenants/switch` body `{ tenantId: uuid }` → 200 + new `cpa_session` cookie + JSON body containing the new whoami shape.

### Q2 — User-add by email vs user_id; behavior when invitee doesn't exist

By email. Admins know their colleagues' emails; user IDs are internal. If the email doesn't match any existing user (i.e., they haven't OIDC-logged-in yet), return **404** with a clear message: `"User not found — ask them to sign in once via Microsoft or Google, then retry"`.

This deliberately avoids invitation/email-send infrastructure for P1. Email-based invitations land in P3+ when product-market-fit signals justify it. The 404 + hint is a workable UX for the early stage (consultants will help colleagues directly, "Hey can you log in real quick before I add you to the firm").

**Endpoint:** `POST /v1/users` body `{ email: string, role: 'admin' | 'consultant' | 'viewer', isDefault?: boolean }` → 201 with the created `tenant_user` row, or 404 with the hint.

### Q3 — Authorization granularity

- `/v1/tenants/*` — any authenticated user (must be a member of at least one tenant; enforced by `req.user.tenantId !== null` precondition or 403)
- `/v1/users/*` — only users with `admin` role on the active firm (`req.user.role === 'admin'`); otherwise 403

The `tenant_user.role` enum's `admin` value already exists. The middleware just needs to read `req.user.role` (set by sessionPlugin from the JWT's `activeRole` claim). Enforcement via a small Fastify hook in W3.

### Q4 — Soft-delete vs hard-delete on `DELETE /v1/users/:id`

Soft-delete only. Sets `tenant_user.deleted_at = NOW()` for the row corresponding to that user in the active firm. The user's underlying `user` row is untouched (they may belong to other firms). Re-adding a soft-deleted user (same email) should bump `deleted_at = NULL` rather than create a duplicate row — uses an `ON CONFLICT (tenant_id, user_id) DO UPDATE SET deleted_at = NULL, role = ?` pattern (parallel to the W2 race-fix on `findOrCreateUser`).

**Endpoint:** `DELETE /v1/users/:id` → 204; the user can no longer access the firm but their other firm memberships and audit history remain.

Permanent deletion → P3+ (audit-log compliance considerations).

### Q5 — Last-admin protection on demote / delete

Yes — protect. Refuse a `PATCH /v1/users/:id` that demotes the LAST admin of a firm, and refuse a `DELETE /v1/users/:id` that removes the LAST admin. Otherwise the firm becomes unmanageable. Returns **409 Conflict** with `{error: 'last_admin', message: 'Cannot remove or demote the only firm admin. Promote another user first.'}`.

The check is a single `SELECT COUNT(*)` over `tenant_user WHERE role='admin' AND deleted_at IS NULL`. If the count is 1 and the target row is THAT row, refuse.

This is a non-negotiable safety rail — without it a single buggy admin click bricks the firm.

## Architecture

### Routes

| Method | Path | Auth | Body / Params |
|---|---|---|---|
| GET    | `/v1/tenants` | session+tenant | — |
| POST   | `/v1/tenants/switch` | session+tenant | `{ tenantId: uuid }` |
| GET    | `/v1/users` | session+admin | `?role=...&includeDeleted=...` (query) |
| POST   | `/v1/users` | session+admin | `{ email, role, isDefault? }` |
| GET    | `/v1/users/:userId` | session+admin | `:userId` |
| PATCH  | `/v1/users/:userId` | session+admin | `{ role?, isDefault? }` |
| DELETE | `/v1/users/:userId` | session+admin | `:userId` |

### New components

```
apps/api/src/routes/
├── tenants/
│   ├── list.ts          — GET /v1/tenants
│   ├── switch.ts        — POST /v1/tenants/switch
│   └── *.test.ts
└── users/
    ├── list.ts          — GET /v1/users
    ├── add.ts           — POST /v1/users
    ├── get.ts           — GET /v1/users/:userId
    ├── update.ts        — PATCH /v1/users/:userId
    ├── remove.ts        — DELETE /v1/users/:userId
    └── *.test.ts

packages/auth/src/
└── authorize.ts          — small helpers: requireSession() and requireAdmin() preHandler hooks
```

### `@cpa/schemas` additions

```
packages/schemas/src/
├── tenant.ts             — TenantRef (id, name, slug, role)
├── user.ts               — UserRef (id, email, displayName, role, isDefault, addedAt)
└── index.ts              — re-exports
```

These get re-used by the route handlers via fastify-type-provider-zod. The W2 design's `WhoamiResponse` schema (currently inline) gets formalised here too.

### Authorization helpers

`packages/auth/src/authorize.ts`:

```ts
import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';

/**
 * preHandler that 401s if no session, 403 if session has no active tenant
 * (e.g. user just logged in but has zero tenant_user rows).
 */
export const requireSession: preHandlerHookHandler = async (req, reply) => {
  if (!req.user) {
    return reply.status(401).send({ error: 'unauthenticated', message: 'No session' });
  }
  if (req.user.tenantId === null) {
    return reply.status(403).send({ error: 'no_active_tenant', message: 'No active firm' });
  }
};

/**
 * preHandler that runs requireSession plus 403 if user.role !== 'admin'.
 */
export const requireAdmin: preHandlerHookHandler = async (req, reply) => {
  if (!req.user) {
    return reply.status(401).send({ error: 'unauthenticated', message: 'No session' });
  }
  if (req.user.role !== 'admin') {
    return reply.status(403).send({ error: 'forbidden', message: 'Admin role required' });
  }
};
```

Routes attach via `app.get('/v1/users', { preHandler: requireAdmin }, handler)`.

### `/v1/tenants/switch` implementation sketch

```ts
app.post('/v1/tenants/switch', { preHandler: requireSession }, async (req, reply) => {
  const { tenantId } = parseBody(req); // { tenantId: uuid }

  // Pull fresh memberships — don't trust the cookie's stale list
  const active = await lookupActiveTenant(req.user!.id);
  const target = active.availableTenants.find(t => t.tenantId === tenantId);
  if (!target) {
    return reply.status(404).send({ error: 'tenant_not_found', message: 'Not a member of that firm' });
  }

  const jwt = await signSession({
    sub: req.user!.id,
    email: req.user!.email,
    primaryIdp: /* re-derive from user table or stash on req */,
    activeTenantId: target.tenantId,
    activeRole: target.role,
    availableTenants: active.availableTenants.map(stripIsDefault),
  }, sessionSecret, { ttlSeconds });

  reply.header('set-cookie', sessionCookieValue(jwt, ...));
  return { user: { ... }, activeTenant: target, availableTenants: active.availableTenants };
});
```

### `/v1/users` POST implementation sketch (the trickiest one)

```ts
app.post('/v1/users', { preHandler: requireAdmin }, async (req, reply) => {
  const { email, role, isDefault = false } = parseBody(req);
  const tenantId = req.user!.tenantId!;

  // Find user by email — need privilegedSql because tenant_user search is RLS-scoped
  // but user table is not. Email is unique on user table.
  const userRows = await privilegedSql<{ id: string }[]>`
    SELECT id FROM "user" WHERE email = ${email} AND deleted_at IS NULL
  `;
  if (!userRows[0]) {
    return reply.status(404).send({
      error: 'user_not_found',
      message: 'User not found — ask them to sign in once via Microsoft or Google, then retry',
    });
  }

  // Add or undelete tenant_user row. Uses cpa_app's session — RLS WITH CHECK
  // needs app.current_tenant_id GUC set, which the session middleware did.
  // Concurrent re-adds are race-safe via the unique index on (tenant_id, user_id)
  // (added in T1 of W3 — see plan).
  const newId = crypto.randomUUID();
  const inserted = await sql`
    INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
    VALUES (${newId}, ${tenantId}, ${userRows[0].id}, ${role}, ${isDefault})
    ON CONFLICT (tenant_id, user_id) WHERE deleted_at IS NULL DO NOTHING
    ON CONFLICT (tenant_id, user_id) DO UPDATE SET deleted_at = NULL, role = ${role}, is_default = ${isDefault}
    RETURNING id, tenant_id, user_id, role, is_default
  `;
  // ⚠️ Postgres doesn't support multiple ON CONFLICT clauses in one statement. Resolution:
  // The unique index is partial (WHERE deleted_at IS NULL). On the second insert when
  // a non-deleted row exists, we collide → DO NOTHING, but we want DO UPDATE to bump.
  // Real implementation: SELECT first, then either INSERT (new) or UPDATE (existing — un-soft-delete or re-role).

  return reply.status(201).send({ /* ...UserRef shape... */ });
});
```

> **Implementer note:** the ON CONFLICT story above is over-simplified. Real impl: SELECT first to see if a `tenant_user` row exists for `(tenantId, user.id)`, branch:
> - If exists & non-deleted: 409 conflict (already a member)
> - If exists & soft-deleted: UPDATE to un-delete + new role
> - If missing: INSERT new row
>
> Race-safety: wrap the SELECT + branch in `sql.begin()` so it's a single transaction with row locks. Or rely on the unique index + retry-on-conflict.

## Data model — migration 0005

Add a partial unique index on `tenant_user`:

```sql
-- 0005_tenant_user_unique.sql
CREATE UNIQUE INDEX "tenant_user_active_uniq"
  ON "tenant_user" (tenant_id, user_id)
  WHERE deleted_at IS NULL;
```

Plus add `getOrAddTenantUser(tenantId, userId, role, isDefault)` to `@cpa/auth/users.ts` that does the SELECT-or-INSERT-or-UNDELETE branch above.

## Test strategy

| Test type | What | Count target |
|---|---|---|
| Unit | requireSession + requireAdmin hooks (positive + negative) | 4 |
| Unit | getOrAddTenantUser (new, existing, soft-deleted, race) | 4 |
| Integration (api) | GET /v1/tenants returns user's membership list | 1 |
| Integration (api) | POST /v1/tenants/switch — happy path + non-member 404 + bad-uuid 400 | 3 |
| Integration (api) | GET /v1/users RLS-scoped to active tenant | 1 |
| Integration (api) | POST /v1/users — happy + 404 (no such user) + 409 (already member) + admin-only 403 | 4 |
| Integration (api) | PATCH /v1/users — happy + last-admin demote 409 | 2 |
| Integration (api) | DELETE /v1/users — happy + last-admin remove 409 + soft-delete confirmed | 3 |

**Test count target end of W3:** ~64 (W2) + ~22 (W3) = **~86 across 5 packages.**

## Out of scope (deferred)

- Email-based invitation flow (P3+)
- Tenant CREATE / UPDATE / DELETE (consultancy onboarding via CLI script per ADR-0002 §Q5; portal admin CRUD lives in W4)
- User profile updates (`PATCH /v1/me` to update `display_name`) — not in P1
- Audit log of admin actions (P2 schema)
- Rate limiting (P3 platform polish)
- 2FA / step-up auth for admin actions (P3+)

## Open questions parked for the plan

1. **`primaryIdp` not in JWT for switch?** The W2 JWT carries `primaryIdp` so re-signing in `/switch` doesn't lose it — but we should double-check by reading the JWT shape. If absent, route handler can fetch from user table.

2. **Tenant switch should the JWT regenerate the cookie expiry sliding?** Hard expiry (re-auth in 24h regardless of switches) is simpler; sliding (each switch resets the 24h clock) is more user-friendly. Going with **hard** — matches W2 Q3 single-token-no-refresh stance.

## References

- [ADR-0002 §Tenancy data model (Q2)](../decisions/0002-identity-and-tenancy.md#tenancy-data-model-q2) — `tenant_user` shape and roles
- [P1 design §3.4 endpoints](./2026-04-26-p1-identity-tenancy-design.md) — original endpoint sketch
- [W2 design §Q3](./2026-04-26-p1-w2-auth-design.md#q3--token-lifetime-24h-jwt-no-refresh-re-auth-on-expiry-b) — JWT lifetime decision

## Next step

Invoke `superpowers:writing-plans` to translate this design into a bite-sized W3 implementation plan.
