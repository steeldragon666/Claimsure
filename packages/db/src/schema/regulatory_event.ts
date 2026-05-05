import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { regulatorySource } from './regulatory_source.js';

/**
 * P7 Theme D Task D.8 — regulatory_event (RIF items).
 *
 * Individual fetched regulatory items with optional AI classification.
 * Global table (NOT RLS-protected) — shared across tenants.
 *
 * **`classification_kind`** is typed against a literal-union enum via
 * `text({ enum: ... })`. The matching CHECK constraint
 * (`regulatory_event_classification_kind_valid`) is hand-authored in
 * `0040_regulatory_intelligence.sql` because drizzle-kit can't reliably
 * round-trip CHECK constraints across regenerations.
 *
 * **`classification_severity`** follows the same pattern with
 * `regulatory_event_classification_severity_valid` CHECK constraint.
 *
 * **`read_by_user_ids`** (uuid[]) and **`classification_payload`** (jsonb)
 * exist only in the SQL migration. `read_by_user_ids` is omitted because
 * drizzle does not natively support uuid[] columns. `classification_payload`
 * is modelled as jsonb via the drizzle `jsonb()` helper.
 */

/**
 * Single source of truth for regulatory_event classification_kind.
 * Mirrors the `regulatory_event_classification_kind_valid` CHECK constraint.
 */
export const REGULATORY_EVENT_KINDS = [
  'tax_alert',
  'pcg',
  'public_ruling',
  'disr_program_change',
  'form_change',
  'aat_decision',
  'art_decision',
  'isa_finding',
  'industry_guidance',
  'asx_disclosure',
  'other',
] as const;
export type RegulatoryEventKind = (typeof REGULATORY_EVENT_KINDS)[number];

/**
 * Single source of truth for regulatory_event classification_severity.
 * Mirrors the `regulatory_event_classification_severity_valid` CHECK constraint.
 */
export const REGULATORY_EVENT_SEVERITIES = ['high', 'medium', 'low', 'informational'] as const;
export type RegulatoryEventSeverity = (typeof REGULATORY_EVENT_SEVERITIES)[number];

export const regulatoryEvent = pgTable(
  'regulatory_event',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => regulatorySource.id),
    externalId: text('external_id').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    rawUrl: text('raw_url').notNull(),
    rawTitle: text('raw_title').notNull(),
    rawContent: text('raw_content'),
    classificationKind: text('classification_kind', { enum: REGULATORY_EVENT_KINDS }),
    classificationSeverity: text('classification_severity', { enum: REGULATORY_EVENT_SEVERITIES }),
    classificationPayload: jsonb('classification_payload'),
    classifiedAt: timestamp('classified_at', { withTimezone: true }),
    webhookDispatchedAt: timestamp('webhook_dispatched_at', { withTimezone: true }),
    // read_by_user_ids uuid[] is handled at query level (drizzle doesn't natively support uuid[])
    firstRecordedAt: timestamp('first_recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sourcePublishedIdx: index('regulatory_event_source_published_idx').on(
      t.sourceId,
      t.publishedAt,
    ),
    classificationKindIdx: index('regulatory_event_classification_kind_idx').on(
      t.classificationKind,
    ),
    severityIdx: index('regulatory_event_severity_idx').on(t.classificationSeverity),
    sourceExternalUniq: uniqueIndex('regulatory_event_source_external_uniq').on(
      t.sourceId,
      t.externalId,
    ),
  }),
);

/** Inferred row type for SELECT statements via drizzle. */
export type RegulatoryEvent = InferSelectModel<typeof regulatoryEvent>;

/** Inferred row type for INSERT statements via drizzle. */
export type NewRegulatoryEvent = InferInsertModel<typeof regulatoryEvent>;
