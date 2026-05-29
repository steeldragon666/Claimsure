-- 0094 — fail-safe RLS: NULLIF guard on the app.current_tenant_id cast.
--
-- The IP-search (0086) and engagement-letter (0087) tenant-isolation
-- policies cast `current_setting('app.current_tenant_id', true)::uuid`
-- directly. The two-arg current_setting returns NULL only when the GUC is
-- TRULY unset; when application/test code leaves it as an EMPTY STRING
-- (e.g. set_config(..., '', true) with a missing tenant), `''::uuid` raises
-- "invalid input syntax for type uuid" and 500s the request instead of
-- failing safe to "no rows visible".
--
-- Align all four policies to the canonical guard mandated in CLAUDE.md:
--   NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
-- which maps both NULL and '' to NULL → the row predicate is NULL → no rows.
--
-- ALTER POLICY only rewrites the USING/WITH CHECK expressions; the policy
-- name, role, and command scope are unchanged. Idempotent (re-running sets
-- the same expression).

ALTER POLICY ip_search_run_tenant_isolation ON ip_search_run
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
--> statement-breakpoint

ALTER POLICY ip_search_hit_tenant_isolation ON ip_search_hit
  USING (EXISTS (
    SELECT 1 FROM ip_search_run r
     WHERE r.id = ip_search_hit.search_run_id
       AND r.tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM ip_search_run r
     WHERE r.id = ip_search_hit.search_run_id
       AND r.tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  ));
--> statement-breakpoint

ALTER POLICY ip_search_verdict_tenant_isolation ON ip_search_verdict
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
--> statement-breakpoint

ALTER POLICY engagement_letter_tenant_isolation ON engagement_letter
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
