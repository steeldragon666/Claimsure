import { boolean, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { tenant } from './tenant.js';
import { subjectTenant } from './subject_tenant.js';

/**
 * P7 Theme D Task D.5 — r_and_d_facility (facility register).
 *
 * Records R&D facilities for each subject tenant and fiscal year.
 * Used to populate Form D of the R&D Tax Incentive registration,
 * which requires disclosure of all premises where R&D activities
 * were conducted.
 *
 * **`used_for_activity_ids`** is a uuid[] column storing references
 * to the activity rows this facility was used for. This is an array
 * rather than a join table because the relationship is informational
 * (Form D display) not referential-integrity-critical.
 *
 * RLS-protected (migration hand-authors the policy):
 *   tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
 */

export const rAndDFacility = pgTable(
  'r_and_d_facility',
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
    fyLabel: text('fy_label').notNull(),
    facilityName: text('facility_name').notNull(),
    address: text('address').notNull(),
    isOwned: boolean('is_owned').notNull(),
    usedForActivityIds: uuid('used_for_activity_ids').array().notNull(),
    firstRecordedAt: timestamp('first_recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    subjectFyIdx: index('r_and_d_facility_subject_fy_idx').on(
      t.tenantId,
      t.subjectTenantId,
      t.fyLabel,
    ),
  }),
);

/** Inferred row type for SELECT statements via drizzle. */
export type RAndDFacility = InferSelectModel<typeof rAndDFacility>;

/** Inferred row type for INSERT statements via drizzle. */
export type NewRAndDFacility = InferInsertModel<typeof rAndDFacility>;
