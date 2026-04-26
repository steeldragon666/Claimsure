# P1 Residual Issues (post-merge cleanup)

**Date:** 2026-04-27
**Status:** Tracked, NOT blocking P2
**Source:** CI run on `1552825` (`fix(ci): pass DATABASE_URL_APP + SESSION_JWT_SECRET through turbo`)

## Resolved during P2 brainstorm

- ✅ **`tools/scripts/test` env-file flag** — `tools/scripts/package.json` was using `--env-file=` (hard) instead of `--env-file-if-exists=`. Fixed in `7a6ac50`.
- ✅ **Turbo strips `DATABASE_URL_APP` and `SESSION_JWT_SECRET`** — `globalPassThroughEnv` whitelist was missing both. Tests connecting via `getAppDatabaseUrl()` fell back to `DATABASE_URL` (privileged `cpa` role), table-owner bypassed RLS, `rls.test.ts` saw both tenants' rows under every context. Fixed in `1552825`. **All `ci` job unit tests are now green.**

## Outstanding (P1 residual; e2e job still red)

These are pre-existing issues exposed/created by the unit-test fixes above, NOT regressions from the turbo fix.

### R1 — `getByRole('heading')` fails on shadcn `<CardTitle>`

**Failing tests:**
- `e2e/login-redirect.spec.ts:6` — `page.getByRole('heading', { name: /sign in/i })`
- (likely also in any spec that asserts a card heading)

**Root cause:** shadcn's `CardTitle` (`apps/web/src/components/ui/card.tsx:32-45`) renders as `<div className="text-2xl font-semibold ...">`, not `<h1-h6>`. There's no `role="heading"`, so the role-based locator misses it.

**This is intentional in current shadcn** — heading level should be a consumer concern, not the component's. The component is vendored ("Kept as-is so future `shadcn add` runs don't fight lint" per `apps/web/eslint.config.mjs`).

**Fix options:**
1. Change tests to use `page.getByText('Sign in to CPA Platform')` or `page.locator('text=/sign in/i')`.
2. Wrap `CardTitle` content in an `<h1>` at the consumer site (`apps/web/src/app/login/page.tsx`).
3. Override the vendored card to use `<h3>` (drift from shadcn upstream).

**Recommended:** Option 1. The card title text is the assertion — element type is irrelevant.

### R2 — `users-admin-edit` / `users-admin-remove` last-admin tests miss the 409 toast

**Failing tests:**
- `e2e/users-admin-edit.spec.ts:76` — sole admin tries to demote self → expected toast `Cannot demote the only firm admin`
- `e2e/users-admin-remove.spec.ts:74` — sole admin tries to remove self → expected toast `Cannot remove the only firm admin`
- `e2e/users-admin-remove.spec.ts:45` — admin removes consultant → expected nav to `/users`

**Probable root cause:** When the API was inadvertently connecting as `cpa` (table owner, RLS bypassed) prior to the turbo fix, the last-admin count query worked because it could see all rows globally. Now that the API correctly connects as `cpa_app` with RLS, the count query depends on `app.current_tenant_id` GUC being set per-request. If the auth middleware doesn't set the GUC reliably, the count returns 0, the last-admin guard fires-or-doesn't differently, and the test expectations break.

**Investigation hint:** look at `apps/api/src/routes/users.ts` (or wherever the demote/remove endpoint lives) and check whether it wraps the DB calls in `withTenantContext(req, ...)` (the helper from `@cpa/auth/rls`). If not, that's the bug.

### R3 — Tenant-switch test redirect

**Failing test:** `e2e/tenant-switch.spec.ts:17`

Cause likely overlaps with R2 — the tenant switcher dropdown queries available firms via API; if RLS is now blocking what was previously global-visible, the dropdown is empty and the test's "click second tenant" step misses.

### R4 — Dashboard test (`e2e/dashboard.spec.ts:17`)

**Symptom:** admin user signs in via fixture, navigates to `/`, expects to see own email + firm name. Failing.

**Probable cause:** Same family as R2 — the dashboard's "current user/firm" panel queries via API; if the auth middleware doesn't set `app.current_tenant_id`, no data returned, no email/firm rendered.

## Recommended P1 cleanup sequence

1. Fix R1 by switching the affected e2e specs from `getByRole('heading', ...)` to `getByText(...)` — purely test changes, no UI drift.
2. Audit `apps/api/src/routes/*` for endpoints that don't use `withTenantContext` (or equivalent GUC-setting wrapper) — that's R2/R3/R4's likely shared root.
3. Re-run e2e in CI; if green, move tag `p1-identity-tenancy` to the green commit, merge PR #1.

## Why this is NOT blocking P2

- P2 is on its own branch `p2/event-capture` (head `398f247`) which carries the turbo passthrough fix.
- P2's foundation is the *unit-test* surface — `cpa_app` + RLS + chain + agents — which is now correctly tested in CI.
- P2 e2e tests (Phase 6 of the implementation plan) test P2 surfaces only; they don't depend on the P1 user-management endpoints that R2/R3/R4 break.
- P1 PR can merge independently once R1-R4 are fixed; P2 can be rebased onto main afterwards.
