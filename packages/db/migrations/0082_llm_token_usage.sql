-- Per-call LLM token usage ledger.
--
-- Why: consultant accounts get a per-claim AUD budget (default A$50) of
-- generous-but-bounded LLM spend. Above that, every call gets billed at
-- cost + 50% to the consultant's account. This table is the system of
-- record for both the budget check and the eventual invoice line items.
--
-- One row per LLM completion (Anthropic messages.create), inserted by the
-- agent runtime after the API responds. Columns are minimal but enough
-- to:
--   - compute claim_id-scoped totals for the budget check
--   - generate per-tenant monthly invoices (sum where status='billable')
--   - support future per-agent cost breakdown (which agent burned the budget?)
--   - debug "why was this call billed" disputes (model + tokens are forensic)
--
-- Append-only. No UPDATE except `billed_at` set when an invoice is issued
-- (PR-future). No DELETE — even for closed claims; the ledger is
-- compliance evidence for billing.

CREATE TABLE IF NOT EXISTS llm_token_usage (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid        NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  -- claim_id is nullable: some agent calls aren't claim-scoped (e.g. a
  -- tenant-wide insights call without a subject_tenant_id). Those are
  -- billed against the tenant's quota directly.
  claim_id           uuid        REFERENCES claim(id) ON DELETE SET NULL,
  subject_tenant_id  uuid        REFERENCES subject_tenant(id) ON DELETE SET NULL,
  -- Free text — every agent records its module name (e.g.
  -- 'document-analyzer', 'application-drafter', 'insights-generator').
  agent_name         text        NOT NULL,
  -- Anthropic model id verbatim (e.g. 'claude-haiku-4-5', 'claude-sonnet-4-5').
  -- Pricing lookup keys off this column so it MUST match the value the
  -- pricing table uses.
  model              text        NOT NULL,
  tokens_in          integer     NOT NULL CHECK (tokens_in >= 0),
  tokens_out         integer     NOT NULL CHECK (tokens_out >= 0),
  -- Cost-at-rates-at-time-of-call, in AUD cents (integer to avoid
  -- floating-point drift across billing reconciliation). Includes the
  -- over-budget markup when status='billable'; equal to the base cost
  -- when status='free_tier'.
  cost_aud_cents     integer     NOT NULL CHECK (cost_aud_cents >= 0),
  -- 'free_tier' = within per-claim quota; 'billable' = over quota,
  -- charged to consultant + 50% markup; 'gifted' = manually waived by
  -- support (no future surface for this yet but reserving the slot).
  status             text        NOT NULL DEFAULT 'free_tier'
                                CHECK (status IN ('free_tier', 'billable', 'gifted')),
  -- When was this row included on an invoice? NULL = unbilled.
  billed_at          timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Hot path: budget check sums cost_aud_cents WHERE claim_id = $1 — needs
-- to be O(log n) even at scale.
CREATE INDEX IF NOT EXISTS llm_token_usage_claim_idx
  ON llm_token_usage (claim_id, created_at DESC)
  WHERE claim_id IS NOT NULL;

-- Invoicing path: per-tenant unbilled rows for a month.
CREATE INDEX IF NOT EXISTS llm_token_usage_tenant_unbilled_idx
  ON llm_token_usage (tenant_id, created_at DESC)
  WHERE billed_at IS NULL AND status = 'billable';

-- Debugging path: filter by agent_name to see which agent burned budget.
CREATE INDEX IF NOT EXISTS llm_token_usage_agent_idx
  ON llm_token_usage (agent_name, created_at DESC);

-- RLS — tenant-scoped reads.
--
-- FORCE is required: PostgreSQL bypasses RLS for the table OWNER unless
-- FORCE ROW LEVEL SECURITY is set. Without FORCE, the application's
-- postgres role (which owns the table in dev) would see all rows
-- regardless of the policy. Mirrors event-table behaviour in migration 0006.
ALTER TABLE llm_token_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_token_usage FORCE  ROW LEVEL SECURITY;

CREATE POLICY llm_token_usage_tenant_isolation
  ON llm_token_usage
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));

-- NOTE: GRANT for cpa_app lives in migration 0084 (backfill), not here.
-- We can't edit this file retroactively (append-only contract — already
-- applied to live Supabase). 0084 handles llm_token_usage along with 8
-- other tables that hit the same missing-default-privileges bug.
