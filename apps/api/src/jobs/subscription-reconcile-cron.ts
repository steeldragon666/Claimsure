import type Stripe from 'stripe';
import { privilegedSql } from '@cpa/db/client';

/**
 * Subscription state reconciliation cron (P9.2.8).
 *
 * Runs daily. Compares each non-terminal subscription row against the live
 * Stripe subscription and corrects any drift:
 *
 *   - Status mismatch:  updates DB status to match Stripe, reports via reporter.
 *   - Stripe 404:       marks subscription as 'cancelled' in DB, reports via reporter.
 *   - Transient error:  increments error count, reports via reporter (does not throw).
 *
 * Catches: manual Stripe Dashboard edits, missed webhooks, race conditions.
 * Terminal status ('cancelled') is skipped — it is a final state that does not
 * need to be re-checked.
 *
 * Note on spelling: our DB CHECK constraint uses 'cancelled' (British, double-L).
 * Stripe's API returns 'canceled' (American, single-L) and 'incomplete_expired'.
 * toDbStatus() maps Stripe values to our DB-valid values.
 *
 * Uses privilegedSql throughout — no tenant GUC is set in a cron context.
 */

/** Statuses in our DB that indicate the subscription is settled and need no Stripe check. */
const TERMINAL_STATUSES = new Set(['cancelled']);

export type SubscriptionReconcileCronDeps = {
  stripe: Stripe;
  /**
   * Called for every drift event or Stripe API error.
   * Defaults to console.error (Sentry integration lands when @sentry/node
   * is installed — see server.ts TODO comment).
   */
  reporter?: (msg: string, data: Record<string, unknown>) => void;
};

export type SubscriptionReconcileResult = {
  /** Total subscriptions examined (non-terminal). */
  checked: number;
  /** Subscriptions where DB status differed from Stripe (including 404 → cancelled). */
  drifted: number;
  /** Subscriptions where Stripe returned an unexpected error. */
  errors: number;
};

/**
 * Run the subscription state reconciliation check.
 *
 * @param deps  Injected Stripe client + optional reporter for testability.
 */
export async function runSubscriptionReconcileCron(
  deps: SubscriptionReconcileCronDeps,
): Promise<SubscriptionReconcileResult> {
  const { stripe, reporter = defaultReporter } = deps;

  // Fetch all non-terminal subscriptions.
  const rows = await privilegedSql<
    { id: string; tenant_id: string; stripe_subscription_id: string; status: string }[]
  >`
    SELECT id, tenant_id, stripe_subscription_id, status
      FROM subscription
     WHERE status NOT IN ('cancelled')
     ORDER BY created_at
  `;

  let checked = 0;
  let drifted = 0;
  let errors = 0;

  for (const row of rows) {
    checked++;

    let dbStatus: string;

    try {
      const stripeSub = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
      dbStatus = toDbStatus(stripeSub.status);
    } catch (err: unknown) {
      // Stripe 404 → subscription was deleted externally; mark as cancelled.
      if (isStripe404(err)) {
        dbStatus = 'cancelled';
        drifted++;
        await privilegedSql`
          UPDATE subscription
             SET status     = 'cancelled',
                 updated_at = now()
           WHERE id = ${row.id}
        `;
        reporter('subscription drift: Stripe 404 — marked cancelled', {
          db_id: row.id,
          tenant_id: row.tenant_id,
          stripe_subscription_id: row.stripe_subscription_id,
          db_status: row.status,
          stripe_status: 'cancelled (404)',
        });
        continue;
      }

      // Transient / unexpected Stripe error — count and report but do not throw.
      errors++;
      reporter('subscription reconcile error: Stripe API failed', {
        db_id: row.id,
        tenant_id: row.tenant_id,
        stripe_subscription_id: row.stripe_subscription_id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    // Skip if both DB and Stripe agree on a terminal status (already settled).
    if (TERMINAL_STATUSES.has(dbStatus) && TERMINAL_STATUSES.has(row.status)) {
      continue;
    }

    // Detect drift.
    if (dbStatus !== row.status) {
      drifted++;
      await privilegedSql`
        UPDATE subscription
           SET status     = ${dbStatus},
               updated_at = now()
         WHERE id = ${row.id}
      `;
      reporter('subscription drift: DB status mismatch — corrected', {
        db_id: row.id,
        tenant_id: row.tenant_id,
        stripe_subscription_id: row.stripe_subscription_id,
        db_status: row.status,
        stripe_status: dbStatus,
      });
    }
  }

  return { checked, drifted, errors };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map a Stripe subscription status to our DB-valid status values.
 *
 * Stripe uses American spelling ('canceled', single-L) and has statuses
 * ('incomplete_expired') that don't exist in our CHECK constraint.
 * Both map to our terminal value 'cancelled'.
 */
function toDbStatus(stripeStatus: string): string {
  switch (stripeStatus) {
    case 'canceled':
    case 'incomplete_expired':
      return 'cancelled';
    default:
      return stripeStatus;
  }
}

function isStripe404(err: unknown): boolean {
  if (err instanceof Error) {
    const e = err as Error & { statusCode?: number; status?: number };
    return e.statusCode === 404 || e.status === 404;
  }
  return false;
}

function defaultReporter(msg: string, data: Record<string, unknown>): void {
  // Sentry integration lands when @sentry/node is installed — see server.ts.
  // Until then, surface drift via structured console output so log aggregators
  // (Datadog, CloudWatch) can alert on the pattern.
  console.error('[subscription-reconcile]', msg, data);
}
