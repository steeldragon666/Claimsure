-- DO NOT REGENERATE THIS MIGRATION VIA `pnpm --filter @cpa/db generate`.
-- Hand-authored migration: rebuilds the event_kind_valid CHECK to
-- INCLUDE the new FEDERATION_READ kind.
--
-- ============================================================
-- P9 Phase 3 Task 3.4 — admit FEDERATION_READ on the event chain
-- ============================================================
-- The federation audit hook emits a FEDERATION_READ event every time
-- a financier partner reads data via a federation_share. This provides
-- a tamper-evident record in the hash chain of exactly what was accessed,
-- by whom, and when.
--
-- The kind list mirrors 0028 byte-for-byte plus the new entry at the tail.

ALTER TABLE "event" DROP CONSTRAINT IF EXISTS "event_kind_valid";
--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_kind_valid" CHECK (
  "kind" IN (
    -- 13 P0-P3 evidence kinds (do not reorder; preserve 0006 sequence)
    'HYPOTHESIS', 'DESIGN', 'EXPERIMENT', 'OBSERVATION', 'ITERATION',
    'NEW_KNOWLEDGE', 'UNCERTAINTY', 'TIME_LOG', 'ASSOCIATE_FLAG',
    'EXPENDITURE_NOTE', 'SUPPORTING', 'INELIGIBLE', 'OVERRIDE',
    -- 15 P4 state-transition kinds
    'ACTIVITY_CREATED', 'ACTIVITY_UPDATED', 'ACTIVITY_LOCKED',
    'ARTEFACT_LINKED', 'ARTEFACT_UNLINKED',
    'EXPENDITURE_INGESTED', 'EXPENDITURE_LINE_MAPPED',
    'EXPENDITURE_LINE_UNMAPPED', 'EXPENDITURE_VOIDED',
    'CLAIM_STAGE_ADVANCED', 'CLAIM_SUBMITTED',
    'PROJECT_CREATED', 'PROJECT_ARCHIVED', 'PROJECT_UPDATED',
    'DOCUMENT_GENERATED',
    -- P5 Theme 5
    'EXPENDITURE_MAPPED',
    'EXPENDITURE_APPORTIONED',
    -- P6
    'EXPENDITURE_CLASSIFIED',
    'ACTIVITY_REGISTER_DRAFTED',
    'NARRATIVE_DRAFTED',
    -- P9 Phase 3 — federation audit trail
    'FEDERATION_READ'
  )
);
