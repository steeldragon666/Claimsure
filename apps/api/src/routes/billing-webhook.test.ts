import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../app.js';

// ---------------------------------------------------------------------------
// Fixtures — P9.1.5 namespace (disjoint from other test files)
// ---------------------------------------------------------------------------

// Fixed UUIDs in the p9/billing-webhook namespace (prefix 000000092xxx)
const TENANT_P9W = '00000000-0000-4000-8000-000000092001';
const ADMIN_USER_P9W = '00000000-0000-4000-8000-000000092010';

// Stripe test webhook secret — used only for test payload signing.
const TEST_WEBHOOK_SECRET = 'whsec_test_billing_webhook_p9_1_5_secret!!';

// Stripe price IDs used in subscription items
const STRIPE_CUSTOMER_ID = 'cus_test_p9w_001';
const STRIPE_SUBSCRIPTION_ID = 'sub_test_p9w_001';
const STRIPE_CHECKOUT_SESSION_ID = 'cs_test_p9w_001';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a signed Stripe webhook payload + Stripe-Signature header. */
function buildWebhookPayload(
  eventType: string,
  data: Record<string, unknown>,
): { payload: Buffer; signature: string } {
  const event = {
    id: `evt_test_${eventType.replace(/\./g, '_')}_${Date.now()}`,
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

/** Build a minimal Stripe instance for the webhook deps (used for sig verification only). */
function makeStripeForWebhook(): Stripe {
  return new Stripe('sk_test_placeholder', { apiVersion: '2025-04-30.basil' });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

before(async () => {
  await privilegedSql`DELETE FROM processed_webhook_events WHERE stripe_event_id LIKE 'evt_test_%'`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id = ${TENANT_P9W}`;
  await sql`DELETE FROM "user" WHERE id = ${ADMIN_USER_P9W}`;
  await sql`DELETE FROM tenant WHERE id = ${TENANT_P9W}`;

  await sql`
    INSERT INTO tenant (id, name, slug, primary_idp)
    VALUES (${TENANT_P9W}, 'P9 Webhook Firm', 'p9-webhook-firm', 'mixed')
  `;
  await sql`
    INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
    VALUES (${ADMIN_USER_P9W}, 'p9w-admin@example.com', 'microsoft', 'microsoft:p9w-admin', 'P9W Admin')
  `;
  await privilegedSql`
    INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
    VALUES (gen_random_uuid(), ${TENANT_P9W}, ${ADMIN_USER_P9W}, 'admin', true)
  `;
});

after(async () => {
  await privilegedSql`DELETE FROM processed_webhook_events WHERE stripe_event_id LIKE 'evt_test_%'`;
  await privilegedSql`DELETE FROM subscription WHERE tenant_id = ${TENANT_P9W}`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id = ${TENANT_P9W}`;
  await sql`DELETE FROM "user" WHERE id = ${ADMIN_USER_P9W}`;
  await sql`DELETE FROM tenant WHERE id = ${TENANT_P9W}`;
});

// ---------------------------------------------------------------------------
// Tests — 1.5.1: Signature verification
// ---------------------------------------------------------------------------

test('POST /v1/billing/webhook: 400 with missing signature header', async () => {
  const app = buildApp({
    billingWebhook: {
      stripe: makeStripeForWebhook(),
      webhookSecret: TEST_WEBHOOK_SECRET,
    },
  });

  const res = await app.inject({
    method: 'POST',
    url: '/v1/billing/webhook',
    headers: { 'content-type': 'application/json' },
    payload: '{}',
  });

  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /v1/billing/webhook: 401 with invalid signature', async () => {
  const app = buildApp({
    billingWebhook: {
      stripe: makeStripeForWebhook(),
      webhookSecret: TEST_WEBHOOK_SECRET,
    },
  });

  const res = await app.inject({
    method: 'POST',
    url: '/v1/billing/webhook',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': 't=123,v1=badhash',
    },
    payload: '{"type":"test"}',
  });

  assert.equal(res.statusCode, 401);
  await app.close();
});

// ---------------------------------------------------------------------------
// Tests — 1.5.2: Idempotency
// ---------------------------------------------------------------------------

test('POST /v1/billing/webhook: 200 idempotent — second delivery of same event_id is no-op', async () => {
  const { payload, signature } = buildWebhookPayload('invoice.paid', {
    id: 'in_test_idempotent',
    customer: STRIPE_CUSTOMER_ID,
    subscription: STRIPE_SUBSCRIPTION_ID,
    status: 'paid',
  });

  const app = buildApp({
    billingWebhook: {
      stripe: makeStripeForWebhook(),
      webhookSecret: TEST_WEBHOOK_SECRET,
    },
  });

  // First delivery
  const res1 = await app.inject({
    method: 'POST',
    url: '/v1/billing/webhook',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signature,
    },
    payload,
  });
  assert.equal(res1.statusCode, 200);

  // Second delivery — same event_id, must be idempotent (200, no DB error)
  const res2 = await app.inject({
    method: 'POST',
    url: '/v1/billing/webhook',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signature,
    },
    payload,
  });
  assert.equal(res2.statusCode, 200);

  await app.close();
});

// ---------------------------------------------------------------------------
// Tests — 1.5.3: checkout.session.completed
// ---------------------------------------------------------------------------

test('POST /v1/billing/webhook: checkout.session.completed sets trial_status=converted and stores stripe_customer_id', async () => {
  const { payload, signature } = buildWebhookPayload('checkout.session.completed', {
    id: STRIPE_CHECKOUT_SESSION_ID,
    customer: STRIPE_CUSTOMER_ID,
    subscription: STRIPE_SUBSCRIPTION_ID,
    metadata: { tenant_id: TENANT_P9W },
    mode: 'subscription',
    payment_status: 'paid',
  });

  const app = buildApp({
    billingWebhook: {
      stripe: makeStripeForWebhook(),
      webhookSecret: TEST_WEBHOOK_SECRET,
    },
  });

  const res = await app.inject({
    method: 'POST',
    url: '/v1/billing/webhook',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signature,
    },
    payload,
  });

  assert.equal(res.statusCode, 200);

  // Verify DB state
  const rows = await sql<
    { trial_status: string; stripe_customer_id: string; billing_mode: string }[]
  >`
    SELECT trial_status, stripe_customer_id, billing_mode
      FROM tenant
     WHERE id = ${TENANT_P9W}
  `;
  assert.equal(rows[0]?.trial_status, 'converted');
  assert.equal(rows[0]?.stripe_customer_id, STRIPE_CUSTOMER_ID);
  assert.equal(rows[0]?.billing_mode, 'paid');

  await app.close();
});

// ---------------------------------------------------------------------------
// Tests — 1.5.4: customer.subscription.created
// ---------------------------------------------------------------------------

test('POST /v1/billing/webhook: customer.subscription.created inserts subscription row', async () => {
  // Update tenant to have the stripe_customer_id so the handler can look it up
  await sql`UPDATE tenant SET stripe_customer_id = ${STRIPE_CUSTOMER_ID} WHERE id = ${TENANT_P9W}`;

  const { payload, signature } = buildWebhookPayload('customer.subscription.created', {
    id: STRIPE_SUBSCRIPTION_ID,
    customer: STRIPE_CUSTOMER_ID,
    status: 'active',
    current_period_start: Math.floor(Date.now() / 1000),
    current_period_end: Math.floor(Date.now() / 1000) + 2592000,
  });

  const app = buildApp({
    billingWebhook: {
      stripe: makeStripeForWebhook(),
      webhookSecret: TEST_WEBHOOK_SECRET,
    },
  });

  const res = await app.inject({
    method: 'POST',
    url: '/v1/billing/webhook',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signature,
    },
    payload,
  });

  assert.equal(res.statusCode, 200);

  const rows = await privilegedSql<{ stripe_subscription_id: string; status: string }[]>`
    SELECT stripe_subscription_id, status
      FROM subscription
     WHERE tenant_id = ${TENANT_P9W}
  `;
  assert.ok(rows.length > 0, 'subscription row should be created');
  assert.equal(rows[0]?.stripe_subscription_id, STRIPE_SUBSCRIPTION_ID);
  assert.equal(rows[0]?.status, 'active');

  await app.close();
});

// ---------------------------------------------------------------------------
// Tests — 1.5.5: invoice.paid clears past_due
// ---------------------------------------------------------------------------

test('POST /v1/billing/webhook: invoice.paid sets subscription status to active', async () => {
  // Put the subscription in past_due state first
  await privilegedSql`
    INSERT INTO subscription (id, tenant_id, stripe_subscription_id, status)
    VALUES (gen_random_uuid(), ${TENANT_P9W}, ${STRIPE_SUBSCRIPTION_ID}, 'past_due')
    ON CONFLICT (stripe_subscription_id) DO UPDATE SET status = 'past_due'
  `;

  const { payload, signature } = buildWebhookPayload('invoice.paid', {
    id: 'in_test_paid',
    customer: STRIPE_CUSTOMER_ID,
    subscription: STRIPE_SUBSCRIPTION_ID,
    status: 'paid',
  });

  const app = buildApp({
    billingWebhook: {
      stripe: makeStripeForWebhook(),
      webhookSecret: TEST_WEBHOOK_SECRET,
    },
  });

  const res = await app.inject({
    method: 'POST',
    url: '/v1/billing/webhook',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signature,
    },
    payload,
  });

  assert.equal(res.statusCode, 200);

  const rows = await privilegedSql<{ status: string }[]>`
    SELECT status FROM subscription
     WHERE stripe_subscription_id = ${STRIPE_SUBSCRIPTION_ID}
  `;
  assert.equal(rows[0]?.status, 'active');

  await app.close();
});

// ---------------------------------------------------------------------------
// Tests — 1.5.6: invoice.payment_failed sets past_due
// ---------------------------------------------------------------------------

test('POST /v1/billing/webhook: invoice.payment_failed sets subscription status to past_due', async () => {
  // Ensure subscription is active first
  await privilegedSql`
    INSERT INTO subscription (id, tenant_id, stripe_subscription_id, status)
    VALUES (gen_random_uuid(), ${TENANT_P9W}, ${STRIPE_SUBSCRIPTION_ID}, 'active')
    ON CONFLICT (stripe_subscription_id) DO UPDATE SET status = 'active'
  `;

  const { payload, signature } = buildWebhookPayload('invoice.payment_failed', {
    id: 'in_test_failed',
    customer: STRIPE_CUSTOMER_ID,
    subscription: STRIPE_SUBSCRIPTION_ID,
    status: 'open',
  });

  const app = buildApp({
    billingWebhook: {
      stripe: makeStripeForWebhook(),
      webhookSecret: TEST_WEBHOOK_SECRET,
    },
  });

  const res = await app.inject({
    method: 'POST',
    url: '/v1/billing/webhook',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signature,
    },
    payload,
  });

  assert.equal(res.statusCode, 200);

  const rows = await privilegedSql<{ status: string }[]>`
    SELECT status FROM subscription
     WHERE stripe_subscription_id = ${STRIPE_SUBSCRIPTION_ID}
  `;
  assert.equal(rows[0]?.status, 'past_due');

  await app.close();
});

// ---------------------------------------------------------------------------
// Tests — 1.5.7: customer.subscription.deleted cancels subscription
// ---------------------------------------------------------------------------

test('POST /v1/billing/webhook: customer.subscription.deleted sets status to cancelled', async () => {
  await privilegedSql`
    INSERT INTO subscription (id, tenant_id, stripe_subscription_id, status)
    VALUES (gen_random_uuid(), ${TENANT_P9W}, ${STRIPE_SUBSCRIPTION_ID}, 'active')
    ON CONFLICT (stripe_subscription_id) DO UPDATE SET status = 'active'
  `;

  const { payload, signature } = buildWebhookPayload('customer.subscription.deleted', {
    id: STRIPE_SUBSCRIPTION_ID,
    customer: STRIPE_CUSTOMER_ID,
    status: 'canceled',
  });

  const app = buildApp({
    billingWebhook: {
      stripe: makeStripeForWebhook(),
      webhookSecret: TEST_WEBHOOK_SECRET,
    },
  });

  const res = await app.inject({
    method: 'POST',
    url: '/v1/billing/webhook',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signature,
    },
    payload,
  });

  assert.equal(res.statusCode, 200);

  const rows = await privilegedSql<{ status: string }[]>`
    SELECT status FROM subscription
     WHERE stripe_subscription_id = ${STRIPE_SUBSCRIPTION_ID}
  `;
  assert.equal(rows[0]?.status, 'cancelled');

  await app.close();
});
