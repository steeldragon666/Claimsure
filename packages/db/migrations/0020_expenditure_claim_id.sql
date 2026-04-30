-- DO NOT REGENERATE THIS MIGRATION VIA `pnpm --filter @cpa/db generate`.
-- Hand-authored migration: adds `expenditure.claim_id` (nullable FK)
-- and indexes the new column. drizzle-kit would emit equivalent DDL,
-- but pinning this file preserves the comment block linking the column
-- to its design intent and explains the deliberate absence of backfill.
--
-- ============================================================
-- P5 swimlane A — Theme 1 (Task 1.2) — expenditure.claim_id
-- ============================================================
-- Per `docs/plans/2026-04-30-p5-implementation.md` Theme 1 (Wide-scope
-- denormalization): expenditures need a direct `claim_id` link so the
-- expenditure schedule, audit surfaces, and Theme 5 event emissions can
-- address "the claim this expenditure rolls up into" without walking
-- the expenditure → subject_tenant + fiscal_year → claim composite key.
--
-- Why nullable: unmapped expenditures are a real, valid state. An
-- expenditure may be ingested from Xero before the consultant has
-- decided which claim/fiscal-year it belongs to (cross-FY allocations,
-- non-R&D spend filtered out later, etc.). Theme 5's mapping engine is
-- responsible for populating this column once the consultant signs off
-- on the assignment. NO BACKFILL — existing pre-P5 expenditures stay
-- NULL and Theme 5 will assign them on first review.
--
-- Identity uniqueness on `expenditure` remains
-- `(tenant_id, source, source_external_id) WHERE source_external_id IS
-- NOT NULL` — claim_id is descriptive, not part of the natural key.
-- ============================================================

ALTER TABLE "expenditure" ADD COLUMN "claim_id" uuid;
--> statement-breakpoint
ALTER TABLE "expenditure" ADD CONSTRAINT "expenditure_claim_id_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claim"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "expenditure_claim_id_idx" ON "expenditure" USING btree ("claim_id");
