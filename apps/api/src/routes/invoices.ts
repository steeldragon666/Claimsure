/**
 * Invoice history route (P9.2.6).
 *
 * GET /v1/invoices — proxies to Stripe invoices API for the tenant's customer.
 *
 * Each invoice includes:
 *   - subtotal_excl_tax: amount before 10% AU GST
 *   - tax_amount: GST (10%) — derived as total - total_excluding_tax
 *   - total: grand total including GST
 *   - invoice_pdf: Stripe-hosted PDF download URL
 *
 * Returns empty list (not 404) when the tenant has no Stripe customer yet.
 */

import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';
import { requireSession } from '@cpa/auth';
import { privilegedSql } from '@cpa/db/client';

export interface InvoicesRouteDeps {
  stripe: Stripe;
}

export interface InvoiceSummary {
  id: string;
  created: number;
  status: string;
  currency: string;
  /** Invoice subtotal before 10% AU GST, in cents. */
  subtotal_excl_tax: number;
  /** GST amount (10%), in cents. Derived as total - subtotal_excl_tax. */
  tax_amount: number;
  /** Grand total including GST, in cents. */
  total: number;
  /** Stripe-hosted PDF download URL, null for draft invoices. */
  invoice_pdf: string | null;
}

export function registerInvoices(app: FastifyInstance, deps: InvoicesRouteDeps): void {
  const { stripe } = deps;

  app.get('/v1/invoices', { preHandler: requireSession }, async (req, reply) => {
    const tenantId = req.user!.tenantId;

    const rows = await privilegedSql<{ stripe_customer_id: string | null }[]>`
      SELECT stripe_customer_id
        FROM tenant
       WHERE id = ${tenantId}
       LIMIT 1
    `;

    const stripeCustomerId = rows[0]?.stripe_customer_id ?? null;

    // Tenant hasn't converted yet — return empty list rather than 404.
    if (!stripeCustomerId) {
      return reply.code(200).send({ invoices: [] });
    }

    const stripeList = await stripe.invoices.list({
      customer: stripeCustomerId,
      limit: 100,
    });

    const invoices: InvoiceSummary[] = stripeList.data.map((inv) => {
      // `total_excluding_tax` is null for invoices created before Stripe Tax was
      // enabled on the account. In that case we fall back to total (no GST split).
      const subtotalExclTax = inv.total_excluding_tax ?? inv.total ?? 0;
      const total = inv.total ?? 0;
      const taxAmount = total - subtotalExclTax;

      return {
        id: inv.id,
        created: inv.created,
        status: inv.status ?? 'draft',
        currency: inv.currency,
        subtotal_excl_tax: subtotalExclTax,
        tax_amount: taxAmount,
        total,
        invoice_pdf: inv.invoice_pdf ?? null,
      };
    });

    return reply.code(200).send({ invoices });
  });
}
