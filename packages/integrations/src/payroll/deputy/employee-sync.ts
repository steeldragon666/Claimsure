import { privilegedSql } from '@cpa/db/client';
import { listEmployees } from './client.js';
import type { DeputyClientOptions } from './client.js';

/**
 * Deputy employee sync (T-B16).
 *
 * Walks every page of the Deputy employees endpoint (filtered by
 * `changed_since` for incremental sync) and upserts each row into
 * `subject_tenant_employee` keyed by `(subject_tenant_id, email) WHERE
 * deactivated_at IS NULL` (the existing partial unique index).
 *
 * Deputy-specific mappings vs. the EH/KeyPay variants:
 *   - `Id` is **numeric** in Deputy; we coerce to string for the
 *     `payroll_external_id` text column (`String(e.Id)`).
 *   - `Active` is a numeric flag (1 = active, 0 = terminated). We map
 *     `Active === 0` → set `deactivated_at = NOW()`.
 *   - `Email` may be null (similar to KeyPay); null/empty emails are
 *     skipped because mobile auth requires email for the magic-link flow.
 *   - `payroll_provider` is `'deputy'`.
 *   - The `name` is built from `FirstName + LastName` (Deputy's
 *     PascalCase fields). Deputy also exposes `DisplayName` but we
 *     prefer the structured fields so the resulting string is
 *     consistent with the EH/KeyPay variants.
 *   - `Position` (Deputy's job-title field) maps to `job_title`.
 *
 * Privileged SQL — same rationale as `employment-hero/employee-sync.ts`.
 * Tests inject a mock `sql_client` mirroring the postgres-js
 * template-tag interface.
 */

export type SqlClient = typeof privilegedSql;

export type SyncEmployeesOpts = DeputyClientOptions & {
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
  let cursor: number | null = null;
  let upserted = 0;
  let deactivated = 0;

  do {
    const filters: { changed_since?: Date; cursor?: number } = {};
    if (opts.changed_since) filters.changed_since = opts.changed_since;
    if (cursor) filters.cursor = cursor;
    const { employees, next_cursor } = await listEmployees(opts, filters);

    for (const e of employees) {
      const email = e.Email;
      if (!email) continue;

      const fullName = `${e.FirstName} ${e.LastName}`.trim();
      // Deputy numeric id → string for the text column.
      const externalId = String(e.Id);

      // Upsert by the partial unique index `(subject_tenant_id, email)
      // WHERE deactivated_at IS NULL`. Re-running the sync is
      // idempotent; Deputy-side edits (Position, name) flow through.
      await sql`
        INSERT INTO subject_tenant_employee (
          subject_tenant_id, tenant_id, email, name, job_title,
          payroll_external_id, payroll_provider, invited_at, invited_by_user_id
        ) VALUES (
          ${opts.subject_tenant_id}, ${opts.tenant_id}, ${email}, ${fullName},
          ${e.Position ?? null}, ${externalId}, 'deputy', NOW(), ${opts.invited_by_user_id}
        )
        ON CONFLICT (subject_tenant_id, email) WHERE deactivated_at IS NULL
        DO UPDATE SET
          name = EXCLUDED.name,
          job_title = EXCLUDED.job_title,
          payroll_external_id = EXCLUDED.payroll_external_id,
          payroll_provider = EXCLUDED.payroll_provider
      `;
      upserted++;

      if (e.Active === 0) {
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

    cursor = next_cursor;
  } while (cursor);

  return { upserted, deactivated };
}
