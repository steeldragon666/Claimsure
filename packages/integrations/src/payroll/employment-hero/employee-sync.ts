import { privilegedSql } from '@cpa/db/client';
import { listEmployees, type EmploymentHeroClientOptions } from './client.js';

/**
 * Employment Hero employee sync (T-B9).
 *
 * Walks every page of the EH employees endpoint (filtered by
 * `changed_since` for incremental sync) and upserts each row into
 * `subject_tenant_employee` keyed by `(subject_tenant_id, email) WHERE
 * deactivated_at IS NULL` (the existing partial unique index).
 *
 * Termination handling: when an EH employee's `status` is 'terminated'
 * we set `deactivated_at = NOW()` on the matching row. The upsert
 * itself happens first (so the row exists / is current); the
 * deactivation runs as a follow-up UPDATE filtered by the EH external
 * id rather than email so a re-hire under a new email still works
 * cleanly.
 *
 * Empty `work_email` → skip. Mobile auth requires email so an EH row
 * without one is unusable; we'd rather drop it than insert a NULL email.
 *
 * Privileged SQL — this runs in the orchestrator context (no request),
 * so RLS would block us. The migration role bypasses RLS and is the
 * intended caller for system-driven sync. Tests inject a mock
 * `sql_client` mirroring the postgres-js template-tag interface.
 *
 * Returns counts so the orchestrator can log/audit per-tenant.
 */

export type SqlClient = typeof privilegedSql;

export type SyncEmployeesOpts = EmploymentHeroClientOptions & {
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
  let cursor: string | null = null;
  let upserted = 0;
  let deactivated = 0;

  do {
    const filters: { changed_since?: Date; cursor?: string } = {};
    if (opts.changed_since) filters.changed_since = opts.changed_since;
    if (cursor) filters.cursor = cursor;
    const { employees, next_cursor } = await listEmployees(opts, filters);

    for (const e of employees) {
      const email = e.work_email;
      if (!email) continue;

      const fullName = `${e.first_name} ${e.surname}`.trim();
      // Upsert by the partial unique index `(subject_tenant_id, email)
      // WHERE deactivated_at IS NULL`. Re-running the sync is idempotent;
      // EH-side edits (job_title, name) flow through to our row.
      await sql`
        INSERT INTO subject_tenant_employee (
          subject_tenant_id, tenant_id, email, name, job_title,
          payroll_external_id, payroll_provider, invited_at, invited_by_user_id
        ) VALUES (
          ${opts.subject_tenant_id}, ${opts.tenant_id}, ${email}, ${fullName},
          ${e.job_title ?? null}, ${e.id}, 'employment_hero', NOW(), ${opts.invited_by_user_id}
        )
        ON CONFLICT (subject_tenant_id, email) WHERE deactivated_at IS NULL
        DO UPDATE SET
          name = EXCLUDED.name,
          job_title = EXCLUDED.job_title,
          payroll_external_id = EXCLUDED.payroll_external_id,
          payroll_provider = EXCLUDED.payroll_provider
      `;
      upserted++;

      if (e.status === 'terminated') {
        await sql`
          UPDATE subject_tenant_employee
             SET deactivated_at = NOW()
           WHERE subject_tenant_id = ${opts.subject_tenant_id}
             AND payroll_external_id = ${e.id}
             AND deactivated_at IS NULL
        `;
        deactivated++;
      }
    }

    cursor = next_cursor;
  } while (cursor);

  return { upserted, deactivated };
}
