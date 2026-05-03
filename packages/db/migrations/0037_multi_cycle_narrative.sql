-- DO NOT REGENERATE THIS MIGRATION VIA `pnpm --filter @cpa/db generate`.
-- Hand-authored migration: P7 Theme A schema foundation. drizzle-kit
-- cannot fully express:
--   1. CHECK constraints (audit_log_kind_check, narrative_segment.type CHECK).
--   2. The PL/pgSQL trigger function + BEFORE UPDATE trigger that enforces
--      activity.hypothesis_formed_at immutability.
--   3. The lateral-jsonb backfill UPDATE/INSERT block.
--   4. The partial index on activity (proposed_id) WHERE proposed_id IS NOT NULL.
-- ============================================================
-- Migration 0037 — P7 Theme A schema foundation
-- ============================================================
-- Decisions: Q-Fix1=A, Q-Fix2=A, Q-Fix3=A, Q-Fix4=B, Q-Fix5=A,
--            Q-Extra1=A, Q-Extra2=A, Q-Extra3=A
-- See docs/plans/2026-05-03-p7-implementation.md Task A.1.
-- ============================================================

-- 1. narrative_segment table (Q-Fix1=A, Q-Extra1=A)
-- Field names match the canonical NarrativeSegment shape in
-- packages/schemas/src/event.ts: type, text, citing_events.
-- section_kind comes from the parent narrative_draft (not per-segment).
-- content_hash is computed per segment from text (parent draft has its own
-- content_hash spanning the whole segment list).
--
-- Includes `narrative_draft_tenant_id` so the FK to
-- narrative_draft(tenant_id, id) — whose PK is composite — can match
-- both columns. Single-column FK to narrative_draft(id) alone would
-- fail (no UNIQUE constraint on just `id`). Same composite-FK pattern
-- as narrative_draft_version (migration 0030).
CREATE TABLE "narrative_segment" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "narrative_draft_tenant_id" uuid NOT NULL,
  "narrative_draft_id" uuid NOT NULL,
  "segment_index" int NOT NULL,
  "section_kind" text NOT NULL,
  "type" text NOT NULL CHECK ("type" IN ('prose', 'claim')),
  "text" text NOT NULL,
  "citing_events" uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  "content_hash" text NOT NULL,
  "first_recorded_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("narrative_draft_id", "segment_index"),
  CONSTRAINT "narrative_segment_draft_fk" FOREIGN KEY (
    "narrative_draft_tenant_id", "narrative_draft_id"
  ) REFERENCES "narrative_draft"("tenant_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint

CREATE INDEX "narrative_segment_draft_idx"
  ON "narrative_segment" ("narrative_draft_id", "segment_index");
--> statement-breakpoint

-- Backfill from narrative_draft.segments jsonb. Each array element becomes
-- a row. WITH ORDINALITY starts at 1; we shift to 0-based segment_index.
-- Idempotency: this migration only runs once (Drizzle's journal prevents
-- re-application), but the backfill is also safe to re-run because
-- (narrative_draft_id, segment_index) is UNIQUE — duplicate INSERTs would
-- raise. We don't add ON CONFLICT because the right behavior on a
-- structural duplicate is failure (the migration runner shouldn't be
-- re-invoking this block).
INSERT INTO "narrative_segment" (
  "narrative_draft_tenant_id", "narrative_draft_id", "segment_index",
  "section_kind", "type", "text", "citing_events", "content_hash",
  "first_recorded_at"
)
SELECT
  nd.tenant_id,
  nd.id,
  (seg.idx - 1)::int,
  nd.section_kind,
  COALESCE(seg.value->>'type', 'prose'),
  COALESCE(seg.value->>'text', ''),
  COALESCE(
    (SELECT array_agg(e::uuid) FROM jsonb_array_elements_text(seg.value->'citing_events') e),
    ARRAY[]::uuid[]
  ),
  md5(COALESCE(seg.value->>'text', '')),
  nd.created_at
  FROM narrative_draft nd,
       LATERAL jsonb_array_elements(nd.segments) WITH ORDINALITY AS seg(value, idx)
 WHERE nd.segments IS NOT NULL
   AND jsonb_typeof(nd.segments) = 'array'
   AND jsonb_array_length(nd.segments) > 0;
--> statement-breakpoint

-- 2. activity.proposed_id (Q-Fix2=A)
-- Nullable: pre-P7 activities were created without an Agent B proposal
-- step, so they have no proposed_id to backfill.
ALTER TABLE "activity" ADD COLUMN "proposed_id" uuid;
--> statement-breakpoint

UPDATE "activity" a
   SET "proposed_id" = (
     SELECT (e.payload->>'proposed_id')::uuid
       FROM "event" e
      WHERE e.kind = 'ACTIVITY_REGISTER_DRAFTED'
        AND e.payload->>'activity_id' = a.id::text
        AND e.payload->>'proposed_id' IS NOT NULL
      ORDER BY e.captured_at DESC
      LIMIT 1
   )
 WHERE a."proposed_id" IS NULL;
--> statement-breakpoint

-- 3. activity.fy_label (Q-Fix3=A)
-- 'FY' || two-digit year, e.g. fiscal_year=2025 → 'FY25'. Backfilled
-- from claim.fiscal_year then made NOT NULL with a DEFAULT '' fallback
-- so future application INSERTs that haven't yet been updated to
-- include fy_label keep working; the empty string is structurally
-- discouraged by the application layer (Theme A's activity writers set
-- a real label) but the column constraint itself stays NOT NULL.
ALTER TABLE "activity" ADD COLUMN "fy_label" text;
--> statement-breakpoint

UPDATE "activity" a
   SET "fy_label" = 'FY' || ((c.fiscal_year - 2000)::text)
  FROM "claim" c
 WHERE a.claim_id = c.id
   AND a."fy_label" IS NULL;
--> statement-breakpoint

ALTER TABLE "activity" ALTER COLUMN "fy_label" SET DEFAULT '';
--> statement-breakpoint
ALTER TABLE "activity" ALTER COLUMN "fy_label" SET NOT NULL;
--> statement-breakpoint

-- 4. activity.hypothesis_formed_at + immutability (Q-Fix4=B)
-- Backfill: earliest narrative_draft.created_at for each activity, falling
-- back to activity.created_at if no drafts exist yet. Set DEFAULT now()
-- so future inserts that omit the column get a sensible "row creation
-- time IS hypothesis-formation time" semantic; Theme A's activity
-- writers set an explicit timestamp from the proposal flow.
ALTER TABLE "activity" ADD COLUMN "hypothesis_formed_at" timestamptz;
--> statement-breakpoint

UPDATE "activity" a
   SET "hypothesis_formed_at" = COALESCE(
     (SELECT MIN(nd.created_at) FROM "narrative_draft" nd WHERE nd.activity_id = a.id),
     a.created_at
   )
 WHERE a."hypothesis_formed_at" IS NULL;
--> statement-breakpoint

ALTER TABLE "activity" ALTER COLUMN "hypothesis_formed_at" SET DEFAULT now();
--> statement-breakpoint
ALTER TABLE "activity" ALTER COLUMN "hypothesis_formed_at" SET NOT NULL;
--> statement-breakpoint

-- 5. AuditKind SQL CHECK (Q-Fix5=A) — coexists with audit_log_kind_nonempty.
-- Three-way parity sites (must stay in lock-step):
--   1. packages/schemas/src/audit.ts AUDIT_KINDS (Zod enum source)
--   2. packages/db/src/schema/audit_log.ts AUDIT_KINDS (db const mirror)
--   3. THIS CHECK constraint (SQL gate)
-- A drift between any two surfaces as either a Zod parse failure (API
-- layer) or a CHECK violation (db layer) at write time.
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_kind_check" CHECK (
  "kind" IN (
    'MAPPING_RULE_CREATED',
    'MAPPING_RULE_UPDATED',
    'MAPPING_RULE_ARCHIVED',
    'HYPOTHESIS_FORMED_AT_IMMUTABILITY_VIOLATION'
  )
);
--> statement-breakpoint

-- 6. Immutability trigger (Q-Fix4=B — RAISE EXCEPTION only, no audit_log
-- INSERT). The PostgreSQL exception itself is the audit signal; the
-- transaction rolls back regardless, so any audit_log INSERT inside the
-- trigger would be discarded. Application layer wraps + logs separately
-- via the standard audit-log writer.
CREATE OR REPLACE FUNCTION enforce_hypothesis_formed_at_immutability()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'hypothesis_formed_at is immutable; backdating attempt on activity % rejected (old=%, new=%)',
    NEW.id, OLD.hypothesis_formed_at, NEW.hypothesis_formed_at
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "activity_hypothesis_formed_at_immutable"
  BEFORE UPDATE ON "activity"
  FOR EACH ROW
  WHEN (OLD.hypothesis_formed_at IS DISTINCT FROM NEW.hypothesis_formed_at)
  EXECUTE FUNCTION enforce_hypothesis_formed_at_immutability();
--> statement-breakpoint

-- 7. Partial index for proposed_id chain walk (Q-Fix2/Q-Fix3 helper).
-- Powers Theme A's "find prior-cycle activity by (tenant, proposed_id, fy)"
-- lookup. Partial because pre-P7 rows have NULL proposed_id and don't
-- belong in the chain index.
CREATE INDEX IF NOT EXISTS "activity_proposed_id_fy_idx"
  ON "activity" ("tenant_id", "proposed_id", "fy_label", "hypothesis_formed_at")
  WHERE "proposed_id" IS NOT NULL;
