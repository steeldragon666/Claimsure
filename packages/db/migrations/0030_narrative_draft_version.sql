-- DO NOT REGENERATE THIS MIGRATION VIA `pnpm --filter @cpa/db generate`.
-- Hand-authored migration: narrative_draft_version table with composite
-- primary key, jsonb segments column, RLS policy, one CHECK constraint,
-- composite FK to narrative_draft, and one btree index. drizzle-kit
-- cannot fully express:
--   1. The CHECK constraint (narrative_draft_version_generation_kind_valid)
--      — drizzle's check() helper round-trips poorly and is omitted from
--      the schema model on this branch (existing pattern in
--      0006/0008/0010/0012/0013/0016/0018/0022/0029).
--   2. The RLS / FORCE / policy block (same hand-authored pattern as
--      0016 / 0018 / 0022 / 0029).
--   3. The COMPOSITE FK to narrative_draft(tenant_id, id) — drizzle's
--      `.references()` only models single-column FKs; the parent's PK
--      is composite (tenant_id, id), so a single-column FK to
--      narrative_draft.id alone would fail (id is not unique on the
--      parent without the tenant_id half).
--
-- ============================================================
-- P6 Task 1.5 — narrative_draft_version table (append-only history)
-- ============================================================
-- Append-only per-version snapshot history for narrative_draft (Task
-- 1.4, migration 0029). Every regeneration or consultant edit of a
-- live draft INSERTs one new row here, then bumps the live draft's
-- `current_version`. THIS table is the immutable record; the live
-- mutable surface is `narrative_draft`.
--
-- APPEND-ONLY ENFORCEMENT: Postgres has no built-in "append-only"
-- table mode, so we enforce it at the GRANT level — `GRANT SELECT,
-- INSERT` only, NO UPDATE / DELETE. Mirrors `audit_log` from
-- 0022_audit_log_table.sql (P5 keystone). Edits to a draft go
-- through `narrative_draft` (UPDATE allowed); narrative_draft_version
-- snapshots are written once and never mutated.
--
-- COMPOSITE FK to narrative_draft: parent's PK is (tenant_id, id),
-- so the FK MUST reference both columns. ON DELETE CASCADE — when a
-- parent draft is deleted (e.g., via the activity ON DELETE CASCADE
-- chain from migration 0029), its version history goes too. Orphan
-- version rows have no audit value once the parent draft is gone.
--
-- TENANT ISOLATION: composite PK (tenant_id, id) pins isolation
-- structurally — the same pattern as narrative_draft and the rest of
-- the tenant-scoped schema. RLS policy uses the NULLIF-wrapped
-- current_setting pattern (see 0003 commentary + 0022 audit_log
-- keystone) so an unset GUC fails-safe to "deny everything".
--
-- VERSION MONOTONICITY: enforced at the application layer (Task 5.5
-- bumps current_version on the parent and INSERTs a new row here
-- with version = current_version + 1). The UNIQUE constraint on
-- (tenant_id, draft_id, version) prevents duplicates structurally.
--
-- LINEAGE: `parent_version` is nullable. NULL on `generation_kind =
-- 'initial'` rows (the first version has no parent); populated on
-- `section_regen` and `edit` rows so the regen tree can be
-- reconstructed (e.g., "v2 was a regen of v1; v3 was an edit of v2").
--
-- INDEX rationale: `narrative_draft_version_draft_idx` on
-- (tenant_id, draft_id, version DESC) powers "give me the latest N
-- versions of this draft" queries from the consultant review UI
-- without a sort step.
-- ============================================================

CREATE TABLE "narrative_draft_version" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"version" integer NOT NULL,
	-- list of NarrativeSegment for THIS section snapshot (prose | claim)
	"segments" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	-- regen lineage; NULL on generation_kind='initial' rows
	"parent_version" integer,
	-- 'initial' | 'section_regen' | 'edit'
	"generation_kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	CONSTRAINT "narrative_draft_version_tenant_id_id_pk" PRIMARY KEY ("tenant_id","id"),
	CONSTRAINT "narrative_draft_version_draft_version_unique" UNIQUE ("tenant_id","draft_id","version"),
	CONSTRAINT "narrative_draft_version_generation_kind_valid" CHECK (
		"generation_kind" IN ('initial','section_regen','edit')
	)
);
--> statement-breakpoint

-- COMPOSITE FK to narrative_draft(tenant_id, id). The parent's PK is
-- composite, so a single-column FK to narrative_draft.id alone would
-- fail (id is not unique on the parent without the tenant_id half).
-- ON DELETE CASCADE — when a parent draft is deleted, its version
-- history goes too.
ALTER TABLE "narrative_draft_version" ADD CONSTRAINT "narrative_draft_version_draft_fk"
	FOREIGN KEY ("tenant_id","draft_id") REFERENCES "public"."narrative_draft"("tenant_id","id") ON DELETE CASCADE ON UPDATE no action;
--> statement-breakpoint

-- ============================================================
-- RLS — same FORCE + USING + WITH CHECK pattern as 0002 / 0006 / 0008
-- / 0009 / 0010 / 0012 / 0013 / 0016 / 0018 / 0022 / 0029. NULLIF
-- wraps current_setting so an unset GUC fails-safe to "deny
-- everything" (see 0003 commentary). FORCE is required even on
-- owner-controlled tables, otherwise the cpa role bypasses RLS.
-- ============================================================

ALTER TABLE "narrative_draft_version" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "narrative_draft_version" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "narrative_draft_version_tenant_isolation" ON "narrative_draft_version"
	USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
--> statement-breakpoint

-- APPEND-ONLY: SELECT + INSERT only. NO UPDATE / DELETE.
--
-- IMPORTANT: A bare `GRANT SELECT, INSERT` is NOT sufficient because
-- migration 0002 establishes `ALTER DEFAULT PRIVILEGES FOR ROLE cpa
-- IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO
-- cpa_app` — meaning every newly-created table auto-grants ALL CRUD
-- to cpa_app. To enforce append-only we must explicitly REVOKE the
-- UPDATE + DELETE that DEFAULT PRIVILEGES granted automatically.
--
-- (audit_log from 0022 has the same defect — it intends append-only
-- but only does the additive GRANT, so cpa_app can in fact UPDATE
-- audit_log today. That's a P6 retro inheritance bug to fix; this
-- migration does the right thing for narrative_draft_version.)
--
-- Postgres has no built-in append-only table mode; the GRANT/REVOKE
-- discipline is the structural enforcement. Future migrations adding
-- new app roles must preserve this restriction.
GRANT SELECT, INSERT ON "narrative_draft_version" TO cpa_app;
REVOKE UPDATE, DELETE ON "narrative_draft_version" FROM cpa_app;
--> statement-breakpoint

-- "Latest N versions of draft X" scan index. (tenant_id, draft_id,
-- version DESC) lets the planner satisfy `WHERE tenant_id = $1 AND
-- draft_id = $2 ORDER BY version DESC LIMIT N` through an index scan
-- without a sort step.
CREATE INDEX "narrative_draft_version_draft_idx" ON "narrative_draft_version" USING btree ("tenant_id","draft_id","version" DESC);
