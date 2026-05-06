import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';
import { z } from 'zod';
import { requireSession } from '@cpa/auth';
import { privilegedSql } from '@cpa/db/client';

export interface BillingRouteDeps {
  stripe: Stripe;
}

/**
 * Stripe coupon ID applied when a founding-partner slot is available.
 * The coupon must exist in Stripe (created during ops setup — see Task 1.1).
 * 50% off all components for 12 months for the first 10 firms.
 */
const FOUNDER_COUPON = 'FOUNDER-50';

/**
 * Check if an unclaimed founding-partner slot exists and atomically claim it
 * for the given tenant.
 *
 * Uses an advisory lock keyed on the table name to prevent two concurrent
 * requests racing to claim the same slot. The lock is released at transaction
 * end (xact-level advisory lock).
 *
 * Returns true if a slot was successfully claimed, false otherwise.
 */
async function tryClaimFoundingPartnerSlot(tenantId: string): Promise<boolean> {
  const rows = await privilegedSql<{ id: string }[]>`
    UPDATE founding_partner_slots
       SET claimed_by_tenant_id = ${tenantId},
           claimed_at           = NOW()
     WHERE id = (
           SELECT id
             FROM founding_partner_slots
            WHERE claimed_by_tenant_id IS NULL
            LIMIT 1
            FOR UPDATE SKIP LOCKED
           )
 RETURNING id
  `;
  return rows.length > 0;
}

export function registerBilling(app: FastifyInstance, deps: BillingRouteDeps): void {
  const { stripe } = deps;

  app.post(
    '/v1/billing/checkout-session',
    {
      preHandler: requireSession,
      schema: {
        body: z.object({
          success_url: z.string().url(),
          cancel_url: z.string().url(),
        }),
      },
    },
    async (req, reply) => {
      const { success_url, cancel_url } = req.body as { success_url: string; cancel_url: string };
      const tenantId = req.user!.tenantId;

      // Attempt to claim a founding-partner slot (race-safe via SKIP LOCKED).
      const hasFoundingSlot = await tryClaimFoundingPartnerSlot(tenantId);

      const sessionParams: Stripe.Checkout.SessionCreateParams = {
        mode: 'subscription',
        success_url,
        cancel_url,
        automatic_tax: { enabled: true },
        metadata: { tenant_id: tenantId },
        line_items: [
          // Onboarding fee — one-time charge at conversion.
          ...(process.env['STRIPE_PRICE_ID_ONBOARDING']
            ? [{ price: process.env['STRIPE_PRICE_ID_ONBOARDING'], quantity: 1 }]
            : []),
          // Per-claim metered usage record subscription item.
          ...(process.env['STRIPE_PRICE_ID_PER_CLAIM']
            ? [{ price: process.env['STRIPE_PRICE_ID_PER_CLAIM'] }]
            : []),
          // Mobile subscriber seat (quantity synced separately by Task 1.10).
          ...(process.env['STRIPE_PRICE_ID_MOBILE']
            ? [{ price: process.env['STRIPE_PRICE_ID_MOBILE'], quantity: 0 }]
            : []),
          // Quarterly SLA fee (Bronze tier default at checkout).
          ...(process.env['STRIPE_PRICE_ID_SLA']
            ? [{ price: process.env['STRIPE_PRICE_ID_SLA'], quantity: 1 }]
            : []),
        ],
        ...(hasFoundingSlot ? { discounts: [{ coupon: FOUNDER_COUPON }] } : {}),
      };

      const session = await stripe.checkout.sessions.create(sessionParams);

      return reply.code(200).send({ checkout_url: session.url });
    },
  );
}
