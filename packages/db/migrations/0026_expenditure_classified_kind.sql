-- DO NOT REGENERATE THIS MIGRATION VIA `pnpm --filter @cpa/db generate`.
-- Hand-authored migration: rebuilds the event_kind_valid CHECK to
-- INCLUDE the new EXPENDITURE_CLASSIFIED kind. drizzle-kit cannot
-- generate this because CHECK constraints live outside drizzle's
-- schema model.
--
-- ============================================================
-- P6 Task 1.1 — admit EXPENDITURE_CLASSIFIED on the event chain
-- ============================================================
-- The future Agent A (eligibility classifier) will emit
-- `EXPENDITURE_CLASSIFIED` for every expenditure it triages — each
-- decision is a subject-tenant-scoped fact that binds an
-- `expenditure_id` to an `eligible | ineligible | needs_review`
-- decision plus the model-stated probability and statutory anchor
-- (Division 355 §355-25 / §355-30). The canonical home for those
-- decisions is the per-claimant hash chain rather than the firm-level
-- audit_log so they survive auditor review against the assurance
-- report's hash invariant.
--
-- The Zod payload schema in @cpa/schemas/event.ts
-- (`ExpenditureClassifiedPayload`) enforces the wire shape: the
-- decision enum, probability ∈ [0, 1], statutory_anchor enum, plus
-- model / prompt_version / idempotency_key for replay safety. This
-- migration only admits the kind on the chain CHECK — payload
-- validation lives on the schema/agent side.
--
-- This migration rebuilds the CHECK to admit
-- `EXPENDITURE_CLASSIFIED`, mirroring the addition to
-- `EVIDENCE_KINDS` in @cpa/db/schema/event.ts and `evidenceKind` in
-- @cpa/schemas/event.ts. The list mirrors 0025 byte-for-byte plus the
-- new entry at the tail.
-- ============================================================

ALTER TABLE "event" DROP CONSTRAINT IF EXISTS "event_kind_valid";
--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_kind_valid" CHECK (
  "kind" IN (
    -- 13 P0–P3 evidence kinds (do not reorder; preserve 0006 sequence)
    'HYPOTHESIS', 'DESIGN', 'EXPERIMENT', 'OBSERVATION', 'ITERATION',
    'NEW_KNOWLEDGE', 'UNCERTAINTY', 'TIME_LOG', 'ASSOCIATE_FLAG',
    'EXPENDITURE_NOTE', 'SUPPORTING', 'INELIGIBLE', 'OVERRIDE',
    -- 15 P4 state-transition kinds (set lifted from 0025 verbatim)
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
    'EXPENDITURE_CLASSIFIED'
  )
);
