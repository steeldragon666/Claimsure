# ADR-0002: Identity, Tenancy & Request Correlation

**Status:** Accepted
**Date:** 2026-04-26
**Authors:** Aaron Newson + AI pair (Claude Opus 4.7)
**Builds on:** [ADR-0001](./0001-monorepo-and-stack.md)
**Source brainstorm:** [P1 design](../plans/2026-04-26-p1-identity-tenancy-design.md)

## Context

P0 established the platform foundation (monorepo, DB, OTel, API skeleton). P1 needs to
introduce real users into a multi-tenant SaaS platform — consultant firms with their own
staff, each working on multiple claimants. This ADR captures the tenancy and authentication
decisions that propagate into every API endpoint, every domain table, and every row of audit
data the platform stores.

## Decision

### Identity provider strategy (Q1)

- **Microsoft Entra ID + Google Workspace OIDC** are integrated from day 1, both via Auth.js.
- Other IdPs (Okta, Auth0, Apple) deferred to P3+ when a real customer asks.
- SAML2.0 is NOT in P1 scope. Auth.js's primary path is OIDC; AU SME consultancies on M365
  / Google Workspace can use OIDC. SAML for enterprise customers is a P3+ concern via WorkOS
  or similar broker.

### Tenancy data model (Q2)

- **Three core entities + two M:N joins:**
  - `tenant` — consultant firm (white-label root).
  - `subject_tenant` — claimant or financier (the firm's "client"), distinguished by `kind`.
  - `user` — global; not bound to any single tenant.
  - `tenant_user` — M:N join; a user can be a member of multiple firms with different roles.
  - `subject_tenant_user` — per-claimant ACL; even within one firm, a user can have access
    to a subset of claimants.
- **`subject_tenant.kind`** ∈ `{claimant, financier}`. Claimants are owned by their firm;
  financiers are granted scoped access via delegation tokens (P8).
- Federation primitives (`delegation_token` table) ship in P1 for schema-completeness;
  the API + UX that issues and redeems them lands in P8.

### Schema layout convention (Q3)

- **Flat:** every Drizzle table is one file at `packages/db/src/schema/<table_name>.ts`,
  snake_case matching the SQL table name exactly. No domain subdirectories.
- The flat convention is the **lifetime convention** for this platform, not just P1.
- Drizzle-kit's existing extglob (`./src/schema/!(*.test|index).ts`) covers it without
  recursion. Index file (`schema/index.ts`) re-exports for app-level imports; test files
  (`*.test.ts`) live alongside source.

### Federation depth in P1 (Q4)

- **Schema primitives only.** The `delegation_token` table exists; no API endpoint issues
  or redeems tokens; no portal UI.
- Why now: per-claimant ACL machinery (`subject_tenant_user`) and the `subject_tenant.kind`
  enum need to coexist with delegation tokens conceptually. Building the schema for both
  simultaneously avoids retroactive migrations.

### Onboarding flow in P1 (Q5)

- **No formal onboarding flow.** A platform-admin CLI script
  (`tools/scripts/onboard-tenant.ts`) seeds tenants and their first admin user via direct
  Drizzle inserts.
- Aligns with the early-stage, high-touch onboarding model the product spec PDFs describe
  ("60-minute onboarding call").
- Self-serve signup, team-member invites, and email sending are deferred to P3+.

### Request correlation strategy (P0 review item I5)

- **The reqId we generate via Fastify's `genReqId` IS a v4 UUID, not a W3C trace context
  identifier.** This is intentional for P1.
- `reqId` is a *log* correlation primitive — it appears in every pino line, in error
  responses (`{ error, message, requestId }`), and in audit-log rows.
- OTel auto-instrumentation produces a separate `traceparent`/`tracestate` pair that
  flows through HTTP headers and into Tempo spans. These are *trace* correlation
  primitives.
- The two are linked through pino's automatic `trace_id` and `span_id` injection (provided
  by `@opentelemetry/instrumentation-pino`, included in `getNodeAutoInstrumentations()`).
- Net effect: a Grafana dashboard can pivot from a slow Tempo span to its log lines
  via `trace_id`, OR pivot from an error envelope's `requestId` to the same logs via
  `req_id`. Either path works.
- **What we are NOT doing:** using the W3C `traceparent` header value AS the reqId.
  The trace ID is 16 bytes hex; UUIDs are 16 bytes too but with version+variant bits.
  Mixing them confuses tools that assume one format. Keep them parallel.

### RLS context-setting

- `app.current_tenant_id` is a Postgres GUC (Grand Unified Configuration) variable set
  per-request via `SET LOCAL` inside an explicit transaction.
- Postgres-js's pool reuses connections across requests; `SET LOCAL` scopes the variable
  to the current transaction so it cannot leak across requests.
- The Fastify `preHandler` middleware in `@cpa/auth/session` reads `activeTenantId` from
  the verified JWT, opens a transaction with `db.transaction(...)`, sets the GUC, and
  attaches the transaction handle to `req`. Routes use `req.tx` instead of `db`.
- Tables that have `tenant_id` directly (e.g. `subject_tenant`) get the simple policy:
  `tenant_id = current_setting('app.current_tenant_id', true)::uuid`.
- Tables that link to a tenant indirectly (e.g. `subject_tenant_user`) get a subquery
  policy: `subject_tenant_id IN (SELECT id FROM subject_tenant WHERE tenant_id = ...)`.
- `tenant` and `user` tables are **global** — no RLS. Access is gated at the API layer
  (e.g. `/v1/users` requires admin role on the active tenant).

## Consequences

**Positive**

- Per-claimant role grants make the audit trail richer from day one. When the hash-chain
  Assurance Report is generated in P5, "who could have edited this evidence" naturally
  includes per-claimant roles.
- The two-IdP-from-day-1 commitment removes a future migration cost. ~95% of AU SME
  consultancies are on M365 OR Google Workspace; we'll never have to retrofit one.
- Federation primitives ready in P1 means P8's UX lands without a schema migration.

**Negative**

- The full tenancy model is more code than a flat one. Multi-firm session shape,
  `availableTenants[]`, tenant-switcher UI, and `subject_tenant_user` lookups in every
  list endpoint add real complexity.
- `SET LOCAL` requires every request to run inside a transaction. Postgres-js handles
  this, but it's a constraint future contributors need to understand.

**Reviewable in P2+**

- Whether `is_default` on `tenant_user` is the right primitive for "active firm at login"
  — alternatives include a separate `user_preferences` table or a `last_active_tenant_id`
  on `user`. Revisit if the column gets re-purposed.
- Whether `subject_tenant.kind` should be a discriminated table (`claimant` table +
  `financier` table) once the kinds diverge enough in shape. Today they share the same
  columns; if/when they diverge, split.

## Alternatives considered

- **Separate `claimant` and `financier` tables**: rejected because the kinds share
  identical columns at this point. Single table + `kind` enum is simpler today and
  trivially splittable later.
- **Self-serve signup in P1**: rejected per Q5. Pre-revenue B2B SaaS that adds self-serve
  before product-market-fit invariably regrets it.
- **Auth0 / WorkOS broker**: rejected for P1 because Auth.js handles two providers
  natively at no vendor cost. Reconsider only if SAML enterprise deals land.
- **Trace ID as reqId**: rejected because it confuses tooling that assumes UUID format.
  Keeping them parallel preserves both semantics cleanly.

## References

- [P1 design](../plans/2026-04-26-p1-identity-tenancy-design.md)
- [Architecture design §4 data model](../plans/2026-04-25-rdti-grants-platform-design.md)
- Postgres RLS docs: https://www.postgresql.org/docs/16/ddl-rowsecurity.html
- W3C Trace Context: https://www.w3.org/TR/trace-context/
