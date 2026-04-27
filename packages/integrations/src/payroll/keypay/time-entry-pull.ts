import { privilegedSql } from '@cpa/db/client';
import { flagOverlappingManualEntries } from '../../runtime/time-entry-conflict.js';
import { listTimesheets } from './client.js';
import type { KeypayClientOptions } from './types.js';
import type { SqlClient } from './employee-sync.js';

/**
 * KeyPay timesheet pull (T-B13).
 *
 * Walks every page of the KeyPay timesheets endpoint and upserts each
 * row into `time_entry` keyed by the partial unique index
 * `(source, external_id) WHERE external_id IS NOT NULL`. Re-running the
 * sync is idempotent.
 *
 * KeyPay-specific mappings vs. the EH variant (T-B10):
 *   - `id` is **numeric**; coerced to string for `time_entry.external_id`.
 *   - Time format is `'HH:MM'` strings + a separate `date` (YYYY-MM-DD).
 *     We compose ISO timestamps as `${date}T${HH:MM}:00Z` before
 *     inserting into `started_at` / `ended_at`. This treats the times
 *     as UTC; KeyPay returns them in the business's configured timezone
 *     and does not include a tz offset on the wire — for v1 we accept
 *     this loss-of-precision since R&D apportionment cares about the
 *     date and total minutes, not the exact wall-clock instant.
 *   - `units` is hours (decimal); converted to integer minutes via
 *     `Math.round(units * 60)` for `time_entry.duration_minutes`.
 *   - `source` is `'keypay'`.
 *   - Comment field is `comments` (vs EH's `notes`).
 *
 * Employee resolution: each timesheet carries `employeeId` (numeric).
 * We coerce to string and look up the local
 * `subject_tenant_employee.id` by `(subject_tenant_id,
 * payroll_external_id, payroll_provider='keypay')` — filtering to rows
 * where `deactivated_at IS NULL`. Unmatched rows bump `skipped_unmatched`.
 *
 * `is_rd` defaults to true: same rationale as the EH variant.
 *
 * Privileged SQL — same rationale as `employment-hero/time-entry-pull.ts`.
 */

export type PullTimesheetsOpts = KeypayClientOptions & {
  tenant_id: string;
  subject_tenant_id: string;
  changed_since?: Date;
  from_date?: Date;
  to_date?: Date;
  /** Override for tests; defaults to the privileged DB client. */
  sql_client?: SqlClient;
};

export type PullTimesheetsResult = {
  inserted: number;
  updated: number;
  skipped_unmatched: number;
};

export async function pullTimesheets(opts: PullTimesheetsOpts): Promise<PullTimesheetsResult> {
  const sql = opts.sql_client ?? privilegedSql;
  let cursor: number | null = null;
  let inserted = 0;
  let updated = 0;
  let skipped_unmatched = 0;

  do {
    const filters: {
      changed_since?: Date;
      from_date?: Date;
      to_date?: Date;
      cursor?: number;
    } = {};
    if (opts.changed_since) filters.changed_since = opts.changed_since;
    if (opts.from_date) filters.from_date = opts.from_date;
    if (opts.to_date) filters.to_date = opts.to_date;
    if (cursor) filters.cursor = cursor;

    const { timesheets, next_cursor } = await listTimesheets(opts, filters);

    for (const t of timesheets) {
      const employeeExternalId = String(t.employeeId);

      // Resolve the KeyPay employeeId → local subject_tenant_employee.id.
      const empRows = (await sql`
        SELECT id FROM subject_tenant_employee
         WHERE subject_tenant_id = ${opts.subject_tenant_id}
           AND payroll_external_id = ${employeeExternalId}
           AND payroll_provider = 'keypay'
           AND deactivated_at IS NULL
      `) as Array<{ id: string }>;
      const emp = empRows[0];
      if (!emp) {
        skipped_unmatched++;
        continue;
      }

      // Compose ISO timestamps from KeyPay's split date + HH:MM fields.
      const startedAt = `${t.date}T${t.startTime}:00Z`;
      const endedAt = `${t.date}T${t.endTime}:00Z`;
      const durationMinutes = Math.round(t.units * 60);
      const externalId = String(t.id);

      const result = (await sql`
        INSERT INTO time_entry (
          tenant_id, subject_tenant_id, employee_id, source, external_id,
          started_at, ended_at, duration_minutes, is_rd, notes
        ) VALUES (
          ${opts.tenant_id}, ${opts.subject_tenant_id}, ${emp.id},
          'keypay', ${externalId},
          ${startedAt}::timestamptz, ${endedAt}::timestamptz,
          ${durationMinutes}, ${true}, ${t.comments ?? null}
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

    cursor = next_cursor;
  } while (cursor);

  return { inserted, updated, skipped_unmatched };
}
