-- DO NOT REGENERATE THIS MIGRATION VIA `pnpm --filter @cpa/db generate`.
-- Hand-authored migration: narrative_draft table with composite primary
-- key, jsonb segments column, RLS policy, two CHECK constraints, FK to
-- activity, and two btree indexes (one partial). drizzle-kit cannot
-- fully express:
--   1. CHECK constraints (narrative_draft_section_kind_valid,
--      narrative_draft_status_valid) — drizzle's check() helper
--      round-trips poorly and is omitted from the schema model on this
--      branch (existing pattern in 0006/0008/0010/0012/0013/0016/0018/0022).
--   2. The RLS / FORCE / policy block (same hand-authored pattern as
--      0016 / 0018 / 0022).
--   3. The partial index `WHERE status = 'streaming'` (drizzle-kit's
--      partial-index support is limited).
--
-- ============================================================
-- P6 Task 1.4 — narrative_draft table (Agent C storage)
-- ============================================================
-- The future Agent C (streaming narrative drafter) writes ONE row per
-- (activity_id, section_kind) pair as it streams `emit_segment` tool
-- calls. Each activity has exactly four narrative_draft rows — one per
-- AusIndustry submission narrative field per design doc Section 5:
-- new_knowledge, hypothesis, uncertainty, experiments_and_results.
--
-- The `segments` jsonb column carries the live working copy the
-- consultant edits — a list of NarrativeSegment shapes (prose | claim)
-- defined in @cpa/schemas/event.ts. The append-only per-version
-- snapshot history lives in `narrative_draft_version` (Task 1.5,
-- migration 0030); THIS table is the live mutable surface and bumps
-- `current_version` on every regen / consultant edit.
--
-- The `NARRATIVE_DRAFTED` chain event (admitted by 0028) carries
-- METADATA ONLY: a `narrative_draft_id` pointing here plus the
-- `content_hash` (lowercase hex sha256 of the canonicalised segments).
-- The auditor verifies storage integrity by recomputing the hash from
-- this table's `segments` and comparing byte-for-byte against the
-- chain event. Tampering with the live working copy fails the check.
--
-- TENANT ISOLATION: composite PK (tenant_id, id) pins isolation
-- structurally — even if RLS were bypassed, the `id` half is a v4
-- UUID but the PK shape pins the "draft belongs to a tenant"
-- invariant in the schema. RLS policy uses the NULLIF-wrapped
-- current_setting pattern (see 0003 commentary + 0022 audit_log
-- keystone) so an unset GUC fails-safe to "deny everything".
--
-- ACTIVITY FK: ON DELETE CASCADE — deleting an activity cascade-
-- deletes its narrative drafts. The activity_id FK is the natural
-- lifecycle anchor; orphan drafts have no audit value.
--
-- IDEMPOTENCY: `idempotency_key` is nullable. Populated on AI-emit
-- paths (so retries across worker crashes are deduped at the
-- persistence layer); NULL on consultant-edit paths (no retry surface
-- to dedupe).
-- ============================================================

CREATE TABLE "narrative_draft" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	-- 'new_knowledge' | 'hypothesis' | 'uncertainty' | 'experiments_and_results'
	"section_kind" text NOT NULL,
	"current_version" integer NOT NULL,
	-- 'streaming' | 'complete' | 'accepted' | 'archived'
	"status" text NOT NULL,
	-- list of NarrativeSegment for THIS section (prose | claim)
	"segments" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	CONSTRAINT "narrative_draft_tenant_id_id_pk" PRIMARY KEY ("tenant_id","id"),
	CONSTRAINT "narrative_draft_activity_section_unique" UNIQUE ("tenant_id","activity_id","section_kind"),
	CONSTRAINT "narrative_draft_section_kind_valid" CHECK (
		"section_kind" IN ('new_knowledge','hypothesis','uncertainty','experiments_and_results')
	),
	CONSTRAINT "narrative_draft_status_valid" CHECK (
		"status" IN ('streaming','complete','accepted','archived')
	)
);
--> statement-breakpoint

-- FK to activity. ON DELETE CASCADE because deleting an activity
-- should cascade-delete its narrative drafts (the activity_id FK is
-- the natural lifecycle anchor; orphan drafts have no audit value).
ALTER TABLE "narrative_draft" ADD CONSTRAINT "narrative_draft_activity_fk"
	FOREIGN KEY ("activity_id") REFERENCES "public"."activity"("id") ON DELETE CASCADE ON UPDATE no action;
--> statement-breakpoint

-- ============================================================
-- RLS — same FORCE + USING + WITH CHECK pattern as 0002 / 0006 / 0008
-- / 0009 / 0010 / 0012 / 0013 / 0016 / 0018 / 0022. NULLIF wraps
-- current_setting so an unset GUC fails-safe to "deny everything"
-- (see 0003 commentary). FORCE is required even on owner-controlled
-- tables, otherwise the cpa role bypasses RLS.
-- ============================================================

ALTER TABLE "narrative_draft" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "narrative_draft" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "narrative_draft_tenant_isolation" ON "narrative_draft"
	USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "narrative_draft" TO cpa_app;
--> statement-breakpoint

-- Per-activity scan index — powers "list all drafts for activity X"
-- in the consultant review UI. Composite (tenant_id, activity_id) so
-- the planner can satisfy the WHERE-clause through an index scan.
CREATE INDEX "narrative_draft_activity_idx" ON "narrative_draft" USING btree ("tenant_id","activity_id");
--> statement-breakpoint

-- Partial index on status='streaming' — speeds the stale-streaming-
-- cleanup job from Task 5.7. The job scans ONLY streaming rows
-- (drafts where the agent crashed mid-stream); making this a partial
-- index keeps the scan O(streaming-rows) not O(all-rows). Streaming
-- is a transient state — most drafts move to 'complete' within
-- seconds — so the partial index stays small in steady state.
CREATE INDEX "narrative_draft_status_idx" ON "narrative_draft" USING btree ("tenant_id","status") WHERE "status" = 'streaming';
