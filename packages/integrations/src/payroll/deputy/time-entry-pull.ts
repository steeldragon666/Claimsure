import { privilegedSql } from '@cpa/db/client';
import { listTimesheets } from './client.js';
import type { DeputyClientOptions } from './client.js';
import type { SqlClient } from './employee-sync.js';

/**
 * Deputy timesheet pull (T-B16).
 *
 * Walks every page of the Deputy timesheets endpoint and upserts each
 * row into `time_entry` keyed by the partial unique index
 * `(source, external_id) WHERE external_id IS NOT NULL`. Re-running the
 * sync is idempotent.
 *
 * Deputy-specific mappings vs. the EH/KeyPay variants:
 *   - `Id` is **numeric**; coerced to string for `time_entry.external_id`.
 *   - `StartTime` / `EndTime` are **unix seconds** (vs EH's ISO strings
 *     and KeyPay's HH:MM strings). We convert to ISO timestamps via
 *     `new Date(unix * 1000).toISOString()` before inserting into
 *     `started_at` / `ended_at`. Unlike KeyPay's HH:MM-without-tz
 *     wire format, Deputy's unix-seconds value is unambiguous.
 *   - `TotalTime` is hours (decimal); converted to integer minutes via
 *     `Math.round(TotalTime * 60)` for `time_entry.duration_minutes`.
 *   - `Discarded === 1` → SKIP. Deputy uses `Discarded` as a soft-delete
 *     marker; the backend keeps the row for audit, but it should not
 *     count toward R&D apportionment. We bump no counter — these are
 *     intentional omissions, not failures.
 *   - `source` is `'deputy'`.
 *   - Comment field is `Comment` (vs EH's `notes`, KeyPay's `comments`).
 *
 * Employee resolution: each timesheet carries `Employee` (numeric).
 * We coerce to string and look up the local
 * `subject_tenant_employee.id` by `(subject_tenant_id,
 * payroll_external_id, payroll_provider='deputy')` — filtering to rows
 * where `deactivated_at IS NULL`. Unmatched rows bump `skipped_unmatched`.
 *
 * `is_rd` defaults to true: same rationale as the EH/KeyPay variants.
 *
 * Privileged SQL — same rationale as `employment-hero/time-entry-pull.ts`.
 */

export type PullTimesheetsOpts = DeputyClientOptions & {
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
  skipped_discarded: number;
};

export async function pullTimesheets(opts: PullTimesheetsOpts): Promise<PullTimesheetsResult> {
  const sql = opts.sql_client ?? privilegedSql;
  let cursor: number | null = null;
  let inserted = 0;
  let updated = 0;
  let skipped_unmatched = 0;
  let skipped_discarded = 0;

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
      // Soft-deleted rows on Deputy's side — never insert.
      if (t.Discarded === 1) {
        skipped_discarded++;
        continue;
      }

      const employeeExternalId = String(t.Employee);

      // Resolve the Deputy Employee id → local subject_tenant_employee.id.
      const empRows = (await sql`
        SELECT id FROM subject_tenant_employee
         WHERE subject_tenant_id = ${opts.subject_tenant_id}
           AND payroll_external_id = ${employeeExternalId}
           AND payroll_provider = 'deputy'
           AND deactivated_at IS NULL
      `) as Array<{ id: string }>;
      const emp = empRows[0];
      if (!emp) {
        skipped_unmatched++;
        continue;
      }

      // Compose ISO timestamps from Deputy's unix-seconds fields.
      const startedAt = new Date(t.StartTime * 1000).toISOString();
      const endedAt = new Date(t.EndTime * 1000).toISOString();
      const durationMinutes = Math.round(t.TotalTime * 60);
      const externalId = String(t.Id);

      const result = (await sql`
        INSERT INTO time_entry (
          tenant_id, subject_tenant_id, employee_id, source, external_id,
          started_at, ended_at, duration_minutes, is_rd, notes
        ) VALUES (
          ${opts.tenant_id}, ${opts.subject_tenant_id}, ${emp.id},
          'deputy', ${externalId},
          ${startedAt}::timestamptz, ${endedAt}::timestamptz,
          ${durationMinutes}, ${true}, ${t.Comment ?? null}
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
    }

    cursor = next_cursor;
  } while (cursor);

  return { inserted, updated, skipped_unmatched, skipped_discarded };
}
