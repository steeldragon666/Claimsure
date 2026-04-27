import { sql } from 'drizzle-orm';
import {
  boolean,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { subjectTenant } from './subject_tenant.js';
import { subjectTenantEmployee } from './subject_tenant_employee.js';
import { tenant } from './tenant.js';
import { user } from './user.js';

/**
 * Logged work — either a manual mobile entry or a row pulled from a
 * payroll integration during scheduled sync (per design doc §5.3).
 *
 * `source` discriminates origin. For payroll-sourced rows, `external_id` is
 * the upstream identifier; the partial unique index on
 * `(source, external_id) WHERE external_id IS NOT NULL` enforces dedupe so
 * re-running the sync upserts cleanly. Manual entries don't carry
 * `external_id`, hence the partial filter.
 *
 * `is_rd` flags whether the time was spent on R&D activity. Default true
 * because the consultant onboards the employee specifically for R&D time
 * capture; the consultant flips it off during apportionment review when
 * needed.
 *
 * `apportionment_pct` (0-100, NUMERIC(5,2)) reflects the portion of the
 * entry that counts toward R&D. Set by consultant during apportionment
 * review (B17). Nullable until reviewed.
 *
 * `flagged_at` marks an entry that needs consultant attention — set by the
 * payroll sync conflict-resolution path (B21) when a manual entry overlaps
 * a payroll-pulled row, or by the consultant flagging mid-review.
 *
 * RLS-protected (T-F2): tenant_id =
 *   current_setting('app.current_tenant_id', true)::uuid
 *
 * Naming convention: camelCase TS / snake_case SQL.
 */
export const TIME_ENTRY_SOURCES = [
  'manual',
  'employment_hero',
  'keypay',
  'deputy',
  'xero_payroll',
] as const;
export type TimeEntrySource = (typeof TIME_ENTRY_SOURCES)[number];

export const timeEntry = pgTable(
  'time_entry',
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
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => subjectTenantEmployee.id),
    source: text('source', { enum: TIME_ENTRY_SOURCES }).notNull(),
    externalId: text('external_id'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }).notNull(),
    durationMinutes: integer('duration_minutes').notNull(),
    isRd: boolean('is_rd').notNull().default(true),
    apportionmentPct: numeric('apportionment_pct', { precision: 5, scale: 2 }),
    apportionedByUserId: uuid('apportioned_by_user_id').references(() => user.id),
    apportionedAt: timestamp('apportioned_at', { withTimezone: true }),
    notes: text('notes'),
    flaggedAt: timestamp('flagged_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    payrollSourceDedupeUnique: uniqueIndex('time_entry_payroll_source_dedupe_unique')
      .on(t.source, t.externalId)
      .where(sql`${t.externalId} IS NOT NULL`),
  }),
);
