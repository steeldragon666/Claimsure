-- 0071_federation_rls_extension.sql
-- Hand-authored migration. DO NOT REGENERATE via `pnpm --filter @cpa/db generate`.
--
-- P9 Phase 3 — Extends existing RLS policies on claim, activity,
-- expenditure, and narrative_draft with an OR clause that grants
-- read access to tenants holding an active federation_share.
--
-- Pattern: DROP existing policy → CREATE replacement with federation OR.
-- WITH CHECK stays tenant-only — federated access is READ-only.
--
-- Does NOT extend the `event` table (the hash chain). Event access is
-- not part of the financier read surface.
--
-- Performance: the federation_share subquery uses the partial index
-- `federation_share_subject_tenant_idx` (WHERE revoked_at IS NULL)
-- created in 0070. The EXISTS pattern short-circuits on first match.

-- ============================================================
-- claim: has subject_tenant_id directly
-- ============================================================
DROP POLICY IF EXISTS "claim_tenant_isolation" ON "claim";
CREATE POLICY "claim_tenant_isolation" ON "claim"
  USING (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR EXISTS (
      SELECT 1 FROM federation_share fs
      WHERE fs.target_tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND fs.subject_tenant_id = claim.subject_tenant_id
        AND fs.revoked_at IS NULL
        AND (fs.expires_at IS NULL OR fs.expires_at > now())
    )
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  );
--> statement-breakpoint

-- ============================================================
-- activity: joins through claim to get subject_tenant_id
-- ============================================================
DROP POLICY IF EXISTS "activity_tenant_isolation" ON "activity";
CREATE POLICY "activity_tenant_isolation" ON "activity"
  USING (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR EXISTS (
      SELECT 1 FROM federation_share fs
      JOIN claim c ON c.subject_tenant_id = fs.subject_tenant_id
      WHERE fs.target_tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND c.id = activity.claim_id
        AND fs.revoked_at IS NULL
        AND (fs.expires_at IS NULL OR fs.expires_at > now())
    )
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  );
--> statement-breakpoint

-- ============================================================
-- expenditure: has subject_tenant_id directly
-- ============================================================
-- Note: expenditure's original policy (0013) did not use NULLIF. This
-- migration also upgrades to the canonical NULLIF pattern.
DROP POLICY IF EXISTS "expenditure_tenant_isolation" ON "expenditure";
CREATE POLICY "expenditure_tenant_isolation" ON "expenditure"
  USING (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR EXISTS (
      SELECT 1 FROM federation_share fs
      WHERE fs.target_tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND fs.subject_tenant_id = expenditure.subject_tenant_id
        AND fs.revoked_at IS NULL
        AND (fs.expires_at IS NULL OR fs.expires_at > now())
    )
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  );
--> statement-breakpoint

-- ============================================================
-- narrative_draft: joins through activity → claim to get subject_tenant_id
-- ============================================================
DROP POLICY IF EXISTS "narrative_draft_tenant_isolation" ON "narrative_draft";
CREATE POLICY "narrative_draft_tenant_isolation" ON "narrative_draft"
  USING (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR EXISTS (
      SELECT 1 FROM federation_share fs
      JOIN claim c ON c.subject_tenant_id = fs.subject_tenant_id
      JOIN activity a ON a.claim_id = c.id
      WHERE fs.target_tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND a.id = narrative_draft.activity_id
        AND fs.revoked_at IS NULL
        AND (fs.expires_at IS NULL OR fs.expires_at > now())
    )
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  );
