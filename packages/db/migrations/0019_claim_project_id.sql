-- DO NOT REGENERATE THIS MIGRATION VIA `pnpm --filter @cpa/db generate`.
-- Hand-authored migration: adds `claim.project_id` (nullable FK), backfills
-- it from `activity.project_id`, and indexes the new column. drizzle-kit
-- cannot fully express the backfill UPDATE (it only emits structural DDL).
--
-- ============================================================
-- P5 swimlane A — Theme 1 (Task 1.1) — claim.project_id
-- ============================================================
-- Per `docs/plans/2026-04-30-p5-implementation.md` Theme 1 (Wide-scope
-- denormalization): claims need a direct `project_id` link so audit
-- surfaces, document generation, and Theme 5's deferred event emissions
-- can address "the project this claim covers" without walking the
-- claim → activity → project join.
--
-- Why nullable: existing claims pre-date this column. Backfill seeds
-- the value from any activity attached to the claim (claims share one
-- project across all their activities — the activity-level FK is a
-- denormalisation of that). Claims with NO activities (engagement
-- stage, no work captured yet) stay NULL — the column is intentionally
-- not constrained `NOT NULL` because that's a real, valid state.
--
-- The (subject_tenant_id, fiscal_year, project_id) tuple is the
-- semantic key — but uniqueness enforcement stays on
-- `(subject_tenant_id, fiscal_year)` per the existing claim_subject_tenant_fiscal_year_unique
-- constraint. project_id is descriptive, not part of identity.
-- ============================================================

ALTER TABLE "claim" ADD COLUMN "project_id" uuid;
--> statement-breakpoint
ALTER TABLE "claim" ADD CONSTRAINT "claim_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "claim_project_id_idx" ON "claim" USING btree ("project_id");
--> statement-breakpoint

-- Backfill from activity.project_id. Each claim's activities share one
-- project_id (activity is a child of both claim and project — the
-- project_id on activity is a denormalisation of the claim's project).
-- DISTINCT + LIMIT 1 picks any one (they're all equal); MIN() would
-- also work but is less explicit about the "pick any" intent.
UPDATE "claim" SET "project_id" = (
  SELECT a."project_id"
  FROM "activity" a
  WHERE a."claim_id" = "claim"."id"
  LIMIT 1
)
WHERE "project_id" IS NULL;
