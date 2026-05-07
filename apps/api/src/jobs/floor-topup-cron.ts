import type Stripe from 'stripe';
import { privilegedSql } from '@cpa/db/client';

/**
 * Floor top-up cron (P9.2.2).
 *
 * Runs end-of-month. For each active paid tenant:
 *   1. Retrieve Stripe upcoming invoice amount.
 *   2. Compute the applicable floor:
 *        standard       → AUD $5,000 (500_000 cents)
 *        founding_partner → AUD $2,500 (250_000 cents, 50% off)
 *   3. If upcoming < floor, create a Stripe invoice item + invoice for the
 *      difference and record in `floor_topup_invoice`.
 *
 * Idempotent: a (tenant_id, billing_month) pair is only ever billed once.
 * Uses privilegedSql throughout — no tenant GUC is set in a cron context.
 */

/** AUD floor amounts in cents. */
const FLOOR_STANDARD_CENTS = 500_000; // $5,000
const FLOOR_FOUNDING_CENTS = 250_000; // $2,500 (50% off)

export type FloorTopupCronResult = {
  /** Tenants that received a top-up invoice this run. */
  billed: number;
  /** Tenants skipped (above floor, or already billed this month). */
  skipped: number;
};

/**
 * Run the floor top-up cron for the given billing month.
 *
 * @param stripe  Stripe client (injected for testability).
 * @param billingMonth  YYYY-MM string for the month being processed.
 *                      Defaults to the current calendar month.
 */
export async function runFloorTopupCron(
  stripe: Stripe,
  billingMonth?: string,
): Promise<FloorTopupCronResult> {
  const month = billingMonth ?? currentYearMonth();

  // All active paid tenants with a Stripe customer ID.
  const tenants = await privilegedSql<{ id: string; tier: string; stripe_customer_id: string }[]>`
    SELECT id, tier, stripe_customer_id
      FROM tenant
     WHERE billing_mode = 'paid'
       AND stripe_customer_id IS NOT NULL
  `;

  let billed = 0;
  let skipped = 0;

  for (const tenant of tenants) {
    // Idempotency guard — skip if already processed this month.
    const existing = await privilegedSql<{ id: string }[]>`
      SELECT id
        FROM floor_topup_invoice
       WHERE tenant_id    = ${tenant.id}
         AND billing_month = ${month}
       LIMIT 1
    `;
    if (existing.length > 0) {
      skipped++;
      continue;
    }

    // Retrieve projected Stripe invoice amount for this customer.
    let upcomingCents: number;
    try {
      const upcoming = await stripe.invoices.retrieveUpcoming({
        customer: tenant.stripe_customer_id,
      });
      upcomingCents = upcoming.amount_due;
    } catch {
      // No upcoming invoice (e.g. customer has no subscription yet) — skip.
      skipped++;
      continue;
    }

    // Applicable floor for this tenant tier.
    const floorCents =
      tenant.tier === 'founding_partner' ? FLOOR_FOUNDING_CENTS : FLOOR_STANDARD_CENTS;

    if (upcomingCents >= floorCents) {
      skipped++;
      continue;
    }

    const topupCents = floorCents - upcomingCents;

    // Create the top-up invoice item, then finalise via a new invoice.
    await stripe.invoiceItems.create({
      customer: tenant.stripe_customer_id,
      amount: topupCents,
      currency: 'aud',
      description: `Monthly minimum floor top-up (${month})`,
    });

    const stripeInvoice = await stripe.invoices.create({
      customer: tenant.stripe_customer_id,
      auto_advance: true,
    });

    // Record in our DB.
    await privilegedSql`
      INSERT INTO floor_topup_invoice (id, tenant_id, stripe_invoice_id, billing_month, topup_amount_aud_cents, status)
      VALUES (gen_random_uuid(), ${tenant.id}, ${stripeInvoice.id}, ${month}, ${topupCents}, 'pending')
    `;

    billed++;
  }

  return { billed, skipped };
}

/** Returns the current calendar month as a YYYY-MM string. */
function currentYearMonth(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}
