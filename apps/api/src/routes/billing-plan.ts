import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';
import { z } from 'zod';
import { requireSession } from '@cpa/auth';
import { privilegedSql } from '@cpa/db/client';
import { SlaTierEnum, SLA_TIER_RANK, SLA_TIER_PRICE_ENV, type SlaTier } from '@cpa/schemas';

export interface BillingPlanRouteDeps {
  stripe: Stripe;
}

/**
 * Maximum number of active mobile seats per SLA tier (P9.2.7).
 *
 * bronze → solo/2-person firm → 2 seats max
 * silver → 3-10-person firm  → 10 seats max
 * gold   → 11+ person firm   → unlimited
 *
 * Used to refuse downgrades that would leave the tenant over-quota.
 */
const SLA_TIER_SEAT_LIMIT: Record<SlaTier, number> = {
  bronze: 2,
  silver: 10,
  gold: Number.POSITIVE_INFINITY,
};

/**
 * POST /v1/billing/change-plan — P9.2.1 + P9.2.7
 *
 * Upgrades or downgrades the tenant's SLA retainer tier.
 *
 * P9.2.1 — Proration behaviour:
 *   Upgrade (silver/gold): proration_behavior = 'create_prorations' — immediate.
 *   Downgrade (bronze):    proration_behavior = 'none' — effective at period end.
 *
 * P9.2.7 — Edge cases:
 *   Downgrade refusal: 422 if active mobile seats exceed the new tier's limit.
 *   Multi-component:   optional mobile_quantity updates the mobile item in the
 *                      same Stripe call as the SLA item change.
 *
 * Stripe price IDs per tier are read from env vars at request time:
 *   STRIPE_PRICE_ID_SLA_BRONZE / STRIPE_PRICE_ID_SLA_SILVER / STRIPE_PRICE_ID_SLA_GOLD
 */
export function registerBillingPlan(app: FastifyInstance, deps: BillingPlanRouteDeps): void {
  const { stripe } = deps;

  app.post(
    '/v1/billing/change-plan',
    {
      preHandler: requireSession,
      schema: {
        body: z.object({
          sla_tier: SlaTierEnum,
          /** Optional: also update mobile subscription quantity in the same Stripe call (P9.2.7). */
          mobile_quantity: z.number().int().min(0).optional(),
        }),
      },
    },
    async (req, reply) => {
      const { sla_tier, mobile_quantity } = req.body as {
        sla_tier: SlaTier;
        mobile_quantity?: number;
      };
      const tenantId = req.user!.tenantId;

      // Look up the tenant's active subscription
      const subRows = await privilegedSql<{ id: string; stripe_subscription_id: string }[]>`
        SELECT id, stripe_subscription_id
          FROM subscription
         WHERE tenant_id = ${tenantId}
           AND status IN ('active', 'trialing', 'past_due')
         ORDER BY created_at DESC
         LIMIT 1
      `;

      if (!subRows[0]) {
        const err = new Error('No active subscription found for this tenant.');
        (err as Error & { statusCode: number }).statusCode = 404;
        throw err;
      }

      const { id: dbSubId, stripe_subscription_id: stripeSubId } = subRows[0];

      // Look up the SLA subscription item
      const itemRows = await privilegedSql<{ stripe_subscription_item_id: string }[]>`
        SELECT stripe_subscription_item_id
          FROM subscription_item
         WHERE subscription_id = ${dbSubId}
           AND price_kind = 'sla'
         LIMIT 1
      `;

      if (!itemRows[0]) {
        const err = new Error('No SLA subscription item found.');
        (err as Error & { statusCode: number }).statusCode = 404;
        throw err;
      }

      const { stripe_subscription_item_id: stripeSiId } = itemRows[0];

      // --- Seat-limit check (P9.2.7) ---
      // Refuse if the requested tier cannot accommodate the tenant's current mobile seat count.
      const seatLimit = SLA_TIER_SEAT_LIMIT[sla_tier];
      if (Number.isFinite(seatLimit)) {
        const seatRows = await privilegedSql<{ count: number }[]>`
          SELECT COUNT(*)::int AS count
            FROM claimant_mobile_subscription
           WHERE tenant_id = ${tenantId}
             AND ended_at IS NULL
        `;
        const activeSeats = seatRows[0]?.count ?? 0;
        if (activeSeats > seatLimit) {
          const noun = activeSeats === 1 ? 'seat' : 'seats';
          const err = new Error(
            `Cannot change to ${sla_tier}: ${activeSeats} active mobile ${noun} exceed the ` +
              `${sla_tier} tier limit of ${seatLimit}. ` +
              `Remove mobile subscriptions before downgrading.`,
          );
          (err as Error & { statusCode: number }).statusCode = 422;
          throw err;
        }
      }

      // Determine proration behaviour:
      //   bronze (lowest rank) → downgrade → at period end (none)
      //   silver / gold        → upgrade   → immediate (create_prorations)
      const isDowngrade = SLA_TIER_RANK[sla_tier] === SLA_TIER_RANK.bronze;
      const prorationBehavior: Stripe.SubscriptionUpdateParams.ProrationBehavior = isDowngrade
        ? 'none'
        : 'create_prorations';

      const newPriceId = process.env[SLA_TIER_PRICE_ENV[sla_tier]];

      // Build the Stripe items array.
      // Multi-component (P9.2.7): if mobile_quantity is provided, include the mobile
      // subscription item so both SLA tier + seat count change in a single API call.
      const stripeItems: Stripe.SubscriptionUpdateParams.Item[] = [
        {
          id: stripeSiId,
          ...(newPriceId ? { price: newPriceId } : {}),
        },
      ];

      if (mobile_quantity !== undefined) {
        const mobileItemRows = await privilegedSql<{ stripe_subscription_item_id: string }[]>`
          SELECT stripe_subscription_item_id
            FROM subscription_item
           WHERE subscription_id = ${dbSubId}
             AND price_kind = 'mobile'
           LIMIT 1
        `;
        if (mobileItemRows[0]) {
          stripeItems.push({
            id: mobileItemRows[0].stripe_subscription_item_id,
            quantity: mobile_quantity,
          });
        }
      }

      await stripe.subscriptions.update(stripeSubId, {
        items: stripeItems,
        proration_behavior: prorationBehavior,
      });

      return reply.code(200).send({ ok: true, sla_tier });
    },
  );
}
