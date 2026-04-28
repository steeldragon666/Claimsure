-- DO NOT REGENERATE THIS MIGRATION VIA `pnpm --filter @cpa/db generate`.
-- Hand-authored migration: extends the event_kind_valid CHECK constraint
-- with the PROJECT_UPDATED state-transition kind (T-A1 of the P4 plan).
-- drizzle-kit cannot generate this because CHECK constraints live outside
-- drizzle's schema model.
--
-- Rationale: PATCH /v1/projects/:id needs an event kind that accurately
-- describes a partial update. The two existing project kinds
-- (PROJECT_CREATED, PROJECT_ARCHIVED) are inception / archival markers
-- and would be misleading. PROJECT_UPDATED mirrors ACTIVITY_UPDATED
-- (added in 0014) — same {project_id, fields_changed} payload shape.
--
-- This migration touches ONLY event_kind_valid. The companion constraint
-- event_override_new_kind_valid (which restricts override_new_kind to
-- classifiable R&D evidence kinds) is intentionally left alone —
-- PROJECT_UPDATED is a state-transition event and cannot be re-classified
-- via OVERRIDE.

ALTER TABLE "event" DROP CONSTRAINT IF EXISTS event_kind_valid;
--> statement-breakpoint

ALTER TABLE "event" ADD CONSTRAINT event_kind_valid CHECK (
  kind IN (
    -- existing 13 P0–P3 kinds (do not reorder; preserve 0006 sequence)
    'HYPOTHESIS', 'DESIGN', 'EXPERIMENT', 'OBSERVATION', 'ITERATION',
    'NEW_KNOWLEDGE', 'UNCERTAINTY', 'TIME_LOG', 'ASSOCIATE_FLAG',
    'EXPENDITURE_NOTE', 'SUPPORTING', 'INELIGIBLE', 'OVERRIDE',
    -- 14 P4 state-transition kinds added in 0014_p4_evidence_kinds.sql
    'ACTIVITY_CREATED', 'ACTIVITY_UPDATED', 'ACTIVITY_LOCKED',
    'ARTEFACT_LINKED', 'ARTEFACT_UNLINKED',
    'EXPENDITURE_INGESTED', 'EXPENDITURE_LINE_MAPPED',
    'EXPENDITURE_LINE_UNMAPPED', 'EXPENDITURE_VOIDED',
    'CLAIM_STAGE_ADVANCED', 'CLAIM_SUBMITTED',
    'PROJECT_CREATED', 'PROJECT_ARCHIVED',
    'DOCUMENT_GENERATED',
    -- T-A1 addition (must match `EVIDENCE_KINDS` const in event.ts)
    'PROJECT_UPDATED'
  )
);
