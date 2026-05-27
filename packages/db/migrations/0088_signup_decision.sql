-- 0088_signup_decision.sql
-- Autonomous signup-approval pipeline — full audit trail of every signup attempt.
--
-- This is an operator/admin table. The application path that runs the pipeline
-- writes to it via privilegedSql (the migration runner / pipeline ingress); the
-- per-tenant cpa_app role has no business reading or writing it. We REVOKE ALL
-- on cpa_app explicitly so a future shared-grant migration cannot retroactively
-- expose this surface across tenants.
--
-- One row per signup attempt. `decision in ('approve','deny')` is the final
-- pipeline outcome; `reason` records WHICH gate produced it (admin_override,
-- rate_limit, email_shape, claude_approve, claude_deny, permissive_fallback,
-- infra_failure_permissive). The remaining columns are the per-step evidence:
--   - rate_limit_count_in_window: number of signups from this IP in the prior
--     hour at the moment the decision was made.
--   - abr_lookup: full JSON response from ABR MatchingNames (null if ABR_GUID
--     was unset or the call failed; pipeline still proceeds in that case).
--   - claude_*: the LLM tool-use output (decision/confidence/rationale/red_flags).
--   - resulting_tenant_id / resulting_user_id: non-null on approve only.
--   - tokens_in / tokens_out / elapsed_ms / classifier_model / prompt_version:
--     observability for cost + latency tracking.
--
-- No RLS. Tenant-scoping does not apply (the row exists BEFORE the tenant in the
-- approve case, and the deny case has no tenant at all). The table itself is
-- forensic-only and never read by app code.

CREATE TABLE IF NOT EXISTS signup_decision (
  id                          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  decided_at                  timestamptz   NOT NULL DEFAULT now(),
  email                       text          NOT NULL,
  firm_name                   text          NOT NULL,
  display_name                text,
  client_ip                   text,
  user_agent                  text,
  decision                    text          NOT NULL CHECK (decision IN ('approve','deny')),
  reason                      text          NOT NULL,
  admin_override_hit          boolean       NOT NULL DEFAULT false,
  rate_limit_count_in_window  integer,
  email_shape_ok              boolean,
  abr_lookup                  jsonb,
  claude_confidence           numeric(4,3),
  claude_decision             text,
  claude_rationale            text,
  claude_red_flags            jsonb,
  resulting_tenant_id         uuid,
  resulting_user_id           uuid,
  classifier_model            text,
  prompt_version              text,
  tokens_in                   integer,
  tokens_out                  integer,
  elapsed_ms                  integer
);

CREATE INDEX IF NOT EXISTS signup_decision_recent_idx
  ON signup_decision (decided_at DESC);

CREATE INDEX IF NOT EXISTS signup_decision_email_idx
  ON signup_decision (lower(email));

CREATE INDEX IF NOT EXISTS signup_decision_ip_recent_idx
  ON signup_decision (client_ip, decided_at DESC);

-- Lock the table down for cpa_app. The pipeline writes via privilegedSql so the
-- application role never needs access. This is defensive: a future
-- backfill_cpa_app_grants-style migration must explicitly opt in to grant access
-- here.
REVOKE ALL ON signup_decision FROM cpa_app;
