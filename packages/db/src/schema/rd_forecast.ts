import {
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { tenant } from './tenant.js';
import { subjectTenant } from './subject_tenant.js';

/**
 * P7 Theme D Task D.5 — rd_forecast (3-year spend forecast).
 *
 * Records projected R&D spend and headcount forecasts for each subject
 * tenant, anchored to a base fiscal year. Used to populate Form C and
 * Advance/Overseas Finding (ATP) applications.
 *
 * **`confidence`** is typed against a literal-union enum via
 * `text({ enum: ... })`. The matching CHECK constraint
 * (`rd_forecast_confidence_valid`) is hand-authored in
 * `0039_compliance_capture.sql`.
 *
 * **UNIQUE constraint**: `(subject_tenant_id, base_fy_label,
 * forecast_year_offset)` ensures at most one forecast row per subject
 * per base FY per offset year. The SQL constraint is named
 * `rd_forecast_subject_fy_offset_uniq`.
 *
 * RLS-protected (migration hand-authors the policy):
 *   tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
 */

/**
 * Single source of truth for rd_forecast confidence classification.
 *
 * Mirrors the `rd_forecast_confidence_valid` CHECK constraint in
 * `0039_compliance_capture.sql`. Three-way parity (this array <->
 * SQL CHECK <-> Zod enum in @cpa/schemas).
 */
export const RD_FORECAST_CONFIDENCES = ['low', 'medium', 'high'] as const;
export type RdForecastConfidence = (typeof RD_FORECAST_CONFIDENCES)[number];

export const rdForecast = pgTable(
  'rd_forecast',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    subjectTenantId: uuid('subject_tenant_id')
      .notNull()
      .references(() => subjectTenant.id),
    baseFyLabel: text('base_fy_label').notNull(),
    forecastYearOffset: integer('forecast_year_offset').notNull(),
    projectedSpendAud: numeric('projected_spend_aud', { precision: 14, scale: 2 }).notNull(),
    projectedHeadcount: integer('projected_headcount').notNull(),
    confidence: text('confidence', { enum: RD_FORECAST_CONFIDENCES }).notNull(),
    firstRecordedAt: timestamp('first_recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    subjectFyOffsetUniq: uniqueIndex('rd_forecast_subject_fy_offset_uniq').on(
      t.subjectTenantId,
      t.baseFyLabel,
      t.forecastYearOffset,
    ),
    subjectFyIdx: index('rd_forecast_subject_fy_idx').on(
      t.tenantId,
      t.subjectTenantId,
      t.baseFyLabel,
    ),
  }),
);

/** Inferred row type for SELECT statements via drizzle. */
export type RdForecast = InferSelectModel<typeof rdForecast>;

/** Inferred row type for INSERT statements via drizzle. */
export type NewRdForecast = InferInsertModel<typeof rdForecast>;
