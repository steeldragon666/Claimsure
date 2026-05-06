import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';
import { privilegedSql } from '@cpa/db/client';

export interface BillingWebhookRouteDeps {
  stripe: Stripe;
  webhookSecret: string;
}

/**
 * Stripe Billing webhook plugin (P9.1.5).
 *
 * Registered as a separate encapsulated plugin so the application/json
 * content-type parser override is scoped to this route only — Stripe
 * signs the raw bytes, so we MUST preserve the original Buffer.
 *
 * Sub-tasks covered:
 *   1.5.1 Signature verification (400 missing, 401 invalid)
 *   1.5.2 Idempotency via processed_webhook_events PK
 *   1.5.3 checkout.session.completed → trial_status=converted
 *   1.5.4 customer.subscription.created → subscription row
 *   1.5.5 invoice.paid → status=active
 *   1.5.6 invoice.payment_failed → status=past_due
 *   1.5.7 customer.subscription.deleted → status=cancelled
 */
export function registerBillingWebhookPlugin(
  app: FastifyInstance,
  deps: BillingWebhookRouteDeps,
): void {
  const { stripe, webhookSecret } = deps;

  app.register((instance, _opts, done) => {
    // Override the JSON parser for this encapsulated scope to preserve the
    // raw Buffer that Stripe signed. Every other route retains normal JSON.
    instance.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_req, body, doneCb) => {
        doneCb(null, body);
      },
    );

    instance.post('/v1/billing/webhook', async (req, reply) => {
      // ---------------------------------------------------------------
      // 1.5.1 — Signature verification
      // ---------------------------------------------------------------
      const sigHeader = req.headers['stripe-signature'];
      const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
      if (!sig) {
        return reply.status(400).send({
          error: 'missing_signature',
          message: 'stripe-signature header required',
          requestId: req.id,
        });
      }

      const rawBody = req.body;
      if (!Buffer.isBuffer(rawBody)) {
        return reply.status(400).send({
          error: 'invalid_body',
          message: 'Webhook body missing',
          requestId: req.id,
        });
      }

      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
      } catch {
        return reply.status(401).send({
          error: 'invalid_signature',
          message: 'Stripe webhook signature verification failed',
          requestId: req.id,
        });
      }

      // ---------------------------------------------------------------
      // 1.5.2 — Idempotency via processed_webhook_events
      // ---------------------------------------------------------------
      const inserted = await privilegedSql<{ stripe_event_id: string }[]>`
        INSERT INTO processed_webhook_events (stripe_event_id, event_type, tenant_id)
        VALUES (${event.id}, ${event.type}, NULL)
        ON CONFLICT (stripe_event_id) DO NOTHING
        RETURNING stripe_event_id
      `;
      if (inserted.length === 0) {
        // Already processed — idempotent 200
        return reply.status(200).send({ ok: true });
      }

      // ---------------------------------------------------------------
      // Route to event-specific handler
      // ---------------------------------------------------------------
      const obj = event.data.object as Record<string, unknown>;

      switch (event.type) {
        case 'checkout.session.completed':
          await handleCheckoutSessionCompleted(obj);
          break;
        case 'customer.subscription.created':
          await handleSubscriptionCreated(obj);
          break;
        case 'invoice.paid':
          await handleInvoicePaid(obj);
          break;
        case 'invoice.payment_failed':
          await handleInvoicePaymentFailed(obj);
          break;
        case 'customer.subscription.deleted':
          await handleSubscriptionDeleted(obj);
          break;
        default:
          // Unknown event type — acknowledge silently so Stripe doesn't retry
          req.log.info({ eventType: event.type }, 'unhandled Stripe event type');
      }

      return reply.status(200).send({ ok: true });
    });

    done();
  });
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

/**
 * 1.5.3 checkout.session.completed
 *
 * Marks the tenant as converted: sets trial_status=converted,
 * billing_mode=paid, and stores the Stripe customer_id for future
 * subscription lookups.
 */
async function handleCheckoutSessionCompleted(session: Record<string, unknown>): Promise<void> {
  const tenantId = (session['metadata'] as Record<string, string> | null)?.['tenant_id'];
  const stripeCustomerId = session['customer'] as string | null;

  if (!tenantId || !stripeCustomerId) {
    return;
  }

  await privilegedSql`
    UPDATE tenant
       SET trial_status      = 'converted',
           stripe_customer_id = ${stripeCustomerId},
           billing_mode       = 'paid'
     WHERE id = ${tenantId}
  `;
}

/**
 * 1.5.4 customer.subscription.created
 *
 * Inserts a subscription row.  Resolves tenant_id by looking up the
 * tenant whose stripe_customer_id matches.
 */
async function handleSubscriptionCreated(subscription: Record<string, unknown>): Promise<void> {
  const stripeSubId = subscription['id'] as string;
  const stripeCustomerId = subscription['customer'] as string;
  const status = subscription['status'] as string;
  const periodStart = subscription['current_period_start'] as number | null;
  const periodEnd = subscription['current_period_end'] as number | null;

  const tenantRows = await privilegedSql<{ id: string }[]>`
    SELECT id FROM tenant WHERE stripe_customer_id = ${stripeCustomerId}
  `;
  const tenantId = tenantRows[0]?.id;
  if (!tenantId) {
    return;
  }

  const periodStartTs = periodStart ? new Date(periodStart * 1000).toISOString() : null;
  const periodEndTs = periodEnd ? new Date(periodEnd * 1000).toISOString() : null;

  await privilegedSql`
    INSERT INTO subscription (id, tenant_id, stripe_subscription_id, status, current_period_start, current_period_end)
    VALUES (gen_random_uuid(), ${tenantId}, ${stripeSubId}, ${status}, ${periodStartTs}, ${periodEndTs})
    ON CONFLICT (stripe_subscription_id) DO UPDATE
      SET status               = EXCLUDED.status,
          current_period_start = EXCLUDED.current_period_start,
          current_period_end   = EXCLUDED.current_period_end,
          updated_at           = now()
  `;
}

/**
 * 1.5.5 invoice.paid
 *
 * Clears past_due back to active when the customer pays.
 */
async function handleInvoicePaid(invoice: Record<string, unknown>): Promise<void> {
  const stripeSubId = invoice['subscription'] as string | null;
  if (!stripeSubId) return;

  await privilegedSql`
    UPDATE subscription
       SET status     = 'active',
           updated_at = now()
     WHERE stripe_subscription_id = ${stripeSubId}
  `;
}

/**
 * 1.5.6 invoice.payment_failed
 *
 * Marks the subscription as past_due — tenant gate middleware checks this.
 */
async function handleInvoicePaymentFailed(invoice: Record<string, unknown>): Promise<void> {
  const stripeSubId = invoice['subscription'] as string | null;
  if (!stripeSubId) return;

  await privilegedSql`
    UPDATE subscription
       SET status     = 'past_due',
           updated_at = now()
     WHERE stripe_subscription_id = ${stripeSubId}
  `;
}

/**
 * 1.5.7 customer.subscription.deleted
 *
 * Cancels the subscription when Stripe confirms deletion.
 */
async function handleSubscriptionDeleted(subscription: Record<string, unknown>): Promise<void> {
  const stripeSubId = subscription['id'] as string;

  await privilegedSql`
    UPDATE subscription
       SET status     = 'cancelled',
           updated_at = now()
     WHERE stripe_subscription_id = ${stripeSubId}
  `;
}
