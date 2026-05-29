-- 0093 — per-client integration connections.
--
-- Accounting (and payroll) integrations are per CLIENT (subject_tenant /
-- claimant), not per firm: each client company has its own Xero/MYOB org.
-- Firm-level integrations (e.g. DocuSign e-signature) remain one-per-firm.
--
-- We add a nullable `subject_tenant_id` and replace the single
-- `(tenant_id, provider)` unique with TWO partial uniques:
--   * firm-level  (subject_tenant_id IS NULL):  one per (tenant, provider)
--   * per-client  (subject_tenant_id NOT NULL): one per (tenant, client, provider)
--
-- The prod table is empty at time of writing, so no backfill is required.
-- RLS is unchanged (still tenant_id = current GUC); subject_tenant_id is an
-- additional, app-enforced narrowing. The route verifies the subject_tenant
-- belongs to the caller's firm before writing.

ALTER TABLE integration_connection
  ADD COLUMN subject_tenant_id uuid REFERENCES subject_tenant(id);

DROP INDEX IF EXISTS integration_connection_tenant_provider_unique;

CREATE UNIQUE INDEX integration_connection_firm_provider_unique
  ON integration_connection (tenant_id, provider)
  WHERE subject_tenant_id IS NULL;

CREATE UNIQUE INDEX integration_connection_client_provider_unique
  ON integration_connection (tenant_id, subject_tenant_id, provider)
  WHERE subject_tenant_id IS NOT NULL;

-- Helps the per-client lookups in GET /v1/integrations?subject_tenant_id=...
CREATE INDEX integration_connection_subject_tenant_idx
  ON integration_connection (tenant_id, subject_tenant_id)
  WHERE subject_tenant_id IS NOT NULL;
