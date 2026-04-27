import { privilegedSql } from '@cpa/db/client';
import { flagOverlappingManualEntries } from '../../runtime/time-entry-conflict.js';
import { listTimesheets, parseXeroDate } from './client.js';
import type { XeroPayrollClientOptions } from './client.js';
import type { SqlClient } from './employee-sync.js';

/**
 * Xero Payroll AU timesheet pull (T-B19).
 *
 * Walks every page of the Xero `/Timesheets` endpoint and expands each
 * timesheet's `TimesheetLines[]` into one `time_entry` row per work
 * day. The unique key is `(source, external_id)` where external_id is
 * `${TimesheetID}:${rawDateString}` to handle multi-line timesheets
 * (one TimesheetID may carry 5+ daily lines for a typical pay period).
 *
 * **Why per-line, not per-timesheet**: Xero AU groups lines by pay
 * period (typically weekly or fortnightly), but R&D apportionment
 * needs day-level granularity. Splitting into one entry per line
 * matches the EH/KeyPay/Deputy granularity (where each row in their
 * APIs already represents a single shift). The composite external_id
 * keeps idempotency intact — re-running the sync upserts the same
 * `${TimesheetID}:${date}` rows.
 *
 * Xero-specific mappings:
 *   - `Status === 'REJECTED'` → SKIP. Rejected timesheets shouldn't
 *     count toward R&D (consultant-rejected). Bumps `skipped_rejected`.
 *   - Each `TimesheetLines[]` entry: `Date` (parsed via parseXeroDate)
 *     becomes the day; `NumberOfUnits` is hours per day; we synthesise
 *     `started_at` = 00:00 UTC of that date and
 *     `ended_at` = started_at + duration. (Xero AU doesn't carry
 *     wall-clock start/end on individual lines — only daily totals —
 *     so we have to invent a window. Using midnight UTC is consistent
 *     across days and the duration is what apportionment cares about.)
 *   - `EmployeeID` (GUID) — already a string, no coercion.
 *   - `source` is `'xero_payroll'`.
 *   - `time_entry.notes` left null — Xero AU lines don't have a
 *     comment field. Earnings rate is metadata, not user-supplied notes.
 *
 * Employee resolution: each timesheet carries `EmployeeID` (GUID).
 * We look up the local `subject_tenant_employee.id` by
 * `(subject_tenant_id, payroll_external_id, payroll_provider='xero_payroll')`
 * filtered to non-deactivated rows. Unmatched → `skipped_unmatched`.
 *
 * `is_rd` defaults to true: same rationale as the EH/KeyPay/Deputy
 * variants.
 *
 * Privileged SQL — same rationale as `deputy/time-entry-pull.ts`.
 */

export type PullTimesheetsOpts = XeroPayrollClientOptions & {
  tenant_id: string;
  subject_tenant_id: string;
  changed_since?: Date;
  /** Override for tests; defaults to the privileged DB client. */
  sql_client?: SqlClient;
};

export type PullTimesheetsResult = {
  inserted: number;
  updated: number;
  skipped_unmatched: number;
  skipped_rejected: number;
};

export async function pullTimesheets(opts: PullTimesheetsOpts): Promise<PullTimesheetsResult> {
  const sql = opts.sql_client ?? privilegedSql;
  let page: number | null = 1;
  let inserted = 0;
  let updated = 0;
  let skipped_unmatched = 0;
  let skipped_rejected = 0;

  while (page !== null) {
    const filters: { changed_since?: Date; page?: number } = { page };
    if (opts.changed_since) filters.changed_since = opts.changed_since;
    const { timesheets, next_page } = await listTimesheets(opts, filters);

    for (const ts of timesheets) {
      // Consultant-rejected — skip wholesale, don't count any of the
      // contained lines.
      if (ts.Status === 'REJECTED') {
        skipped_rejected++;
        continue;
      }

      // Resolve EmployeeID → local subject_tenant_employee.id once
      // per timesheet (all lines share the employee).
      const empRows = (await sql`
        SELECT id FROM subject_tenant_employee
         WHERE subject_tenant_id = ${opts.subject_tenant_id}
           AND payroll_external_id = ${ts.EmployeeID}
           AND payroll_provider = 'xero_payroll'
           AND deactivated_at IS NULL
      `) as Array<{ id: string }>;
      const emp = empRows[0];
      if (!emp) {
        skipped_unmatched++;
        continue;
      }

      const lines = ts.TimesheetLines ?? [];
      for (const line of lines) {
        const date = parseXeroDate(line.Date);
        if (!date) continue;

        // External id captures the parent timesheet + the raw date so
        // re-running the sync upserts the same row (idempotency). Use
        // the raw `line.Date` rather than the parsed Date so the key
        // is stable regardless of Xero's wire-format flavour.
        const externalId = `${ts.TimesheetID}:${line.Date}`;

        // Synthesise a wall-clock window: 00:00 UTC of the work day.
        const startedAt = new Date(date.getTime()).toISOString();
        const durationMinutes = Math.round(line.NumberOfUnits * 60);
        const endedAt = new Date(date.getTime() + durationMinutes * 60_000).toISOString();

        const result = (await sql`
          INSERT INTO time_entry (
            tenant_id, subject_tenant_id, employee_id, source, external_id,
            started_at, ended_at, duration_minutes, is_rd, notes
          ) VALUES (
            ${opts.tenant_id}, ${opts.subject_tenant_id}, ${emp.id},
            'xero_payroll', ${externalId},
            ${startedAt}::timestamptz, ${endedAt}::timestamptz,
            ${durationMinutes}, ${true}, ${null}
          )
          ON CONFLICT (source, external_id) WHERE external_id IS NOT NULL
          DO UPDATE SET
            started_at = EXCLUDED.started_at,
            ended_at = EXCLUDED.ended_at,
            duration_minutes = EXCLUDED.duration_minutes,
            notes = EXCLUDED.notes
          RETURNING (xmax = 0) AS inserted
        `) as Array<{ inserted: boolean }>;
        const wasInserted = result[0]?.inserted;
        if (wasInserted) inserted++;
        else updated++;

        // T-B21: payroll wins. Flag manual overlaps for review.
        await flagOverlappingManualEntries({
          tenant_id: opts.tenant_id,
          subject_tenant_id: opts.subject_tenant_id,
          employee_id: emp.id,
          period_start: startedAt,
          period_end: endedAt,
          sql_client: sql,
        });
      }
    }

    page = next_page;
  }

  return { inserted, updated, skipped_unmatched, skipped_rejected };
}
