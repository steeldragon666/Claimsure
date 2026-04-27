import { privilegedSql } from '@cpa/db/client';
import { listEmployees } from './client.js';
import type { KeypayClientOptions } from './types.js';

/**
 * KeyPay employee sync (T-B13).
 *
 * Walks every page of the KeyPay employees endpoint (filtered by
 * `changed_since` for incremental sync) and upserts each row into
 * `subject_tenant_employee` keyed by `(subject_tenant_id, email) WHERE
 * deactivated_at IS NULL` (the existing partial unique index).
 *
 * KeyPay-specific mappings vs. the EH variant (T-B9):
 *   - `id` is **numeric** in KeyPay; we coerce to string for the
 *     `payroll_external_id` text column (`String(e.id)`).
 *   - `status` is `'Active' | 'Terminated'` (vs EH's tri-state). We map
 *     `'Terminated'` → set `deactivated_at = NOW()`. There is no
 *     `pending` equivalent — KeyPay doesn't expose a half-onboarded
 *     state through this endpoint.
 *   - `email` may be null (EH always has `work_email`); null/empty
 *     emails are skipped because mobile auth requires email for the
 *     magic-link flow.
 *   - `payroll_provider` is `'keypay'`.
 *   - The `name` is built as `firstName + surname` (KeyPay's field names).
 *
 * Privileged SQL — same rationale as `employment-hero/employee-sync.ts`.
 * Tests inject a mock `sql_client` mirroring the postgres-js
 * template-tag interface.
 */

export type SqlClient = typeof privilegedSql;

export type SyncEmployeesOpts = KeypayClientOptions & {
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
      const email = e.email;
      if (!email) continue;

      const fullName = `${e.firstName} ${e.surname}`.trim();
      // KeyPay numeric id → string for the text column.
      const externalId = String(e.id);

      // Upsert by the partial unique index `(subject_tenant_id, email)
      // WHERE deactivated_at IS NULL`. Re-running the sync is
      // idempotent; KeyPay-side edits (jobTitle, name) flow through.
      await sql`
        INSERT INTO subject_tenant_employee (
          subject_tenant_id, tenant_id, email, name, job_title,
          payroll_external_id, payroll_provider, invited_at, invited_by_user_id
        ) VALUES (
          ${opts.subject_tenant_id}, ${opts.tenant_id}, ${email}, ${fullName},
          ${e.jobTitle ?? null}, ${externalId}, 'keypay', NOW(), ${opts.invited_by_user_id}
        )
        ON CONFLICT (subject_tenant_id, email) WHERE deactivated_at IS NULL
        DO UPDATE SET
          name = EXCLUDED.name,
          job_title = EXCLUDED.job_title,
          payroll_external_id = EXCLUDED.payroll_external_id,
          payroll_provider = EXCLUDED.payroll_provider
      `;
      upserted++;

      if (e.status === 'Terminated') {
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
