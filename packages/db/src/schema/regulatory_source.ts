import { boolean, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';

/**
 * P7 Theme D Task D.8 — regulatory_source (RIF feed registry).
 *
 * Tracks the regulatory intelligence feed sources polled by the daily cron.
 * Global table (NOT RLS-protected) — shared across tenants.
 *
 * **`parser_kind`** is typed against a literal-union enum via
 * `text({ enum: ... })`. The matching CHECK constraint
 * (`regulatory_source_parser_kind_valid`) is hand-authored in
 * `0040_regulatory_intelligence.sql` because drizzle-kit can't reliably
 * round-trip CHECK constraints across regenerations.
 *
 * **`last_polled_status`** follows the same pattern with
 * `regulatory_source_last_polled_status_valid` CHECK constraint.
 */

/**
 * Single source of truth for regulatory_source parser_kind.
 * Mirrors the `regulatory_source_parser_kind_valid` CHECK constraint.
 */
export const REGULATORY_SOURCE_PARSER_KINDS = [
  'rss',
  'austlii_html',
  'business_gov_au_html',
  'isa_html',
  'industry_rss',
] as const;
export type RegulatorySourceParserKind = (typeof REGULATORY_SOURCE_PARSER_KINDS)[number];

/**
 * Single source of truth for regulatory_source last_polled_status.
 * Mirrors the `regulatory_source_last_polled_status_valid` CHECK constraint.
 */
export const REGULATORY_SOURCE_POLLED_STATUSES = [
  'success',
  'rate_limited',
  'parse_error',
  'network_error',
] as const;
export type RegulatorySourcePolledStatus = (typeof REGULATORY_SOURCE_POLLED_STATUSES)[number];

export const regulatorySource = pgTable('regulatory_source', {
  id: uuid('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  sourceName: text('source_name').notNull(),
  sourceUrl: text('source_url').notNull(),
  parserKind: text('parser_kind', { enum: REGULATORY_SOURCE_PARSER_KINDS }).notNull(),
  fetchIntervalHours: integer('fetch_interval_hours').notNull().default(24),
  lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
  lastPolledStatus: text('last_polled_status', { enum: REGULATORY_SOURCE_POLLED_STATUSES }),
  enabled: boolean('enabled').notNull().default(true),
  firstRecordedAt: timestamp('first_recorded_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Inferred row type for SELECT statements via drizzle. */
export type RegulatorySource = InferSelectModel<typeof regulatorySource>;

/** Inferred row type for INSERT statements via drizzle. */
export type NewRegulatorySource = InferInsertModel<typeof regulatorySource>;
