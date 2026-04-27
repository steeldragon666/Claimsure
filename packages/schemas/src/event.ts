import { z } from 'zod';
import { Iso8601, Sha256Hash, Uuid } from './primitives.js';

/**
 * Evidence-kind taxonomy. Mirrors the DB CHECK constraint
 * (migration 0006) and EVIDENCE_KINDS in @cpa/db/schema/event.ts.
 *
 * Includes 'OVERRIDE' — the synthetic kind emitted by the override endpoint.
 * The classifier never produces OVERRIDE; for the model output, see
 * {@link classifiableKind}.
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
