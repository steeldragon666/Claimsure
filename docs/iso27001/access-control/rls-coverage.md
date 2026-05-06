# RLS Coverage Audit (ISO 27001 A.5.18, A.8.3)

**Last reviewed:** 2026-05-06
**Reviewer:** Aaron
**Audit period:** 2026-Q2 onwards (quarterly review cadence)

## Method

Automated test in `packages/db/src/schema/rls-coverage.test.ts` runs on
every CI build and asserts:

1. Every public-schema table has `rowsecurity=true` OR is in the exempt list
2. Every RLS-enabled table has at least one policy attached
3. Every exempt-list entry corresponds to an actual table (no phantom exemptions)

Test failure blocks merge. This provides continuous assurance that new tables
cannot ship without explicit RLS decisions.

## Exempt tables (intentional non-RLS)

| Table                      | Rationale                                                                                                                                              | RLS-equivalent gate                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `tenant`                   | Global identity table; cross-tenant lookup needed during authentication and tenant-switching flows                                                     | `tenant_user` membership join restricts which tenants a user can access                                                  |
| `user`                     | Global identity table; a user can belong to multiple tenants via `tenant_user`                                                                         | `tenant_user` + `subject_tenant_user` ACL gates all tenant-specific operations                                           |
| `system`                   | System configuration key-value store (P0 bootstrap); no tenant scope                                                                                   | Admin-only; `cpa_app` role has limited grants; no tenant data stored                                                     |
| `agent_call_cache`         | Content-addressed by SHA-256(prompt_version + input); identical inputs across tenants share a cache entry                                              | No tenant data in cache key or value; key only reveals "someone classified text X" which the requester already knows     |
| `magic_link_token`         | Lookup by token hash happens before any tenant context is established; the token IS the auth signal                                                    | Token hash is the secret; no cross-tenant data leak risk; `consumed_at` prevents replay                                  |
| `mobile_session`           | Accessed via `employee_id` FK to `subject_tenant_employee` (which IS RLS-protected); refresh-token lookup happens before tenant context                | Transitive RLS via JOIN to `subject_tenant_employee`; `refresh_token_hash` lookup is secret-gated                        |
| `expenditure_line`         | Child rows of `expenditure`; `tenant_id` lives on parent which IS RLS-enforced                                                                         | Always accessed via JOIN through `expenditure` (RLS-enforced); no direct access path bypasses parent                     |
| `narrative_segment`        | Child rows of `narrative_draft`; tenant scope via composite FK to `narrative_draft(tenant_id, id)`                                                     | Always accessed via JOIN through `narrative_draft` (RLS-enforced); CASCADE FK ensures structural integrity               |
| `regulatory_source`        | Global reference data (R&DTI feed sources) shared across all tenants; not per-tenant scoped                                                            | Application-layer access control: consultant role only via `cpa_app` GRANTs; no `DELETE` permission                      |
| `regulatory_event`         | Global reference data (R&DTI feed events) shared across all tenants; not per-tenant scoped                                                             | Application-layer access control: consultant role only via `cpa_app` GRANTs; no `DELETE` permission                      |
| `founding_partner_slots`   | Global allocation table (P9.1); 10 fixed slots claimed first-come-first-served across all tenants; no per-tenant scope                                 | Claimed by FK to `tenant.id`; `FOR UPDATE SKIP LOCKED` prevents double-claim; no sensitive data stored in unclaimed rows |
| `processed_webhook_events` | Stripe webhook idempotency table (P9.1); keyed by `stripe_event_id` (text PK); tenant_id indexed for ops queries but event-ID–scoped not tenant-scoped | Write-once append (no UPDATE); `cpa_app` INSERT only; `stripe_event_id` is Stripe-issued and non-secret                  |

> **Note on `__drizzle_migrations`:** drizzle-kit's migration-metadata table lives in the
> `drizzle` schema by default (not `public`). The audit query filters on `public` schema
> only, so this table is correctly outside scope and does not need an exempt-list entry.
> DBA access only; `cpa_app` role has no grants.

## Findings (most recent audit)

Initial audit performed 2026-05-06. All public-schema tables either have
RLS enabled with at least one policy, or are documented in the exempt list
above with rationale and compensating controls.

## Review schedule

- **Quarterly**: Re-run test suite, review exempt list rationale
- **On new migration**: CI test automatically catches new tables without RLS
- **Annual**: Full manual review of all policies and exempt rationale

| Review    | Date       | Reviewer | Outcome                                                                                                                                                                                                                                                                                              |
| --------- | ---------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline  | 2026-05-06 | Aaron    | All tables accounted for; exempt list documented                                                                                                                                                                                                                                                     |
| Drift fix | 2026-05-06 | Aaron    | Migration `0040_regulatory_intelligence.sql` shipped two new global reference tables (`regulatory_source`, `regulatory_event`) without updating the exempt list; CI audit caught it. Added entries with rationale. Removed `__drizzle_migrations` phantom (lives in `drizzle` schema, not `public`). |
| Drift fix | 2026-05-07 | Aaron    | Migration `0041_subscription_schema.sql` shipped two intentionally non-RLS tables (`founding_partner_slots` — global allocation, `processed_webhook_events` — system deduplication); added to exempt list with rationale and compensating controls.                                                  |
| Q3 2026   | TBD        | Aaron    | Scheduled                                                                                                                                                                                                                                                                                            |
