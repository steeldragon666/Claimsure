import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';
import { z } from 'zod';
import { requireSession } from '@cpa/auth';
import { privilegedSql } from '@cpa/db/client';

/**
 * POST /v1/billing/portal-session — P9.2.3
 *
 * Creates a Stripe Customer Portal session for the tenant and returns the
 * redirect URL. The client navigates the user directly to Stripe-hosted portal.
 *
 * Portal is configured in Stripe Dashboard to allow:
 *   - Payment method management
 *   - Invoice history / PDF download
 *
 * NOT exposed via portal (handled in-app):
 *   - SLA plan tier changes (POST /v1/billing/change-plan)
 *   - Claimant management
 */
export interface BillingPortalRouteDeps {
  stripe: Stripe;
}

export function registerBillingPortal(app: FastifyInstance, deps: BillingPortalRouteDeps): void {
  const { stripe } = deps;

  app.post(
    '/v1/billing/portal-session',
    {
      preHandler: requireSession,
      schema: {
        body: z.object({
          /** URL Stripe returns the user to after they leave the portal. */
          return_url: z.string().url(),
        }),
      },
    },
    async (req, reply) => {
      const { return_url } = req.body as { return_url: string };
      const tenantId = req.user!.tenantId;

      // Resolve the tenant's Stripe customer ID.
      const rows = await privilegedSql<{ stripe_customer_id: string | null }[]>`
        SELECT stripe_customer_id
          FROM tenant
         WHERE id = ${tenantId}
         LIMIT 1
      `;

      const stripeCustomerId = rows[0]?.stripe_customer_id ?? null;

      if (!stripeCustomerId) {
        const err = new Error('Tenant has no Stripe customer record.');
        (err as Error & { statusCode: number }).statusCode = 404;
        throw err;
      }

      const session = await stripe.billingPortal.sessions.create({
        customer: stripeCustomerId,
        return_url,
      });

      return reply.code(200).send({ url: session.url });
    },
  );
}
