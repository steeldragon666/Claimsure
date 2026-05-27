-- DO NOT REGENERATE THIS MIGRATION VIA `pnpm --filter @cpa/db generate`.
-- Hand-authored migration: eval-tracking tables for the bulk-claim
-- accuracy benchmark.
--
-- PURPOSE
--   Persist score-stress-test.ts (and score-bulk-claims.ts) results so
--   accuracy drift across runs is queryable. Two tables:
--     - eval_run        — one row per benchmark execution (run-level
--                         aggregates + seed + classifier impl + models)
--     - eval_run_claim  — one row per (run, claimant) pair (per-claim
--                         R&D-recall and contamination-caught metrics)
--
-- NOT tenant-scoped — these are global admin/operational tables. The
-- scoring CLI writes them via privilegedSql. cpa_app has no need to
-- read or write them, so RLS is omitted and grants are revoked.
-- Compare 0067 (llm_token_usage) — same pattern of operational tables
-- that record across-tenant metrics without RLS.

-- ============================================================
-- 1. eval_run — one row per benchmark execution.
-- ============================================================

CREATE TABLE "eval_run" (
  "id"                                    uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  "started_at"                            timestamptz  NOT NULL DEFAULT now(),
  "finished_at"                           timestamptz,
  "seed_name"                             text         NOT NULL,
  "agents_classifier_impl"                text         NOT NULL,
  "agents_expenditure_classifier_impl"    text         NOT NULL,
  "agents_classifier_model"               text,
  "agents_expenditure_classifier_model"   text,
  -- Volume captured at evaluation time (the seed's actuals, not targets).
  "total_claims"                          integer      NOT NULL DEFAULT 0,
  "total_expenditure_cents"               bigint       NOT NULL DEFAULT 0,
  "total_ineligible_expenditure_cents"    bigint       NOT NULL DEFAULT 0,
  "total_notes"                           integer      NOT NULL DEFAULT 0,
  "total_contaminated_notes"              integer      NOT NULL DEFAULT 0,
  -- Aggregate accuracy metrics — 0.000 to 100.000.
  "note_rd_recall_pct"                    numeric(6,3) NOT NULL DEFAULT 0,
  "note_contamination_caught_pct"         numeric(6,3) NOT NULL DEFAULT 0,
  "exp_rd_recall_pct"                     numeric(6,3) NOT NULL DEFAULT 0,
  "exp_contamination_caught_pct"          numeric(6,3) NOT NULL DEFAULT 0,
  "notes"                                 text,
  CONSTRAINT "eval_run_impl_check" CHECK (
    "agents_classifier_impl" IN ('stub', 'opus', 'haiku')
    AND "agents_expenditure_classifier_impl" IN ('stub', 'opus', 'haiku')
  )
);
--> statement-breakpoint

-- "Last N runs for a given seed" — the diff-table CLI uses this.
CREATE INDEX "eval_run_seed_started_idx" ON "eval_run" ("seed_name", "started_at" DESC);
--> statement-breakpoint
CREATE INDEX "eval_run_started_idx" ON "eval_run" ("started_at" DESC);
--> statement-breakpoint

-- ============================================================
-- 2. eval_run_claim — one row per (run, claimant) pair.
-- ============================================================

CREATE TABLE "eval_run_claim" (
  "id"                              uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  "eval_run_id"                     uuid    NOT NULL,
  "claim_idx"                       integer NOT NULL,
  "tenant_id"                       uuid    NOT NULL,
  "claim_id"                        uuid    NOT NULL,
  "claimant_name"                   text    NOT NULL,
  "domain_slug"                     text    NOT NULL,
  -- Note classification metrics — counts, not percentages, so the
  -- reporter can re-derive percentages or roll up however it likes.
  "note_rd_total"                   integer NOT NULL DEFAULT 0,
  "note_rd_kept"                    integer NOT NULL DEFAULT 0,
  "note_contamination_total"        integer NOT NULL DEFAULT 0,
  "note_contamination_caught"       integer NOT NULL DEFAULT 0,
  -- Expenditure classification metrics — dollars (cents) only;
  -- a $10 misclassification matters less than a $100K one and the
  -- count would obscure that. Reporter prints both ratio and amount.
  "exp_rd_dollars_cents"            bigint  NOT NULL DEFAULT 0,
  "exp_rd_kept_cents"               bigint  NOT NULL DEFAULT 0,
  "exp_contamination_dollars_cents" bigint  NOT NULL DEFAULT 0,
  "exp_contamination_caught_cents"  bigint  NOT NULL DEFAULT 0
);
--> statement-breakpoint

ALTER TABLE "eval_run_claim"
  ADD CONSTRAINT "eval_run_claim_eval_run_id_fk"
  FOREIGN KEY ("eval_run_id") REFERENCES "public"."eval_run"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint

-- Look up all per-claim rows for a given run.
CREATE INDEX "eval_run_claim_run_idx" ON "eval_run_claim" ("eval_run_id");
--> statement-breakpoint
-- "How did THIS tenant trend across runs."
CREATE INDEX "eval_run_claim_tenant_idx" ON "eval_run_claim" ("tenant_id", "eval_run_id");
--> statement-breakpoint

-- ============================================================
-- 3. Grants — cpa_app has no business reading or writing these.
-- ============================================================
-- The DEFAULT PRIVILEGES rule from 0002 / 0084 auto-grants to cpa_app
-- when tables are created by the migration runner. Revoke explicitly so
-- only privilegedSql (postgres role) can touch the tables.
REVOKE ALL ON "eval_run"       FROM cpa_app;
REVOKE ALL ON "eval_run_claim" FROM cpa_app;
