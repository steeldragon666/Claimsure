import { privilegedSql } from '@cpa/db/client';

/**
 * Trial expiry cron job (P9.1.6.2).
 *
 * Runs daily. Finds every tenant whose trial has lapsed
 * (trial_status = 'active' AND trial_ends_at <= NOW()) and marks them
 * as trial_status = 'expired'. Converted tenants are never touched.
 *
 * The job is intentionally idempotent: a tenant already marked 'expired'
 * is not in the WHERE clause and therefore not re-processed.
 */

export type TrialExpiryCronResult = {
  /** Count of tenants newly marked as expired. */
  expired: number;
};

/**
 * Mark all overdue active trials as expired.
 *
 * Uses privilegedSql because this runs outside any user request —
 * no tenant GUC is set, so RLS policies would reject the write.
 */
export async function runTrialExpiryCron(): Promise<TrialExpiryCronResult> {
  const rows = await privilegedSql<{ id: string }[]>`
    UPDATE tenant
       SET trial_status = 'expired',
           updated_at   = now()
     WHERE trial_status = 'active'
       AND trial_ends_at IS NOT NULL
       AND trial_ends_at <= now()
    RETURNING id
  `;

  return { expired: rows.length };
}
