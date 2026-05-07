import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';
import { privilegedSql } from '@cpa/db/client';
import type { SendEmailInput } from '@cpa/email';
import { paymentFailedEmail, finalWarningEmail, subscriptionCancelledEmail } from '@cpa/email';

export interface EmailSender {
  send: (input: SendEmailInput) => Promise<{ id: string }>;
}

export interface BillingWebhookRouteDeps {
  stripe: Stripe;
  webhookSecret: string;
  /** Optional email sender — if omitted, dunning emails are skipped (useful in tests). */
  emailSender?: EmailSender;
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
  const { stripe, webhookSecret, emailSender } = deps;

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
          await handleInvoicePaymentFailed(obj, emailSender);
          break;
        case 'customer.subscription.deleted':
          await handleSubscriptionDeleted(obj, emailSender);
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
 * Sends a dunning email: first failure → payment-failed, already past_due → final-warning.
 */
async function handleInvoicePaymentFailed(
  invoice: Record<string, unknown>,
  emailSender?: EmailSender,
): Promise<void> {
  const stripeSubId = invoice['subscription'] as string | null;
  if (!stripeSubId) return;

  // Fetch current subscription + tenant details before updating status.
  const rows = await privilegedSql<
    {
      status: string;
      tenant_id: string;
      tenant_name: string;
      admin_email: string;
      admin_name: string;
      stripe_customer_id: string | null;
    }[]
  >`
    SELECT s.status,
           s.tenant_id,
           t.name          AS tenant_name,
           t.stripe_customer_id,
           u.email         AS admin_email,
           u.display_name  AS admin_name
      FROM subscription s
      JOIN tenant t ON t.id = s.tenant_id
      JOIN tenant_user tu ON tu.tenant_id = s.tenant_id AND tu.role = 'admin'
      JOIN "user" u ON u.id = tu.user_id
     WHERE s.stripe_subscription_id = ${stripeSubId}
     ORDER BY tu.created_at ASC
     LIMIT 1
  `;

  const row = rows[0];

  await privilegedSql`
    UPDATE subscription
       SET status     = 'past_due',
           updated_at = now()
     WHERE stripe_subscription_id = ${stripeSubId}
  `;

  // Send dunning email — skip if emailSender not configured or no tenant found.
  if (!emailSender || !row) return;

  // Determine cancellation date: Stripe typically retries for ~1 week after first
  // failure, so use the next_payment_attempt or fall back to +7 days from now.
  const nextAttempt = invoice['next_payment_attempt'] as number | null;
  const cancellationTs = nextAttempt
    ? new Date(nextAttempt * 1000)
    : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const cancellationDate = cancellationTs.toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  // Build a portal URL from the stripe_customer_id if available, otherwise skip link.
  // In practice the billing-portal endpoint is called client-side; we use a static URL here.
  const portalUrl = 'https://app.cpaplatform.com.au/billing';

  const isAlreadyPastDue = row.status === 'past_due';
  const emailContent = isAlreadyPastDue
    ? finalWarningEmail({
        name: row.admin_name,
        firmName: row.tenant_name,
        portalUrl,
        cancellationDate,
      })
    : paymentFailedEmail({
        name: row.admin_name,
        firmName: row.tenant_name,
        portalUrl,
      });

  await emailSender.send({ to: row.admin_email, ...emailContent });
}

/**
 * 1.5.7 customer.subscription.deleted
 *
 * Cancels the subscription when Stripe confirms deletion.
 * Sends a subscription-cancelled confirmation email.
 */
async function handleSubscriptionDeleted(
  subscription: Record<string, unknown>,
  emailSender?: EmailSender,
): Promise<void> {
  const stripeSubId = subscription['id'] as string;

  // Fetch tenant + admin details before cancelling.
  const rows = await privilegedSql<
    { tenant_id: string; tenant_name: string; admin_email: string; admin_name: string }[]
  >`
    SELECT s.tenant_id,
           t.name         AS tenant_name,
           u.email        AS admin_email,
           u.display_name AS admin_name
      FROM subscription s
      JOIN tenant t ON t.id = s.tenant_id
      JOIN tenant_user tu ON tu.tenant_id = s.tenant_id AND tu.role = 'admin'
      JOIN "user" u ON u.id = tu.user_id
     WHERE s.stripe_subscription_id = ${stripeSubId}
     ORDER BY tu.created_at ASC
     LIMIT 1
  `;

  const row = rows[0];

  await privilegedSql`
    UPDATE subscription
       SET status     = 'cancelled',
           updated_at = now()
     WHERE stripe_subscription_id = ${stripeSubId}
  `;

  if (!emailSender || !row) return;

  const emailContent = subscriptionCancelledEmail({
    name: row.admin_name,
    firmName: row.tenant_name,
  });

  await emailSender.send({ to: row.admin_email, ...emailContent });
}
