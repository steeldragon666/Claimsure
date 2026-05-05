import { boolean, index, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { tenant } from './tenant.js';
import { subjectTenant } from './subject_tenant.js';

/**
 * P7 Theme D Task D.5 — beneficial_ownership (UBO register).
 *
 * Records ultimate beneficial owners for each subject tenant and fiscal
 * year. Used to derive TA 2023 s4 (associate) and s5 (foreign-related)
 * flags for the R&D Tax Incentive registration form.
 *
 * **`owner_kind`** is typed against a literal-union enum via
 * `text({ enum: ... })`. The matching CHECK constraint
 * (`beneficial_ownership_owner_kind_valid`) is hand-authored in
 * `0039_compliance_capture.sql` because drizzle-kit can't reliably
 * round-trip CHECK constraints across regenerations.
 *
 * **GENERATED STORED columns** `ta_2023_4_flag` and `ta_2023_5_flag`
 * exist only in the SQL migration. They are GENERATED ALWAYS AS
 * expressions derived from `is_associate` and `is_foreign_related`
 * respectively. drizzle cannot express GENERATED STORED columns, so
 * they are intentionally omitted from this schema definition.
 *
 * RLS-protected (migration hand-authors the policy):
 *   tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
 */

/**
 * Single source of truth for beneficial_ownership owner_kind classification.
 *
 * Mirrors the `beneficial_ownership_owner_kind_valid` CHECK constraint
 * in `0039_compliance_capture.sql`. Three-way parity (this array <->
 * SQL CHECK <-> Zod enum in @cpa/schemas).
 */
export const BENEFICIAL_OWNERSHIP_OWNER_KINDS = [
  'individual',
  'entity',
  'foreign_entity',
  'associate',
] as const;
export type BeneficialOwnershipOwnerKind = (typeof BENEFICIAL_OWNERSHIP_OWNER_KINDS)[number];

export const beneficialOwnership = pgTable(
  'beneficial_ownership',
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
    ownerKind: text('owner_kind', { enum: BENEFICIAL_OWNERSHIP_OWNER_KINDS }).notNull(),
    ownerName: text('owner_name').notNull(),
    ownerCountry: text('owner_country'),
    ownershipPct: numeric('ownership_pct', { precision: 5, scale: 2 }).notNull(),
    isAssociate: boolean('is_associate').notNull().default(false),
    isForeignRelated: boolean('is_foreign_related').notNull().default(false),
    // ta_2023_4_flag and ta_2023_5_flag are GENERATED ALWAYS AS ... STORED
    // in the SQL migration. They are omitted here because drizzle cannot
    // express GENERATED STORED columns.
    firstRecordedAt: timestamp('first_recorded_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    subjectFyIdx: index('beneficial_ownership_subject_fy_idx').on(
      t.tenantId,
      t.subjectTenantId,
      t.fyLabel,
    ),
  }),
);

/** Inferred row type for SELECT statements via drizzle. */
export type BeneficialOwnership = InferSelectModel<typeof beneficialOwnership>;

/** Inferred row type for INSERT statements via drizzle. */
export type NewBeneficialOwnership = InferInsertModel<typeof beneficialOwnership>;
