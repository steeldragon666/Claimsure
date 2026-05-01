-- DO NOT REGENERATE THIS MIGRATION VIA `pnpm --filter @cpa/db generate`.
-- Hand-authored migration: rebuilds the event_kind_valid CHECK to
-- INCLUDE the new NARRATIVE_DRAFTED kind. drizzle-kit cannot generate
-- this because CHECK constraints live outside drizzle's schema model.
--
-- ============================================================
-- P6 Task 1.3 — admit NARRATIVE_DRAFTED on the event chain
-- ============================================================
-- The future Agent C (streaming narrative drafter) will emit
-- `NARRATIVE_DRAFTED` once per persisted narrative-section draft —
-- one event per (activity_id, section_kind, version) tuple. Each
-- event carries METADATA ONLY: the `narrative_draft_id`, the
-- `content_hash` (lowercase hex sha256 of the canonicalised
-- segments), and segment counts. The actual segments live in the
-- `narrative_draft` table created by 0029 (and the append-only
-- `narrative_draft_version` history in 0030); the auditor can
-- verify storage integrity by recomputing the hash from the
-- persisted segments and comparing it byte-for-byte against this
-- chain event.
--
-- Mirrors 0026 (DROP+ADD CHECK pattern); see that migration for the
-- full rationale on the constraint-rebuild idiom and why the kind
-- list must stay byte-for-byte aligned with EVIDENCE_KINDS in
-- @cpa/db/schema/event.ts and `evidenceKind` in @cpa/schemas/event.ts.
--
-- The Zod payload schema in @cpa/schemas/event.ts
-- (`NarrativeDraftedPayload`) enforces the wire shape:
-- narrative_draft_id, activity_id, section_kind (one of the four
-- AusIndustry submission narrative fields per design doc Section 5),
-- version, content_hash, segment_count / claim_segment_count, plus
-- model / prompt_version / idempotency_key for replay safety. This
-- migration only admits the kind on the chain CHECK — payload
-- validation lives on the schema/agent side. The list mirrors 0027
-- byte-for-byte plus the new entry at the tail.
-- ============================================================

ALTER TABLE "event" DROP CONSTRAINT IF EXISTS "event_kind_valid";
--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_kind_valid" CHECK (
  "kind" IN (
    -- 13 P0–P3 evidence kinds (do not reorder; preserve 0006 sequence)
    'HYPOTHESIS', 'DESIGN', 'EXPERIMENT', 'OBSERVATION', 'ITERATION',
    'NEW_KNOWLEDGE', 'UNCERTAINTY', 'TIME_LOG', 'ASSOCIATE_FLAG',
    'EXPENDITURE_NOTE', 'SUPPORTING', 'INELIGIBLE', 'OVERRIDE',
    -- 15 P4 state-transition kinds (set lifted from 0026 verbatim)
    'ACTIVITY_CREATED', 'ACTIVITY_UPDATED', 'ACTIVITY_LOCKED',
    'ARTEFACT_LINKED', 'ARTEFACT_UNLINKED',
    'EXPENDITURE_INGESTED', 'EXPENDITURE_LINE_MAPPED',
    'EXPENDITURE_LINE_UNMAPPED', 'EXPENDITURE_VOIDED',
    'CLAIM_STAGE_ADVANCED', 'CLAIM_SUBMITTED',
    'PROJECT_CREATED', 'PROJECT_ARCHIVED', 'PROJECT_UPDATED',
    'DOCUMENT_GENERATED',
    -- P5 Theme 5 Task 5.1 — apply-rules emitter (map_to_activity action)
    'EXPENDITURE_MAPPED',
    -- P5 Theme 5 Task 5.2 — apply-rules emitter (apportion action)
    'EXPENDITURE_APPORTIONED',
    -- P6 Task 1.1 — Agent A eligibility classifier emitter
    'EXPENDITURE_CLASSIFIED',
    -- P6 Task 1.2 — Agent B activity-register synthesizer emitter
    'ACTIVITY_REGISTER_DRAFTED',
    -- P6 Task 1.3 — Agent C narrative drafter emitter
    'NARRATIVE_DRAFTED'
  )
);
