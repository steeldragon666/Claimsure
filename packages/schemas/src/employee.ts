import { z } from 'zod';
import { Iso8601, Uuid } from './primitives.js';

/**
 * Payroll provider enum (T-F6).
 *
 * Mirrors `PAYROLL_PROVIDERS` in @cpa/db/schema/subject_tenant_employee.ts —
 * the canonical list lives DB-side (CHECK constraint), this enum is the API
 * contract. Keep both in sync; a PR that adds a provider must touch both.
 *
 * Owned by the employee schema rather than a shared file because the only
 * consumer is the `subject_tenant_employee` row contract; payroll-side
 * timesheet ingestion (D14-D15) will reuse this enum directly.
 */
export const PAYROLL_PROVIDERS = ['employment_hero', 'keypay', 'deputy', 'xero_payroll'] as const;
export const payrollProvider = z.enum(PAYROLL_PROVIDERS);
export type PayrollProvider = z.infer<typeof payrollProvider>;

/**
 * Public shape of a `subject_tenant_employee` row over the API.
 *
 * Timestamps are ISO-8601 with offset (matches the audit-anchor convention
 * used across @cpa/schemas).
 *
 * No raw magic-link tokens are ever returned — the invite flow logs/sends
 * the link and stores only the SHA-256 hash. Listings + detail responses
 * use this shape.
 */
export const employee = z.object({
  id: Uuid,
  subject_tenant_id: Uuid,
  tenant_id: Uuid,
  email: z.string().email(),
  name: z.string(),
  job_title: z.string().nullable(),
  payroll_external_id: z.string().nullable(),
  payroll_provider: payrollProvider.nullable(),
  invited_at: Iso8601,
  invited_by_user_id: Uuid,
  first_seen_at: Iso8601.nullable(),
  last_seen_at: Iso8601.nullable(),
  deactivated_at: Iso8601.nullable(),
});
export type Employee = z.infer<typeof employee>;

/**
 * POST /v1/employees body.
 *
 * `subject_tenant_id` is required — the consultant must say WHICH claimant
 * they're inviting under (firms can have multiple claimants).
 *
 * `payroll_external_id` + `payroll_provider` are optional at invite time;
 * payroll-sync (D14-D15) backfills them later by matching on email.
 */
export const createEmployeeBody = z.object({
  subject_tenant_id: Uuid,
  email: z.string().email(),
  name: z.string().min(1).max(200),
  job_title: z.string().max(200).optional(),
  payroll_external_id: z.string().max(200).optional(),
  payroll_provider: payrollProvider.optional(),
});
export type CreateEmployeeBody = z.infer<typeof createEmployeeBody>;

/**
 * GET /v1/employees query — narrow by claimant.
 *
 * Omit to list all visible employees in the active firm (RLS already
 * scopes to the active tenant; the additional `subject_tenant_id` filter
 * is for the common "show me ACME's employees" UI case).
 */
export const listEmployeesQuery = z.object({
  subject_tenant_id: Uuid.optional(),
});
export type ListEmployeesQuery = z.infer<typeof listEmployeesQuery>;
