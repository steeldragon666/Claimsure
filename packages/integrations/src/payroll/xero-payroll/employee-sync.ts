import { privilegedSql } from '@cpa/db/client';
import { listEmployees } from './client.js';
import type { XeroPayrollClientOptions } from './client.js';

/**
 * Xero Payroll AU employee sync (T-B19).
 *
 * Walks every page of the Xero `/Employees` endpoint (filtered by
 * `If-Modified-Since` for incremental sync) and upserts each row into
 * `subject_tenant_employee` keyed by `(subject_tenant_id, email) WHERE
 * deactivated_at IS NULL` (the existing partial unique index).
 *
 * Xero-specific mappings vs. the EH/KeyPay/Deputy variants:
 *   - `EmployeeID` is a **GUID** (string) — already a string, no
 *     coercion needed for `payroll_external_id`. Xero is the only
 *     provider here that uses GUIDs across the board.
 *   - `Status` is an enum: ACTIVE | INACTIVE | TERMINATED. Both
 *     INACTIVE and TERMINATED → set `deactivated_at = NOW()`.
 *   - `Email` may be null (similar to KeyPay/Deputy); null/empty emails
 *     are skipped because mobile auth requires email for the
 *     magic-link flow.
 *   - `payroll_provider` is `'xero_payroll'`.
 *   - The `name` is built from `FirstName + ' ' + LastName` (Xero's
 *     PascalCase fields, similar to Deputy).
 *   - `JobTitle` (Xero's job-title field) maps to `job_title`.
 *
 * Privileged SQL — same rationale as `deputy/employee-sync.ts`. Tests
 * inject a mock `sql_client` mirroring the postgres-js template-tag
 * interface.
 */

export type SqlClient = typeof privilegedSql;

export type SyncEmployeesOpts = XeroPayrollClientOptions & {
  tenant_id: string;
  subject_tenant_id: string;
  invited_by_user_id: string;
  changed_since?: Date;
  /** Override for tests; defaults to the privileged DB client. */
  sql_client?: SqlClient;
};

export type SyncEmployeesResult = {
  upserted: number;
  deactivated: number;
};

export async function syncEmployees(opts: SyncEmployeesOpts): Promise<SyncEmployeesResult> {
  const sql = opts.sql_client ?? privilegedSql;
  let page: number | null = 1;
  let upserted = 0;
  let deactivated = 0;

  while (page !== null) {
    const filters: { changed_since?: Date; page?: number } = { page };
    if (opts.changed_since) filters.changed_since = opts.changed_since;
    const { employees, next_page } = await listEmployees(opts, filters);

    for (const e of employees) {
      const email = e.Email;
      if (!email) continue;

      const fullName = `${e.FirstName} ${e.LastName}`.trim();
      // GUID is already a string — no coercion.
      const externalId = e.EmployeeID;

      // Upsert by the partial unique index `(subject_tenant_id, email)
      // WHERE deactivated_at IS NULL`. Re-running the sync is
      // idempotent; Xero-side edits (JobTitle, name) flow through.
      await sql`
        INSERT INTO subject_tenant_employee (
          subject_tenant_id, tenant_id, email, name, job_title,
          payroll_external_id, payroll_provider, invited_at, invited_by_user_id
        ) VALUES (
          ${opts.subject_tenant_id}, ${opts.tenant_id}, ${email}, ${fullName},
          ${e.JobTitle ?? null}, ${externalId}, 'xero_payroll', NOW(), ${opts.invited_by_user_id}
        )
        ON CONFLICT (subject_tenant_id, email) WHERE deactivated_at IS NULL
        DO UPDATE SET
          name = EXCLUDED.name,
          job_title = EXCLUDED.job_title,
          payroll_external_id = EXCLUDED.payroll_external_id,
          payroll_provider = EXCLUDED.payroll_provider
      `;
      upserted++;

      if (e.Status === 'TERMINATED' || e.Status === 'INACTIVE') {
        await sql`
          UPDATE subject_tenant_employee
             SET deactivated_at = NOW()
           WHERE subject_tenant_id = ${opts.subject_tenant_id}
             AND payroll_external_id = ${externalId}
             AND deactivated_at IS NULL
        `;
        deactivated++;
      }
    }

    page = next_page;
  }

  return { upserted, deactivated };
}
