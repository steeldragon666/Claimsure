import { z } from 'zod';
import { Iso8601, Sha256Hash, Uuid } from './primitives.js';
import { ActivityKind } from './activity.js';
import { CLAIM_STAGES_LITERAL } from './claim.js';
import { EXPENDITURE_SOURCES_LITERAL } from './expenditure.js';

/**
 * Evidence-kind taxonomy — the wire-format mirror of the DB column
 * `event.kind`. This is the value `/v1/events` returns for both
 * `kind` and `effective_kind`, so it must accept every kind the DB
 * column accepts.
 *
 * Dual SOT pattern: `@cpa/schemas` (Zod, wire format) and `@cpa/db`
 * (Drizzle, storage) are intentionally independent SOTs — schemas
 * describes the API surface and must not import from db (that would
 * invert the layering and pull storage internals into the wire
 * contract). The two lists must therefore be kept in sync by hand.
 *
 * KEEP IN SYNC WITH:
 *   1. `EVIDENCE_KINDS` in `@cpa/db/schema/event.ts`
 *   2. The `event_kind_valid` CHECK in `migrations/0006_fair_network.sql`,
 *      `migrations/0014_p4_evidence_kinds.sql`, and
 *      `migrations/0015_project_updated_kind.sql`
 *
 * Order matches `@cpa/db` byte-for-byte: the first 13 entries
 * (HYPOTHESIS through OVERRIDE) are R&D evidence classifications;
 * the 15 P4 entries are state-transition events (entity created,
 * claim advanced, etc.) and cannot be re-classified via OVERRIDE
 * (see {@link classifiableKind}, which is the override-eligible
 * subset and is unchanged from P0–P3).
 */
export const evidenceKind = z.enum([
  'HYPOTHESIS',
  'DESIGN',
  'EXPERIMENT',
  'OBSERVATION',
  'ITERATION',
  'NEW_KNOWLEDGE',
  'UNCERTAINTY',
  'TIME_LOG',
  'ASSOCIATE_FLAG',
  'EXPENDITURE_NOTE',
  'SUPPORTING',
  'INELIGIBLE',
  'OVERRIDE',
  // P4 state-transition events (must match `EVIDENCE_KINDS` in
  // @cpa/db/schema/event.ts and the CHECK in 0014_p4_evidence_kinds.sql /
  // 0015_project_updated_kind.sql)
  'ACTIVITY_CREATED',
  'ACTIVITY_UPDATED',
  'ACTIVITY_LOCKED',
  'ARTEFACT_LINKED',
  'ARTEFACT_UNLINKED',
  'EXPENDITURE_INGESTED',
  'EXPENDITURE_LINE_MAPPED',
  'EXPENDITURE_LINE_UNMAPPED',
  'EXPENDITURE_VOIDED',
  'CLAIM_STAGE_ADVANCED',
  'CLAIM_SUBMITTED',
  'PROJECT_CREATED',
  'PROJECT_ARCHIVED',
  'DOCUMENT_GENERATED',
  // Added in T-A1 (0015_project_updated_kind.sql) — emitted by
  // PATCH /v1/projects/:id, mirrors ACTIVITY_UPDATED.
  'PROJECT_UPDATED',
]);
export type EvidenceKind = z.infer<typeof evidenceKind>;

/**
 * Subset of {@link evidenceKind} that the classifier may output. Excludes
 * OVERRIDE because that's a human reviewer decision, not a model classification.
 */
export const classifiableKind = z.enum([
  'HYPOTHESIS',
  'DESIGN',
  'EXPERIMENT',
  'OBSERVATION',
  'ITERATION',
  'NEW_KNOWLEDGE',
  'UNCERTAINTY',
  'TIME_LOG',
  'ASSOCIATE_FLAG',
  'EXPENDITURE_NOTE',
  'SUPPORTING',
  'INELIGIBLE',
]);
export type ClassifiableKind = z.infer<typeof classifiableKind>;

/**
 * Classifier output payload, persisted as JSON in `event.classification`.
 * Confidence is the model's stated 0..1 score; rationale is a short human-
 * readable justification; statutory_anchor is a Division 355 reference
 * (or null for kinds without a clean anchor).
 */
export const classification = z.object({
  kind: classifiableKind,
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
  statutory_anchor: z.string().nullable(),
  model: z.string(),
  prompt_version: z.string(),
  tokens_in: z.number().int().nonnegative(),
  tokens_out: z.number().int().nonnegative(),
});
export type Classification = z.infer<typeof classification>;

/**
 * The shape returned by /v1/events endpoints. Reads from the
 * event_with_effective_kind view so override resolution + is_overridden
 * are pre-joined.
 *
 * Snake_case JSON to match the wire format in chain.ts (canonicaliseEvent
 * uses snake_case keys for hash determinism). Frontend should consume
 * verbatim.
 */
export const event = z.object({
  id: Uuid,
  tenant_id: Uuid,
  subject_tenant_id: Uuid,
  project_id: Uuid.nullable(),
  milestone_id: Uuid.nullable(),
  kind: evidenceKind,
  effective_kind: evidenceKind,
  is_overridden: z.boolean(),
  payload: z.unknown(),
  classification: classification.nullable(),
  override_of_event_id: Uuid.nullable(),
  override_new_kind: classifiableKind.nullable(),
  override_reason: z.string().nullable(),
  prev_hash: Sha256Hash.nullable(),
  hash: Sha256Hash,
  idempotency_key: Sha256Hash.nullable(),
  captured_at: Iso8601,
  captured_by_user_id: Uuid,
  received_at: Iso8601,
});
export type Event = z.infer<typeof event>;

/**
 * POST /v1/events body — the user-pasted text + the subject_tenant context.
 * captured_at defaults to NOW() on the server when omitted; clients can
 * supply it to backdate (e.g. importing a notebook entry from last week).
 */
export const createEventBody = z.object({
  subject_tenant_id: Uuid,
  raw_text: z.string().min(1).max(10_000),
  captured_at: Iso8601.optional(),
});
export type CreateEventBody = z.infer<typeof createEventBody>;

/**
 * Voice-event variant of POST /v1/mobile/events (T-A4 + T-A11).
 *
 * `source: 'voice'` selects the voice path: an `audio_s3_key` is
 * already populated on S3 by the time the route is called; the route
 * inserts a placeholder event (kind=SUPPORTING, payload.source=
 * 'voice_pending') and best-effort enqueues the transcribe job.
 *
 * `audio_mime_type` and `duration_ms` are surfaced so the assurance
 * report can render a "voice note: 12s" badge before the transcript
 * comes back.
 */
export const mobileEventVoiceVariant = z.object({
  source: z.literal('voice'),
  audio_s3_key: z.string().min(1).max(1024),
  audio_mime_type: z.string().min(1).max(64),
  duration_ms: z.number().int().nonnegative(),
});
export type MobileEventVoiceVariant = z.infer<typeof mobileEventVoiceVariant>;

/**
 * Hypothesis-prompt variant of POST /v1/mobile/events (T-A10 + T-A11).
 *
 * `source: 'hypothesis_prompt'` selects the hypothesis path: the
 * three free-text fields go straight into the event payload, kind is
 * forced to HYPOTHESIS (no classifier round-trip — the form IS the
 * classification), and the route synthesises a classification row
 * with model='mobile-hypothesis-form' so downstream assurance views
 * can still filter by `classification IS NOT NULL`.
 *
 * Length caps mirror the inputs the screen validates (non-empty +
 * <= 2000 chars each).
 */
export const mobileEventHypothesisVariant = z.object({
  source: z.literal('hypothesis_prompt'),
  predicted_outcome: z.string().min(1).max(2000),
  success_criteria: z.string().min(1).max(2000),
  uncertainty: z.string().min(1).max(2000),
});
export type MobileEventHypothesisVariant = z.infer<typeof mobileEventHypothesisVariant>;

/**
 * Discriminated union of every payload variant POST /v1/mobile/events
 * accepts. Add a new variant by appending to the discriminator —
 * existing variants stay untouched, and zod's runtime + TS type
 * narrowing both pick up the new branch automatically.
 */
export const mobileEventPayload = z.discriminatedUnion('source', [
  mobileEventVoiceVariant,
  mobileEventHypothesisVariant,
]);
export type MobileEventPayload = z.infer<typeof mobileEventPayload>;

/**
 * POST /v1/mobile/events body wrapper (T-A4 + T-A11).
 *
 * `subject_tenant_id` is OPTIONAL — when omitted the server derives
 * it from the mobile JWT's bound claimant. `captured_at_local` is the
 * device-clock ms epoch (number) — server stores it verbatim in the
 * event payload alongside the canonical server-side captured_at.
 *
 * The discriminator on `payload.source` decides the variant: voice
 * (existing path → SUPPORTING placeholder + transcribe job) vs.
 * hypothesis_prompt (new in A11 → HYPOTHESIS kind, classifier
 * synthesised inline).
 */
export const createMobileEventBody = z.object({
  subject_tenant_id: Uuid.optional(),
  captured_at_local: z.number().int().nonnegative(),
  payload: mobileEventPayload,
});
export type CreateMobileEventBody = z.infer<typeof createMobileEventBody>;

/**
 * GET /v1/events filter modes (per design doc §4):
 *
 *   - all: every visible event for the subject_tenant
 *   - needs_review: classifier-emitted, low-confidence, not yet overridden
 *   - ineligible: effective_kind = 'INELIGIBLE' (after override resolution)
 *   - overrides: only the OVERRIDE rows (auditor view)
 */
export const listEventsFilter = z.enum(['all', 'needs_review', 'ineligible', 'overrides']);
export type ListEventsFilter = z.infer<typeof listEventsFilter>;

/**
 * GET /v1/events query.
 *
 * limit defaults to 50 (max 200) — matches the consultant portal feed
 * default. cursor is opaque base64; clients pass next_cursor verbatim
 * to get the next page.
 */
export const listEventsQuery = z.object({
  subject_tenant_id: Uuid,
  filter: listEventsFilter.default('all'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
export type ListEventsQuery = z.infer<typeof listEventsQuery>;

/**
 * POST /v1/events/:id/override body.
 *
 * new_kind cannot be OVERRIDE (the classifiableKind enum excludes it).
 * reason is required and free-form — surfaces in the assurance report
 * as the auditor's rationale.
 */
export const overrideEventBody = z.object({
  new_kind: classifiableKind,
  reason: z.string().min(1).max(2000),
});
export type OverrideEventBody = z.infer<typeof overrideEventBody>;

// ---------------------------------------------------------------------------
// P4 state-transition event payload schemas (per design doc §"Event ledger,
// payload shapes by kind"). Each schema describes the `payload` JSON for the
// corresponding `evidenceKind` value above.
//
// These schemas are NOT joined into the main `event` shape (which keeps
// `payload: z.unknown()` so the discriminator can stay at the route layer).
// Routes that emit a P4 state-transition event validate against the matching
// payload schema before insert; readers that filter by kind narrow against
// the schema for that kind.
// ---------------------------------------------------------------------------

/**
 * Artefact kinds that can be linked to / unlinked from an activity. Mirrors
 * the artefact tables that exist in the system: `media_artefact` (mobile
 * upload), `event` (a captured note), `expenditure` (an invoice/bank tx),
 * `time_entry` (an apportioned time block).
 *
 * Distinct from `evidenceKind` above — `artefactKind` is the table-level
 * discriminator for the link target, not the classifier output.
 */
export const artefactKind = z.enum(['media', 'event', 'expenditure', 'time_entry']);
export type ArtefactKind = z.infer<typeof artefactKind>;

/**
 * Document kinds emitted by the P4 generator pipeline. R&DTI application
 * is the AusIndustry Module 4 PDF; reasonable-basis record is the internal
 * audit memo; KPMG letter is the consultant-facing reasonable-basis letter
 * (see C-swimlane plan).
 */
export const docKind = z.enum(['rdti_application', 'reasonable_basis_record', 'kpmg_letter']);
export type DocKind = z.infer<typeof docKind>;

/**
 * `mapped_via` discriminator on EXPENDITURE_LINE_MAPPED. `'rule'` =
 * applied automatically by the rule engine (F5); `'manual'` = consultant
 * manually attached the line to an activity.
 */
export const expenditureMappingChannel = z.enum(['rule', 'manual']);
export type ExpenditureMappingChannel = z.infer<typeof expenditureMappingChannel>;

/**
 * ACTIVITY_CREATED — emitted by POST /v1/activities once the row is
 * inserted. Carries enough denormalised context for downstream readers
 * (assurance report, auditor inbox) to render without re-joining.
 */
export const ActivityCreatedPayload = z.object({
  activity_id: Uuid,
  code: z.string(),
  kind: ActivityKind,
  title: z.string(),
  project_id: Uuid,
  claim_id: Uuid,
});
export type ActivityCreatedPayload = z.infer<typeof ActivityCreatedPayload>;

/**
 * ACTIVITY_UPDATED — emitted by PATCH /v1/activities/:id. `fields_changed`
 * is a heterogeneous record keyed by column name, with `{from, to}` pairs
 * carrying the previous and new values. The values are `unknown` because
 * the columns vary in type (string, nullable string, etc.); the route
 * layer is responsible for serialising sensibly.
 */
export const ActivityUpdatedPayload = z.object({
  activity_id: Uuid,
  fields_changed: z.record(z.string(), z.object({ from: z.unknown(), to: z.unknown() })),
});
export type ActivityUpdatedPayload = z.infer<typeof ActivityUpdatedPayload>;

/**
 * ACTIVITY_LOCKED — emitted when a consultant locks an activity to
 * prevent further edits (typically once narrative review is complete).
 */
export const ActivityLockedPayload = z.object({
  activity_id: Uuid,
  locked_by_user_id: Uuid,
  lock_reason: z.string(),
});
export type ActivityLockedPayload = z.infer<typeof ActivityLockedPayload>;

/**
 * ARTEFACT_LINKED — emitted when a media upload, event, expenditure, or
 * time entry is attached to an activity as supporting evidence.
 * `link_reason` is optional free-text rationale.
 */
export const ArtefactLinkedPayload = z.object({
  activity_id: Uuid,
  artefact_kind: artefactKind,
  artefact_id: Uuid,
  link_reason: z.string().optional(),
});
export type ArtefactLinkedPayload = z.infer<typeof ArtefactLinkedPayload>;

/**
 * ARTEFACT_UNLINKED — the inverse of ARTEFACT_LINKED. `reason` is
 * optional free-text (e.g. "wrong activity", "duplicate").
 */
export const ArtefactUnlinkedPayload = z.object({
  activity_id: Uuid,
  artefact_kind: artefactKind,
  artefact_id: Uuid,
  reason: z.string().optional(),
});
export type ArtefactUnlinkedPayload = z.infer<typeof ArtefactUnlinkedPayload>;

/**
 * EXPENDITURE_INGESTED — emitted by the Xero sync worker (or POST
 * /v1/expenditures for manual entries) once the parent expenditure row
 * and its line items are persisted. `line_count` is the number of
 * `expenditure_line` rows created in the same transaction.
 */
export const ExpenditureIngestedPayload = z.object({
  expenditure_id: Uuid,
  source: z.enum(EXPENDITURE_SOURCES_LITERAL),
  vendor_name: z.string(),
  line_count: z.number().int().nonnegative(),
});
export type ExpenditureIngestedPayload = z.infer<typeof ExpenditureIngestedPayload>;

/**
 * EXPENDITURE_LINE_MAPPED — emitted by the rule engine (F5) on auto-map,
 * or by the manual mapping route on consultant action. `mapped_via`
 * disambiguates the two paths; `rule_id` is set only for `'rule'`.
 */
export const ExpenditureLineMappedPayload = z.object({
  expenditure_line_id: Uuid,
  activity_id: Uuid,
  rd_percent: z.number().int().min(0).max(100),
  mapped_via: expenditureMappingChannel,
  rule_id: Uuid.optional(),
});
export type ExpenditureLineMappedPayload = z.infer<typeof ExpenditureLineMappedPayload>;

/**
 * EXPENDITURE_LINE_UNMAPPED — emitted when a previously-mapped line is
 * detached from its activity. `prior_activity_id` carries the value that
 * was just cleared.
 */
export const ExpenditureLineUnmappedPayload = z.object({
  expenditure_line_id: Uuid,
  prior_activity_id: Uuid,
  reason: z.string().optional(),
});
export type ExpenditureLineUnmappedPayload = z.infer<typeof ExpenditureLineUnmappedPayload>;

/**
 * EXPENDITURE_VOIDED — emitted when an expenditure is soft-voided
 * (filtered from apportionment but kept queryable for audit).
 */
export const ExpenditureVoidedPayload = z.object({
  expenditure_id: Uuid,
  voided_at: Iso8601,
  reason: z.string().optional(),
});
export type ExpenditureVoidedPayload = z.infer<typeof ExpenditureVoidedPayload>;

/**
 * CLAIM_STAGE_ADVANCED — emitted by PATCH /v1/claims/:id/stage. Carries
 * both stages so downstream readers can render the transition without
 * re-fetching prior state.
 */
export const ClaimStageAdvancedPayload = z.object({
  claim_id: Uuid,
  from_stage: z.enum(CLAIM_STAGES_LITERAL),
  to_stage: z.enum(CLAIM_STAGES_LITERAL),
  advanced_by_user_id: Uuid,
});
export type ClaimStageAdvancedPayload = z.infer<typeof ClaimStageAdvancedPayload>;

/**
 * CLAIM_SUBMITTED — emitted once the AusIndustry submission has been
 * accepted and the regulator-issued `ausindustry_reference` is back.
 */
export const ClaimSubmittedPayload = z.object({
  claim_id: Uuid,
  ausindustry_reference: z.string(),
  submitted_by_user_id: Uuid,
});
export type ClaimSubmittedPayload = z.infer<typeof ClaimSubmittedPayload>;

/**
 * PROJECT_CREATED — emitted by POST /v1/projects. `started_at` is
 * denormalised onto the payload so the timeline view doesn't re-join.
 */
export const ProjectCreatedPayload = z.object({
  project_id: Uuid,
  name: z.string(),
  started_at: Iso8601,
});
export type ProjectCreatedPayload = z.infer<typeof ProjectCreatedPayload>;

/**
 * PROJECT_ARCHIVED — emitted when a project is soft-archived. `reason`
 * is optional free-text (e.g. "merged into project X", "wound up").
 */
export const ProjectArchivedPayload = z.object({
  project_id: Uuid,
  archived_by_user_id: Uuid,
  reason: z.string().optional(),
});
export type ProjectArchivedPayload = z.infer<typeof ProjectArchivedPayload>;

/**
 * PROJECT_UPDATED — emitted by PATCH /v1/projects/:id. Mirrors
 * `ActivityUpdatedPayload`: `fields_changed` is a heterogeneous record
 * keyed by column name with `{from, to}` pairs carrying the previous
 * and new values. Values are `unknown` because the columns vary in type
 * (string, nullable string, ISO timestamp); the route layer is
 * responsible for serialising sensibly.
 *
 * The kind sits alongside PROJECT_CREATED / PROJECT_ARCHIVED rather
 * than reusing PROJECT_CREATED — the latter is meant to denote project
 * inception (carrying `started_at` for timeline rendering) and would be
 * misleading on a partial update.
 */
export const ProjectUpdatedPayload = z.object({
  project_id: Uuid,
  fields_changed: z.record(z.string(), z.object({ from: z.unknown(), to: z.unknown() })),
});
export type ProjectUpdatedPayload = z.infer<typeof ProjectUpdatedPayload>;

/**
 * DOCUMENT_GENERATED — emitted by the document generator pipeline once
 * a PDF/DOCX has been rendered and stored. `content_sha256` content-
 * addresses the artefact for tamper-evidence in the audit chain.
 */
export const DocumentGeneratedPayload = z.object({
  doc_kind: docKind,
  claim_id: Uuid,
  generated_for_user_id: Uuid,
  content_sha256: Sha256Hash,
});
export type DocumentGeneratedPayload = z.infer<typeof DocumentGeneratedPayload>;
