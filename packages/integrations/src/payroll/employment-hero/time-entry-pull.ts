import { privilegedSql } from '@cpa/db/client';
import { flagOverlappingManualEntries } from '../../runtime/time-entry-conflict.js';
import { listTimesheets, type EmploymentHeroClientOptions } from './client.js';
import type { SqlClient } from './employee-sync.js';

/**
 * Employment Hero timesheet pull (T-B10).
 *
 * Walks every page of the EH timesheets endpoint and upserts each row
 * into `time_entry` keyed by the partial unique index
 * `(source, external_id) WHERE external_id IS NOT NULL`. Re-running
 * the sync is idempotent.
 *
 * Employee resolution: each timesheet carries `employee_id` (the EH
 * id). We look up the local `subject_tenant_employee.id` by
 * `(subject_tenant_id, payroll_external_id, payroll_provider)` —
 * filtering to rows where `deactivated_at IS NULL`. If no row matches
 * (e.g. the employee sync hasn't run yet, or the employee was
 * deactivated mid-cycle), we skip the timesheet and bump
 * `skipped_unmatched`. The orchestrator surfaces this count so we can
 * spot drift between the two halves of the sync.
 *
 * `is_rd` defaults to true: the consultant onboards the employee
 * specifically for R&D time capture, so the assumption is "everything
 * counts until the consultant says otherwise". Apportionment review
 * (B17) toggles it later.
 *
 * The `xmax = 0` trick distinguishes INSERT vs UPDATE in the upsert
 * RETURNING: `xmax` is the deleting/updating-transaction id stored on
 * the tuple's system header, and Postgres sets it to 0 for freshly
 * inserted rows. Returning `(xmax = 0) AS inserted` lets us bump the
 * right counter without an extra SELECT — well-known Postgres pattern.
 *
 * Privileged SQL — same rationale as `employee-sync.ts`.
 */

export type PullTimesheetsOpts = EmploymentHeroClientOptions & {
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
  let cursor: string | null = null;
  let inserted = 0;
  let updated = 0;
  let skipped_unmatched = 0;

  do {
    const filters: {
      changed_since?: Date;
      from_date?: Date;
      to_date?: Date;
      cursor?: string;
    } = {};
    if (opts.changed_since) filters.changed_since = opts.changed_since;
    if (opts.from_date) filters.from_date = opts.from_date;
    if (opts.to_date) filters.to_date = opts.to_date;
    if (cursor) filters.cursor = cursor;

    const { timesheets, next_cursor } = await listTimesheets(opts, filters);

    for (const t of timesheets) {
      // Resolve the EH employee_id → local subject_tenant_employee.id.
      // Restrict to active (non-deactivated) rows; a terminated employee
      // who later sneaks in a stray timesheet should be skipped.
      const empRows = (await sql`
        SELECT id FROM subject_tenant_employee
         WHERE subject_tenant_id = ${opts.subject_tenant_id}
           AND payroll_external_id = ${t.employee_id}
           AND payroll_provider = 'employment_hero'
           AND deactivated_at IS NULL
      `) as Array<{ id: string }>;
      const emp = empRows[0];
      if (!emp) {
        skipped_unmatched++;
        continue;
      }

      const result = (await sql`
        INSERT INTO time_entry (
          tenant_id, subject_tenant_id, employee_id, source, external_id,
          started_at, ended_at, duration_minutes, is_rd, notes
        ) VALUES (
          ${opts.tenant_id}, ${opts.subject_tenant_id}, ${emp.id},
          'employment_hero', ${t.id},
          ${t.start_time}::timestamptz, ${t.end_time}::timestamptz,
          ${t.duration_minutes}, ${true}, ${t.notes ?? null}
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

      // T-B21: payroll wins. Flag any manual entry whose interval
      // overlaps the just-upserted payroll row so the consultant
      // resolves the duplicate during apportionment review.
      await flagOverlappingManualEntries({
        tenant_id: opts.tenant_id,
        subject_tenant_id: opts.subject_tenant_id,
        employee_id: emp.id,
        period_start: t.start_time,
        period_end: t.end_time,
        sql_client: sql,
      });
    }

    cursor = next_cursor;
  } while (cursor);

  return { inserted, updated, skipped_unmatched };
}
