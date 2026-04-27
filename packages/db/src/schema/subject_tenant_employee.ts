import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { subjectTenant } from './subject_tenant.js';
import { tenant } from './tenant.js';
import { user } from './user.js';

/**
 * Claimant-side human — the employees of a `subject_tenant` (e.g. a R&D
 * engineer at the claimant firm) who capture evidence via the mobile app.
 *
 * Distinct from `user` (firm-side consultants signing in via OIDC). Employees
 * authenticate via magic-link → mobile_session, never via IdP.
 *
 * `tenant_id` is denormalised for index-friendly RLS — matches the P2 `event`
 * table pattern (per design doc §2.1, see also commit dc55d8b).
 *
 * `payroll_external_id` + `payroll_provider` form the matching key for the
 * payroll-sync upsert path (per design doc §5.3 step 4). Both nullable since
 * the firm may have no payroll integration yet, or an employee may be
 * created manually before being linked.
 *
 * Lifecycle: `invited_at` is set on row creation. `first_seen_at` /
 * `last_seen_at` populated by mobile login flow. `deactivated_at` is the
 * soft-delete signal — the unique-email index is partial WHERE
 * deactivated_at IS NULL so reactivation works.
 *
 * RLS-protected (T-F2 hand-authors policy in 0008):
 *   tenant_id = current_setting('app.current_tenant_id', true)::uuid
 *
 * Naming convention: camelCase TS / snake_case SQL (per T5/T6 chain).
 */
export const PAYROLL_PROVIDERS = ['employment_hero', 'keypay', 'deputy', 'xero_payroll'] as const;
export type PayrollProvider = (typeof PAYROLL_PROVIDERS)[number];

export const subjectTenantEmployee = pgTable(
  'subject_tenant_employee',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    subjectTenantId: uuid('subject_tenant_id')
      .notNull()
      .references(() => subjectTenant.id),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    email: text('email').notNull(),
    name: text('name').notNull(),
    jobTitle: text('job_title'),
    payrollExternalId: text('payroll_external_id'),
    payrollProvider: text('payroll_provider', { enum: PAYROLL_PROVIDERS }),
    invitedAt: timestamp('invited_at', { withTimezone: true }).notNull().defaultNow(),
    invitedByUserId: uuid('invited_by_user_id')
      .notNull()
      .references(() => user.id),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
  },
  (t) => ({
    activeEmailUnique: uniqueIndex('subject_tenant_employee_active_email_unique')
      .on(t.subjectTenantId, t.email)
      .where(sql`${t.deactivatedAt} IS NULL`),
  }),
);
