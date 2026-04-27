import { privilegedSql } from '@cpa/db/client';

/**
 * Time-entry conflict resolution helper (T-B21).
 *
 * Payroll-imported entries are the source of truth for an employee's
 * timesheet. When the same employee has logged manual time on the
 * mobile app and that time overlaps a freshly-pulled payroll period,
 * the manual entry is suspect — duplicate counting, or the consultant
 * never told the employee that payroll was being synced. Rather than
 * silently delete or merge, we *flag* the manual entry so the
 * consultant can resolve it during apportionment review.
 *
 * Postgres' `tstzrange` + `&&` (range overlap) is the cleanest way to
 * test "does the manual entry's [started_at, ended_at) interval
 * intersect the just-pulled payroll period?". The default range is
 * `[start, end)` (lower-inclusive, upper-exclusive) which matches the
 * mental model "9-5 entries don't overlap a 5-9 entry". Already-flagged
 * manual entries are skipped (idempotency — re-running the sync should
 * not re-stamp `flagged_at`).
 *
 * Privileged SQL — same rationale as the per-provider `time-entry-pull`
 * modules. The orchestrator runs system-driven (no request-scoped
 * tenant context), so we bypass RLS via the migration role.
 *
 * Returns the count of rows flagged so the orchestrator can log/audit.
 */

export type SqlClient = typeof privilegedSql;

export interface FlagOverlappingManualEntriesOpts {
  /** Consultant firm id; carried for symmetry with the per-provider helpers. */
  tenant_id: string;
  /** Claimant id — matches the just-pulled payroll batch. */
  subject_tenant_id: string;
  /** Local subject_tenant_employee.id — the employee who got the payroll row. */
  employee_id: string;
  /** Lower bound of the payroll-pulled period (inclusive). ISO-8601 string. */
  period_start: string;
  /** Upper bound of the payroll-pulled period (exclusive). ISO-8601 string. */
  period_end: string;
  /** Override for tests; defaults to the privileged DB client. */
  sql_client?: SqlClient;
}

/**
 * Flag manual time_entry rows whose [started_at, ended_at) interval
 * overlaps [period_start, period_end). Returns the number of rows
 * flagged. Already-flagged rows are not re-flagged (idempotent).
 *
 * NOTE on filtering by `tenant_id`: the helper takes `tenant_id` for
 * symmetry with the per-provider time-entry helpers (and so a future
 * tightened RLS path could use it), but we rely on the
 * (subject_tenant_id, employee_id) tuple — already unique per
 * employee — to scope the UPDATE. Adding `tenant_id` to the WHERE
 * clause would be redundant: subject_tenant_id is FK-scoped to a
 * tenant. Including it would also forbid a future
 * cross-tenant-shared-employee model, which is hypothetical but cheap
 * to keep open.
 */
export async function flagOverlappingManualEntries(
  opts: FlagOverlappingManualEntriesOpts,
): Promise<number> {
  const sql = opts.sql_client ?? privilegedSql;
  const rows = (await sql`
    UPDATE time_entry
       SET flagged_at = NOW()
     WHERE source = 'manual'
       AND subject_tenant_id = ${opts.subject_tenant_id}
       AND employee_id = ${opts.employee_id}
       AND tstzrange(started_at, ended_at)
           && tstzrange(${opts.period_start}::timestamptz, ${opts.period_end}::timestamptz)
       AND flagged_at IS NULL
    RETURNING id
  `) as Array<{ id: string }>;
  return rows.length;
}
