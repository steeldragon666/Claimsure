import { z } from 'zod';
import { Uuid, Iso8601 } from './primitives.js';

/**
 * Evidence kinds shown in the cross-claimant feed at /evidence.
 *
 * Subset of the full EVIDENCE_KINDS in @cpa/db. Excludes chain-internal
 * state-transition events (CLAIM_STAGE_ADVANCED, ACTIVITY_REGISTER_DRAFTED,
 * NARRATIVE_DRAFTED, FEDERATION_READ, etc.) — those belong on per-claim
 * audit timelines, not the cross-claimant evidence feed.
 *
 * Mirror in apps/api/src/routes/evidence.ts when filtering the SQL.
 */
export const EVIDENCE_FEED_KINDS = [
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
  'EVIDENCE_UPLOADED',
] as const;
export type EvidenceFeedKind = (typeof EVIDENCE_FEED_KINDS)[number];

const evidenceFeedKind = z.enum(EVIDENCE_FEED_KINDS);

/** Per-row shape returned by GET /v1/evidence. */
export const EvidenceFeedItem = z.object({
  id: Uuid,
  kind: evidenceFeedKind,
  captured_at: Iso8601,
  payload_excerpt: z.string(),
  claimant: z.object({
    id: Uuid,
    name: z.string(),
  }),
  classification: z
    .object({
      kind: z.string(),
      confidence: z.number(),
    })
    .nullable(),
  claim_id: Uuid.nullable(),
});
export type EvidenceFeedItem = z.infer<typeof EvidenceFeedItem>;

/** Response shape for GET /v1/evidence. */
export const EvidenceFeedResponse = z.object({
  items: z.array(EvidenceFeedItem),
  next_cursor: z.string().nullable(),
});
export type EvidenceFeedResponse = z.infer<typeof EvidenceFeedResponse>;

/**
 * Query params for GET /v1/evidence. All optional.
 * - kinds: CSV of EvidenceFeedKind (defaults to all 13)
 * - claimant_ids: CSV of uuids (defaults to "all visible")
 * - since: ISO8601 lower bound on captured_at
 * - limit: 1..200, default 50
 * - cursor: opaque, encodes (captured_at, id) from previous page
 */
export const evidenceQuery = z.object({
  kinds: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',') : undefined))
    .pipe(z.array(evidenceFeedKind).optional()),
  claimant_ids: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',') : undefined))
    .pipe(z.array(Uuid).optional()),
  since: Iso8601.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
export type EvidenceQuery = z.infer<typeof evidenceQuery>;
