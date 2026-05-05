import { index, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { tenant } from './tenant.js';
import { activity } from './activity.js';
import { user } from './user.js';

/**
 * P7 Theme D Task D.5 — multi_entity_similarity_score (cross-entity dedup).
 *
 * Records similarity scores between pairs of R&D activities across
 * entities within the same tenant group. Used to flag potential
 * duplicate registrations that would attract regulator scrutiny.
 *
 * **`activity_b_id`** is nullable: NULL for rows representing similarity
 * against the historical-rejection corpus (regulatory_event rows). In
 * that case only `activity_a_id` references a local activity. The SQL
 * CHECK `activity_pair_ordered` permits NULL in the b-slot.
 *
 * **`similarity_kind`** and **`reviewer_disposition`** are typed against
 * literal-union enums via `text({ enum: ... })`. The matching CHECK
 * constraints are hand-authored in `0039_compliance_capture.sql`.
 *
 * RLS-protected (migration hand-authors the policy):
 *   tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
 */

/**
 * Single source of truth for multi_entity_similarity_score similarity_kind.
 *
 * Mirrors the `multi_entity_similarity_score_kind_valid` CHECK constraint
 * in `0039_compliance_capture.sql`.
 */
export const MULTI_ENTITY_SIMILARITY_KINDS = [
  'lexical',
  'semantic',
  'hybrid',
  'vs_historical_rejection',
] as const;
export type MultiEntitySimilarityKind = (typeof MULTI_ENTITY_SIMILARITY_KINDS)[number];

/**
 * Single source of truth for multi_entity_similarity_score reviewer_disposition.
 *
 * Mirrors the `multi_entity_similarity_score_disposition_valid` CHECK
 * constraint in `0039_compliance_capture.sql`. Nullable on the column —
 * these values apply only once a reviewer has assessed the similarity flag.
 */
export const MULTI_ENTITY_REVIEWER_DISPOSITIONS = [
  'benign_overlap',
  'requires_differentiation',
  'duplicate_must_remove',
] as const;
export type MultiEntityReviewerDisposition = (typeof MULTI_ENTITY_REVIEWER_DISPOSITIONS)[number];

export const multiEntitySimilarityScore = pgTable(
  'multi_entity_similarity_score',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    activityAId: uuid('activity_a_id')
      .notNull()
      .references(() => activity.id),
    activityBId: uuid('activity_b_id').references(() => activity.id),
    similarityScore: numeric('similarity_score', { precision: 4, scale: 3 }).notNull(),
    similarityKind: text('similarity_kind', { enum: MULTI_ENTITY_SIMILARITY_KINDS }).notNull(),
    flaggedAt: timestamp('flagged_at', { withTimezone: true }).notNull().defaultNow(),
    reviewedByUserId: uuid('reviewed_by_user_id').references(() => user.id),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewerDisposition: text('reviewer_disposition', {
      enum: MULTI_ENTITY_REVIEWER_DISPOSITIONS,
    }),
  },
  (t) => ({
    activityAIdx: index('multi_entity_similarity_score_activity_a_idx').on(
      t.tenantId,
      t.activityAId,
    ),
    activityBIdx: index('multi_entity_similarity_score_activity_b_idx').on(
      t.tenantId,
      t.activityBId,
    ),
  }),
);

/** Inferred row type for SELECT statements via drizzle. */
export type MultiEntitySimilarityScore = InferSelectModel<typeof multiEntitySimilarityScore>;

/** Inferred row type for INSERT statements via drizzle. */
export type NewMultiEntitySimilarityScore = InferInsertModel<typeof multiEntitySimilarityScore>;
