-- DO NOT REGENERATE THIS MIGRATION VIA `pnpm --filter @cpa/db generate`.
-- Hand-authored migration: audit_log table for firm-scoped lifecycle
-- events (mapping-rule create/update/archive in P5; future firm-only
-- audit kinds in later phases). drizzle-kit cannot fully express two
-- of these:
--   1. The CHECK constraints (audit_log_kind_nonempty,
--      audit_log_payload_object) — drizzle's check() helper round-trips
--      poorly and is omitted from the schema model on this branch (see
--      existing pattern in 0006/0008/0010/0012/0013/0016/0018).
--   2. The RLS / FORCE / policy block (same hand-authored pattern as
--      0016 / 0018).
--
-- ============================================================
-- P5 Theme 2 Task 2.1 — audit_log keystone
-- ============================================================
-- Persists firm-scoped lifecycle events that don't belong on the
-- per-subject_tenant `event` chain. The B9 mapping-rule lifecycle
-- (CREATED/UPDATED/ARCHIVED) is the first consumer — those rows can't
-- live on `event` because they have no `subject_tenant_id` to anchor
-- on (mapping rules are firm-scoped — see 0018_mapping_rule.sql).
--
-- CHAIN: this table does NOT participate in the per-tenant hash chain.
-- Locked decision (design doc §2.1): "no claimant evidence is silently
-- mutated" is the chain's value prop; firm-scoped audit doesn't meet
-- that bar. Adding a chain later is a column add + backfill — reversible.
--
-- TERMINOLOGY: "firm_id" in this codebase is the consultant tenant id
-- (the white-label root). The FK references `tenant(id)` and the GUC
-- `app.current_firm_id` carries the same uuid as `app.current_tenant_id`
-- — they are set in parallel by the auth layer (see session plugin).
-- Two GUCs (not one) so that future phases can introduce a "platform
-- admin acting as firm X" stance where the two diverge.
-- ============================================================

CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"firm_id" uuid NOT NULL REFERENCES "tenant"("id") ON DELETE CASCADE,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"actor_user_id" uuid REFERENCES "user"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_kind_nonempty" CHECK ("kind" <> ''),
	CONSTRAINT "audit_log_payload_object" CHECK (jsonb_typeof("payload") = 'object')
);
--> statement-breakpoint

-- Reverse-chronological feed, scoped to one firm. Mirrors the
-- event_feed_idx pattern (subject_tenant_id, captured_at DESC) so
-- the most-recent-first list query goes through an index scan.
CREATE INDEX "audit_log_firm_idx" ON "audit_log" USING btree ("firm_id", "created_at" DESC);
--> statement-breakpoint

-- Filter-by-kind index for surfaces like "show me MAPPING_RULE_*
-- events". Composite (firm_id, kind, created_at DESC) so the planner
-- can satisfy `WHERE firm_id = $1 AND kind = $2 ORDER BY created_at
-- DESC` end-to-end without a sort.
CREATE INDEX "audit_log_kind_idx" ON "audit_log" USING btree ("firm_id", "kind", "created_at" DESC);
--> statement-breakpoint

-- ============================================================
-- RLS — same FORCE + USING + WITH CHECK pattern as 0002 / 0006 / 0008
-- / 0009 / 0010 / 0012 / 0013 / 0016 / 0018. NULLIF wraps current_setting
-- so an unset GUC fails-safe to "deny everything" (see 0003 commentary).
-- ============================================================

ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "audit_log_firm_isolation" ON "audit_log"
  USING ("firm_id" = NULLIF(current_setting('app.current_firm_id', true), '')::uuid)
  WITH CHECK ("firm_id" = NULLIF(current_setting('app.current_firm_id', true), '')::uuid);
--> statement-breakpoint

GRANT SELECT, INSERT ON "audit_log" TO cpa_app;
