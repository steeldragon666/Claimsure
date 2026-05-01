-- DO NOT REGENERATE THIS MIGRATION VIA `pnpm --filter @cpa/db generate`.
-- Hand-authored migration: rebuilds the event_kind_valid CHECK to
-- INCLUDE the new ACTIVITY_REGISTER_DRAFTED kind. drizzle-kit cannot
-- generate this because CHECK constraints live outside drizzle's
-- schema model.
--
-- ============================================================
-- P6 Task 1.2 — admit ACTIVITY_REGISTER_DRAFTED on the event chain
-- ============================================================
-- The future Agent B (activity-register synthesizer) will emit
-- `ACTIVITY_REGISTER_DRAFTED` once per draft pass — a single event
-- that proposes a clustered set of `ProposedActivity` rows from the
-- raw evidence stream, each with a name, kind (core / supporting),
-- statutory anchor (Division 355 §355-25 / §355-30), rationale, and
-- the underlying `clustered_event_ids` that fed the cluster. The
-- chain (rather than audit_log) is the canonical home so the draft
-- survives in the per-claimant hash chain alongside the EXPENDITURE_
-- CLASSIFIED decisions Agent A produced earlier in the pipeline.
--
-- Mirrors 0026 (DROP+ADD CHECK pattern); see that migration for the
-- full rationale on the constraint-rebuild idiom and why the kind
-- list must stay byte-for-byte aligned with EVIDENCE_KINDS in
-- @cpa/db/schema/event.ts and `evidenceKind` in @cpa/schemas/event.ts.
--
-- The Zod payload schema in @cpa/schemas/event.ts
-- (`ActivityRegisterDraftedPayload`) enforces the wire shape: an
-- array of `ProposedActivity`, the unclustered_event_ids tail, the
-- input/truncation accounting fields, plus model / prompt_version /
-- idempotency_key for replay safety. This migration only admits the
-- kind on the chain CHECK — payload validation lives on the schema/
-- agent side. The list mirrors 0026 byte-for-byte plus the new entry
-- at the tail.
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
    'ACTIVITY_REGISTER_DRAFTED'
  )
);
