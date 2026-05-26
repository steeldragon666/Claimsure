-- Migration 0085 — Wizard Step 1 engagement-letter foundation.
--
-- Adds:
--   1. tenant.engagement_letter_template_md (per-firm markdown template)
--   2. engagement_letter table (per-claim signed instance)
--   3. claim.engagement_status (drives wizard step-1 gate)
--   4. RLS on engagement_letter (tenant isolation via app.current_tenant_id)
--
-- SQL is verbatim from docs/plans/wizard-step-1/01-migration.md (the
-- approved spec). IDEMPOTENT via IF NOT EXISTS so re-running is safe; no
-- down migration (append-only schema is the convention here, see README
-- "Cross-task conventions").
--
-- RLS pattern mirrors 0002_enable_rls.sql:
--   USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
-- The two-arg form of current_setting returns NULL on unset GUC, and
-- `tenant_id = NULL` is UNKNOWN (treated as false) → fail-safe deny.
-- Positive control test lives in apps/api/src/routes/engagement-letter.test.ts
-- (mirrors audit-log.test.ts precedent).
--
-- NOTE: pdf_evidence_id is a plain uuid (no FK). The `evidence` table is
-- not yet modelled in @cpa/db (the design doc references it; in the
-- current codebase "evidence" is a logical view over `media_artefact +
-- event`, see apps/api/src/routes/evidence.ts). Step 1 Task 03 (the
-- pg-boss PDF render job) will populate this field. If/when an `evidence`
-- table is introduced, add the FK in a follow-up migration. Same pattern
-- as ip_search_verdict.pdf_evidence_id in 0086_ip_search.sql.

-- Per-firm engagement letter template (markdown with {{variable}} placeholders).
ALTER TABLE tenant
  ADD COLUMN IF NOT EXISTS engagement_letter_template_md text;

-- Per-claim engagement letter instance (rendered + signed).
CREATE TABLE IF NOT EXISTS engagement_letter (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid        NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  claim_id                 uuid        NOT NULL REFERENCES claim(id) ON DELETE CASCADE,
  rendered_markdown        text        NOT NULL,
  template_version         text        NOT NULL,
  send_token               text        UNIQUE,         -- public token for web-fallback /engagement/[token]/sign
  send_token_expires_at    timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  sent_to_claimant_at      timestamptz,
  signed_by_claimant_at    timestamptz,
  signed_by_claimant_name  text,
  signed_by_claimant_ip    inet,
  signed_by_claimant_ua    text,
  countersigned_by_user_id uuid        REFERENCES "user"(id),
  countersigned_at         timestamptz,
  pdf_evidence_id          uuid,
  declined_at              timestamptz,
  declined_reason          text,
  expired_at               timestamptz,
  CONSTRAINT one_letter_per_claim UNIQUE (claim_id)
);

-- New column on claim driving wizard step-1 gate.
ALTER TABLE claim
  ADD COLUMN IF NOT EXISTS engagement_status text NOT NULL DEFAULT 'pending_send'
  CHECK (engagement_status IN ('pending_send', 'sent', 'signed', 'declined', 'expired'));

-- RLS — FORCE-enforced + idempotent policy (matches 0086_ip_search precedent).
-- FORCE means even the table owner is policy-gated when running as cpa_app
-- via SET LOCAL ROLE; without it, an app-runtime SET ROLE that landed as
-- the table owner would silently bypass the policy and leak the legal
-- engagement-letter artefact across tenants. This is the worst-case for
-- this table — be explicit about FORCE here.
ALTER TABLE engagement_letter ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement_letter FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polname = 'engagement_letter_tenant_isolation'
       AND polrelid = 'engagement_letter'::regclass
  ) THEN
    CREATE POLICY engagement_letter_tenant_isolation ON engagement_letter
      FOR ALL TO cpa_app
      USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON engagement_letter TO cpa_app;
