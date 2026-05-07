import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import type StripeType from 'stripe';
import { signSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../app.js';
import { runFloorTopupCron } from '../jobs/floor-topup-cron.js';

/**
 * Phase 2 billing ops contract test — P9.2.9.
 *
 * Covers the four major Phase 2 billing scenarios end-to-end:
 *   1. Plan change up (→ silver)   — proration_behavior = create_prorations
 *   2. Plan change down (→ bronze) — proration_behavior = none (at period end)
 *   3. Dunning: invoice.payment_failed → subscription past_due
 *   4. Dunning recovery: invoice.paid  → subscription active
 *   5. Floor top-up: tenant below $5k floor → floor_topup_invoice created (idempotent)
 *
 * Test namespace: 000000222xxx (disjoint from all other test files).
 */

// ---------------------------------------------------------------------------
// Fixtures — P9.2.9 namespace (prefix 000000222xxx)
// ---------------------------------------------------------------------------

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

const TENANT = '00000000-0000-4000-8000-000000222001';
const ADMIN_USER = '00000000-0000-4000-8000-000000222010';

const STRIPE_CUSTOMER_ID = 'cus_test_p9_ops_222';
const STRIPE_SUBSCRIPTION_ID = 'sub_test_p9_ops_222';
const STRIPE_SI_SLA = 'si_test_p9_ops_sla_222';

const TEST_WEBHOOK_SECRET = 'whsec_test_billing_ops_contract_p929!';

// ---------------------------------------------------------------------------
// Mock Stripe helpers
// ---------------------------------------------------------------------------

interface SubscriptionUpdateCall {
  subscriptionId: string;
  params: StripeType.SubscriptionUpdateParams;
}

/**
 * Mock for billing-plan route tests — captures subscriptions.update calls.
 * Also satisfies the billing dep needed by buildApp for session/gate middleware.
 */
function makePlanMockStripe(): { mock: StripeType; updateCalls: SubscriptionUpdateCall[] } {
  const updateCalls: SubscriptionUpdateCall[] = [];
  const mock = {
    subscriptions: {
      update: (subscriptionId: string, params: StripeType.SubscriptionUpdateParams) => {
        updateCalls.push({ subscriptionId, params });
        return Promise.resolve({
          id: subscriptionId,
          status: 'active',
          object: 'subscription',
        } as unknown as StripeType.Subscription);
      },
    },
  } as unknown as StripeType;
  return { mock, updateCalls };
}

/**
 * Mock for floor top-up cron — fakes Stripe invoice retrieval and creation.
 * Returns the same upcoming amount for every customer lookup.
 * Generates a unique invoice ID per invoices.create call so concurrent tenants
 * in the shared test DB do not collide on the floor_topup_invoice UNIQUE constraint.
 */
function makeTopupMockStripe(upcomingAmountCents: number): {
  mock: StripeType;
  invoiceItemCalls: StripeType.InvoiceItemCreateParams[];
  invoiceCreateCalls: Array<{ id: string } & StripeType.InvoiceCreateParams>;
} {
  const invoiceItemCalls: StripeType.InvoiceItemCreateParams[] = [];
  const invoiceCreateCalls: Array<{ id: string } & StripeType.InvoiceCreateParams> = [];
  let seq = 0;
  const mock = {
    invoices: {
      retrieveUpcoming: (_params: { customer: string }) =>
        Promise.resolve({
          amount_due: upcomingAmountCents,
          object: 'invoice',
        } as unknown as StripeType.UpcomingInvoice),
      create: (params: StripeType.InvoiceCreateParams) => {
        const id = `in_test_topup_auto_${seq++}`;
        invoiceCreateCalls.push({ id, ...params });
        return Promise.resolve({
          id,
          object: 'invoice',
          status: 'draft',
        } as unknown as StripeType.Invoice);
      },
    },
    invoiceItems: {
      create: (params: StripeType.InvoiceItemCreateParams) => {
        invoiceItemCalls.push(params);
        return Promise.resolve({
          id: `ii_test_topup_auto_${seq++}`,
          object: 'invoiceitem',
        } as unknown as StripeType.InvoiceItem);
      },
    },
  } as unknown as StripeType;
  return { mock, invoiceItemCalls, invoiceCreateCalls };
}

/** Real Stripe instance used only for webhook signature verification. */
function makeStripeForWebhook(): StripeType {
  return new Stripe('sk_test_placeholder', { apiVersion: '2025-04-30.basil' });
}

/** Build a signed Stripe webhook payload + Stripe-Signature header. */
function buildWebhookPayload(
  eventType: string,
  data: Record<string, unknown>,
): { payload: Buffer; signature: string } {
  const event = {
    id: `evt_ops_${eventType.replace(/\./g, '_')}_${Date.now()}`,
    object: 'event',
    type: eventType,
    data: { object: data },
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: null,
  };
  const payload = Buffer.from(JSON.stringify(event));
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload: payload.toString(),
    secret: TEST_WEBHOOK_SECRET,
    timestamp,
  });
  return { payload, signature };
}

const adminSession = (): Promise<string> =>
  signSession(
    {
      sub: ADMIN_USER,
      email: 'ops-contract@example.com',
      primaryIdp: 'microsoft',
      activeTenantId: TENANT,
      activeRole: 'admin',
      availableTenants: [],
    },
    SESSION_SECRET,
    { ttlSeconds: 3600 },
  );

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let dbAvailable = false;

const cleanup = async (): Promise<void> => {
  await privilegedSql`DELETE FROM floor_topup_invoice WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM processed_webhook_events WHERE stripe_event_id LIKE 'evt_ops_%'`;
  await privilegedSql`DELETE FROM subscription_item WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM subscription WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM "user" WHERE id = ${ADMIN_USER}`;
  await sql`DELETE FROM tenant WHERE id = ${TENANT}`;
};

before(async () => {
  try {
    await privilegedSql`SELECT 1`;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    return;
  }

  await cleanup();

  // Tenant already in paid state (as if checkout.session.completed already fired).
  await sql`
    INSERT INTO tenant (id, name, slug, primary_idp, billing_mode, trial_status, stripe_customer_id)
    VALUES (${TENANT}, 'Ops Contract Firm', 'ops-contract-p929', 'mixed', 'paid', 'converted', ${STRIPE_CUSTOMER_ID})
  `;
  await sql`
    INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
    VALUES (${ADMIN_USER}, 'ops-contract@example.com', 'microsoft', 'microsoft:ops-contract', 'Ops Contract Admin')
  `;
  await privilegedSql`
    INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
    VALUES (gen_random_uuid(), ${TENANT}, ${ADMIN_USER}, 'admin', true)
  `;

  // Active subscription with an SLA subscription item — required by billing-plan route.
  await privilegedSql`
    INSERT INTO subscription (id, tenant_id, stripe_subscription_id, status)
    VALUES (gen_random_uuid(), ${TENANT}, ${STRIPE_SUBSCRIPTION_ID}, 'active')
  `;
  const subRows = await privilegedSql<{ id: string }[]>`
    SELECT id FROM subscription WHERE stripe_subscription_id = ${STRIPE_SUBSCRIPTION_ID}
  `;
  await privilegedSql`
    INSERT INTO subscription_item (id, tenant_id, subscription_id, stripe_subscription_item_id, price_kind)
    VALUES (gen_random_uuid(), ${TENANT}, ${subRows[0]!.id}, ${STRIPE_SI_SLA}, 'sla')
  `;
});

after(async () => {
  if (!dbAvailable) return;
  await cleanup();
  await sql.end();
  await privilegedSql.end();
});

// ---------------------------------------------------------------------------
// Step 1 — Plan upgrade (silver): immediate proration
// ---------------------------------------------------------------------------

test('step 1 — POST /v1/billing/change-plan: upgrade to silver — create_prorations', async () => {
  if (!dbAvailable) return;

  const { mock, updateCalls } = makePlanMockStripe();
  const app = buildApp({ billing: { stripe: mock } });

  const token = await adminSession();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/billing/change-plan',
    headers: { cookie: `cpa_session=${token}` },
    payload: { sla_tier: 'silver' },
  });

  assert.equal(res.statusCode, 200, `upgrade to silver failed: ${res.body}`);
  assert.equal(updateCalls.length, 1, 'subscriptions.update must be called once');
  assert.equal(updateCalls[0]?.subscriptionId, STRIPE_SUBSCRIPTION_ID);
  assert.equal(
    updateCalls[0]?.params.proration_behavior,
    'create_prorations',
    'upgrade must use create_prorations (immediate)',
  );

  await app.close();
});

// ---------------------------------------------------------------------------
// Step 2 — Plan downgrade (bronze): at period end
// ---------------------------------------------------------------------------

test('step 2 — POST /v1/billing/change-plan: downgrade to bronze — none (at period end)', async () => {
  if (!dbAvailable) return;

  const { mock, updateCalls } = makePlanMockStripe();
  const app = buildApp({ billing: { stripe: mock } });

  const token = await adminSession();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/billing/change-plan',
    headers: { cookie: `cpa_session=${token}` },
    payload: { sla_tier: 'bronze' },
  });

  assert.equal(res.statusCode, 200, `downgrade to bronze failed: ${res.body}`);
  assert.equal(updateCalls.length, 1, 'subscriptions.update must be called once');
  assert.equal(
    updateCalls[0]?.params.proration_behavior,
    'none',
    'downgrade must use none (effective at period end)',
  );

  await app.close();
});

// ---------------------------------------------------------------------------
// Step 3 — Dunning: invoice.payment_failed → past_due
// ---------------------------------------------------------------------------

test('step 3 — invoice.payment_failed webhook: subscription → past_due (dunning begins)', async () => {
  if (!dbAvailable) return;

  // Ensure subscription is active before triggering the failure.
  await privilegedSql`
    UPDATE subscription SET status = 'active' WHERE stripe_subscription_id = ${STRIPE_SUBSCRIPTION_ID}
  `;

  const { mock } = makePlanMockStripe();
  const app = buildApp({
    billing: { stripe: mock },
    billingWebhook: { stripe: makeStripeForWebhook(), webhookSecret: TEST_WEBHOOK_SECRET },
  });

  const { payload, signature } = buildWebhookPayload('invoice.payment_failed', {
    id: 'in_test_p929_failed',
    customer: STRIPE_CUSTOMER_ID,
    subscription: STRIPE_SUBSCRIPTION_ID,
    status: 'open',
  });

  const res = await app.inject({
    method: 'POST',
    url: '/v1/billing/webhook',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    payload,
  });
  assert.equal(res.statusCode, 200, `invoice.payment_failed webhook failed: ${res.body}`);

  const rows = await privilegedSql<{ status: string }[]>`
    SELECT status FROM subscription WHERE stripe_subscription_id = ${STRIPE_SUBSCRIPTION_ID}
  `;
  assert.equal(rows[0]?.status, 'past_due', 'subscription must be past_due after payment failure');

  await app.close();
});

// ---------------------------------------------------------------------------
// Step 4 — Dunning recovery: invoice.paid → active
// ---------------------------------------------------------------------------

test('step 4 — invoice.paid webhook: subscription → active (dunning recovery)', async () => {
  if (!dbAvailable) return;

  const { mock } = makePlanMockStripe();
  const app = buildApp({
    billing: { stripe: mock },
    billingWebhook: { stripe: makeStripeForWebhook(), webhookSecret: TEST_WEBHOOK_SECRET },
  });

  const { payload, signature } = buildWebhookPayload('invoice.paid', {
    id: 'in_test_p929_recovered',
    customer: STRIPE_CUSTOMER_ID,
    subscription: STRIPE_SUBSCRIPTION_ID,
    status: 'paid',
  });

  const res = await app.inject({
    method: 'POST',
    url: '/v1/billing/webhook',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    payload,
  });
  assert.equal(res.statusCode, 200, `invoice.paid recovery webhook failed: ${res.body}`);

  const rows = await privilegedSql<{ status: string }[]>`
    SELECT status FROM subscription WHERE stripe_subscription_id = ${STRIPE_SUBSCRIPTION_ID}
  `;
  assert.equal(
    rows[0]?.status,
    'active',
    'subscription must be active again after dunning recovery',
  );

  await app.close();
});

// ---------------------------------------------------------------------------
// Step 5 — Floor top-up: tenant below $5k floor → floor_topup_invoice created
// ---------------------------------------------------------------------------

test('step 5 — runFloorTopupCron: below-floor tenant → floor_topup_invoice created, idempotent', async () => {
  if (!dbAvailable) return;

  // Tenant upcoming invoice = AUD $1,000 (100,000 cents) — below the $5k standard floor.
  // Expected top-up = $5,000 − $1,000 = $4,000 (400,000 cents).
  const { mock, invoiceItemCalls, invoiceCreateCalls } = makeTopupMockStripe(100_000);

  const result = await runFloorTopupCron(mock, '2026-05');

  assert.ok(result.billed >= 1, 'at least our tenant should be billed');

  // Stripe invoice item created for the top-up difference.
  const ourItemCall = invoiceItemCalls.find((c) => c.customer === STRIPE_CUSTOMER_ID);
  assert.ok(ourItemCall, 'invoiceItems.create must be called for our customer');
  assert.equal(ourItemCall?.amount, 400_000, 'top-up amount must be 400,000 cents ($4,000)');
  assert.equal(ourItemCall?.currency, 'aud');

  // Stripe invoice created.
  const ourInvoiceCall = invoiceCreateCalls.find((c) => c.customer === STRIPE_CUSTOMER_ID);
  assert.ok(ourInvoiceCall, 'invoices.create must be called for our customer');
  const expectedInvoiceId = ourInvoiceCall.id;

  // floor_topup_invoice row must be persisted in our DB.
  const rows = await privilegedSql<
    {
      stripe_invoice_id: string;
      billing_month: string;
      topup_amount_aud_cents: number;
      status: string;
    }[]
  >`
    SELECT stripe_invoice_id, billing_month, topup_amount_aud_cents, status
      FROM floor_topup_invoice
     WHERE tenant_id    = ${TENANT}
       AND billing_month = '2026-05'
  `;
  assert.equal(rows.length, 1, 'exactly one floor_topup_invoice row must be created');
  assert.equal(rows[0]?.stripe_invoice_id, expectedInvoiceId);
  assert.equal(rows[0]?.topup_amount_aud_cents, 400_000);
  assert.equal(rows[0]?.status, 'pending');

  // Idempotency: second run for the same month must skip this tenant.
  const callCountBefore = invoiceItemCalls.length;
  const result2 = await runFloorTopupCron(mock, '2026-05');
  assert.ok(result2.billed < result.billed, 'second run must not re-bill our tenant');
  assert.equal(
    invoiceItemCalls.length,
    callCountBefore,
    'invoiceItems.create must not be called again on idempotent run',
  );
});
