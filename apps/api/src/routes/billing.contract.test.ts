import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import type StripeType from 'stripe';
import { signSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../app.js';

/**
 * Phase 1 billing contract test — P9.1.11.
 *
 * Simulates the full Flow A end-to-end:
 *   1. checkout.session.completed  → trial converted, billing_mode=paid
 *   2. customer.subscription.created → subscription row created
 *   3. invoice.paid               → subscription status=active (gate passes)
 *   4. POST /v1/claims            → claim created under billing gate
 *   5. PATCH /v1/claims/:id/deliver → usage record posted to Stripe
 *   6. invoice.payment_failed     → subscription status=past_due (dunning begins)
 *   7. invoice.paid               → subscription status=active (dunning recovery)
 *
 * Tests run sequentially and share DB state. Shared state is captured via
 * module-level `let claimId: string` set in step 4 and read in step 5.
 *
 * Test namespace: 000000111xxx (disjoint from all other test files).
 */

// ---------------------------------------------------------------------------
// Fixtures — P9.1.11 namespace (prefix 000000111xxx)
// ---------------------------------------------------------------------------

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

const TENANT = '00000000-0000-4000-8000-000000111001';
const ADMIN_USER = '00000000-0000-4000-8000-000000111010';
const SUBJECT = '00000000-0000-4000-8000-000000111020';

const STRIPE_CUSTOMER_ID = 'cus_test_p9_contract_111';
const STRIPE_SUBSCRIPTION_ID = 'sub_test_p9_contract_111';
const STRIPE_CHECKOUT_SESSION_ID = 'cs_test_p9_contract_111';
// per_claim subscription_item seeded manually in step 5 (not created by any webhook handler)
const STRIPE_SI_PC = 'si_test_p9_contract_pc_111';

const TEST_WEBHOOK_SECRET = 'whsec_test_billing_contract_p9_1_11!';

// Shared state across sequential tests — populated in step 4, consumed in step 5.
let claimId: string;

// ---------------------------------------------------------------------------
// Stripe mock helpers
// ---------------------------------------------------------------------------

interface UsageRecordCall {
  subscriptionItemId: string;
  params: StripeType.SubscriptionItemCreateUsageRecordParams;
}

/**
 * Minimal mock Stripe client that captures createUsageRecord calls.
 * Only subscriptionItems.createUsageRecord is needed — all other Stripe
 * methods (checkout, webhook verification, etc.) are provided by separate
 * instances.
 */
function makeMockStripe(): { stripe: StripeType; usageCalls: UsageRecordCall[] } {
  const usageCalls: UsageRecordCall[] = [];
  const stripe = {
    subscriptionItems: {
      createUsageRecord: (
        subscriptionItemId: string,
        params: StripeType.SubscriptionItemCreateUsageRecordParams,
      ) => {
        usageCalls.push({ subscriptionItemId, params });
        return Promise.resolve({
          id: 'usage_test_p91911',
          object: 'usage_record',
          quantity: params.quantity,
          subscription_item: subscriptionItemId,
          timestamp: Math.floor(Date.now() / 1000),
        });
      },
    },
  } as unknown as StripeType;
  return { stripe, usageCalls };
}

/** Real Stripe instance for signature verification in the webhook plugin. */
function makeStripeForWebhook(): StripeType {
  return new Stripe('sk_test_placeholder', { apiVersion: '2025-04-30.basil' });
}

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

const adminSession = (): Promise<string> =>
  signSession(
    {
      sub: ADMIN_USER,
      email: 'contract-admin@example.com',
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

const cleanup = async (): Promise<void> => {
  await privilegedSql`DELETE FROM processed_webhook_events WHERE stripe_event_id LIKE 'evt_test_%'`;
  await privilegedSql`DELETE FROM subscription_item WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM subscription WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM claim WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM subject_tenant WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM "user" WHERE id = ${ADMIN_USER}`;
  await sql`DELETE FROM tenant WHERE id = ${TENANT}`;
};

before(async () => {
  await cleanup();

  // Tenant starts in trial state — as it would be immediately after /signup.
  await sql`
    INSERT INTO tenant (id, name, slug, primary_idp, billing_mode, trial_status)
    VALUES (${TENANT}, 'Contract Test Firm', 'contract-test-p91911', 'mixed', 'trial', 'active')
  `;
  await sql`
    INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
    VALUES (${ADMIN_USER}, 'contract-admin@example.com', 'microsoft', 'microsoft:contract-admin', 'Contract Admin')
  `;
  await privilegedSql`
    INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
    VALUES (gen_random_uuid(), ${TENANT}, ${ADMIN_USER}, 'admin', true)
  `;
  await privilegedSql`
    INSERT INTO subject_tenant (id, tenant_id, name, kind)
    VALUES (${SUBJECT}, ${TENANT}, 'Acme Claimant', 'claimant')
  `;
});

after(async () => {
  await cleanup();
  await sql.end();
  await privilegedSql.end();
});

// ---------------------------------------------------------------------------
// Flow A — steps 1–7
// ---------------------------------------------------------------------------

test('step 1 — checkout.session.completed: trial → paid, stripe_customer_id stored', async () => {
  const { stripe } = makeMockStripe();
  const app = buildApp({
    billing: { stripe },
    billingWebhook: { stripe: makeStripeForWebhook(), webhookSecret: TEST_WEBHOOK_SECRET },
  });

  const { payload, signature } = buildWebhookPayload('checkout.session.completed', {
    id: STRIPE_CHECKOUT_SESSION_ID,
    customer: STRIPE_CUSTOMER_ID,
    subscription: STRIPE_SUBSCRIPTION_ID,
    metadata: { tenant_id: TENANT },
    mode: 'subscription',
    payment_status: 'paid',
  });

  const res = await app.inject({
    method: 'POST',
    url: '/v1/billing/webhook',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    payload,
  });
  assert.equal(res.statusCode, 200, `webhook step 1 failed: ${res.body}`);

  const rows = await privilegedSql<
    { trial_status: string; stripe_customer_id: string; billing_mode: string }[]
  >`
    SELECT trial_status, stripe_customer_id, billing_mode
      FROM tenant
     WHERE id = ${TENANT}
  `;
  assert.equal(rows[0]?.trial_status, 'converted', 'trial_status should be converted');
  assert.equal(rows[0]?.billing_mode, 'paid', 'billing_mode should be paid');
  assert.equal(
    rows[0]?.stripe_customer_id,
    STRIPE_CUSTOMER_ID,
    'stripe_customer_id should be stored',
  );

  await app.close();
});

test('step 2 — customer.subscription.created: subscription row inserted', async () => {
  const { stripe } = makeMockStripe();
  const app = buildApp({
    billing: { stripe },
    billingWebhook: { stripe: makeStripeForWebhook(), webhookSecret: TEST_WEBHOOK_SECRET },
  });

  const { payload, signature } = buildWebhookPayload('customer.subscription.created', {
    id: STRIPE_SUBSCRIPTION_ID,
    customer: STRIPE_CUSTOMER_ID,
    status: 'trialing',
    current_period_start: Math.floor(Date.now() / 1000),
    current_period_end: Math.floor(Date.now() / 1000) + 2592000,
  });

  const res = await app.inject({
    method: 'POST',
    url: '/v1/billing/webhook',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    payload,
  });
  assert.equal(res.statusCode, 200, `webhook step 2 failed: ${res.body}`);

  const rows = await privilegedSql<{ stripe_subscription_id: string; status: string }[]>`
    SELECT stripe_subscription_id, status
      FROM subscription
     WHERE tenant_id = ${TENANT}
  `;
  assert.ok(rows[0], 'subscription row should exist');
  assert.equal(rows[0]?.stripe_subscription_id, STRIPE_SUBSCRIPTION_ID);

  await app.close();
});

test('step 3 — invoice.paid: subscription status=active (billing gate now passes)', async () => {
  const { stripe } = makeMockStripe();
  const app = buildApp({
    billing: { stripe },
    billingWebhook: { stripe: makeStripeForWebhook(), webhookSecret: TEST_WEBHOOK_SECRET },
  });

  const { payload, signature } = buildWebhookPayload('invoice.paid', {
    id: 'in_test_p91911_paid_1',
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
  assert.equal(res.statusCode, 200, `webhook step 3 failed: ${res.body}`);

  const rows = await privilegedSql<{ status: string }[]>`
    SELECT status FROM subscription
     WHERE stripe_subscription_id = ${STRIPE_SUBSCRIPTION_ID}
  `;
  assert.equal(rows[0]?.status, 'active', 'subscription should be active after invoice.paid');

  await app.close();
});

test('step 4 — POST /v1/claims: claim created (gate: billing_mode=paid, subscription active)', async () => {
  const { stripe } = makeMockStripe();
  const app = buildApp({ billing: { stripe } });

  const token = await adminSession();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/claims',
    headers: {
      'content-type': 'application/json',
      cookie: `cpa_session=${token}`,
    },
    payload: JSON.stringify({ subject_tenant_id: SUBJECT, fiscal_year: 2025 }),
  });
  assert.equal(res.statusCode, 201, `POST /v1/claims failed (${res.statusCode}): ${res.body}`);

  const body = JSON.parse(res.body) as { claim: { id: string } };
  assert.ok(body.claim?.id, 'response should include claim.id');
  claimId = body.claim.id; // captured for step 5

  await app.close();
});

test('step 5 — PATCH deliver: usage record posted to Stripe, platform_fee_charged_at stamped', async () => {
  // Seed the per_claim subscription_item so emitClaimUsageRecord can resolve it.
  // The webhook handlers only create the subscription row — not subscription_items.
  const subRows = await privilegedSql<{ id: string }[]>`
    SELECT id FROM subscription WHERE stripe_subscription_id = ${STRIPE_SUBSCRIPTION_ID}
  `;
  const subscriptionDbId = subRows[0]?.id;
  assert.ok(subscriptionDbId, 'subscription row must exist before seeding subscription_item');

  await privilegedSql`
    INSERT INTO subscription_item (id, tenant_id, subscription_id, stripe_subscription_item_id, price_kind)
    VALUES (gen_random_uuid(), ${TENANT}, ${subscriptionDbId}, ${STRIPE_SI_PC}, 'per_claim')
  `;

  const { stripe, usageCalls } = makeMockStripe();
  const app = buildApp({ billing: { stripe } });

  const token = await adminSession();
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/claims/${claimId}/deliver`,
    headers: {
      'content-type': 'application/json',
      cookie: `cpa_session=${token}`,
    },
    payload: JSON.stringify({ delivery_kind: 'annual_claim' }),
  });
  assert.equal(res.statusCode, 200, `PATCH deliver failed (${res.statusCode}): ${res.body}`);

  // emitClaimUsageRecord is fire-and-forget — allow the async DB write to land.
  await new Promise<void>((r) => setTimeout(r, 100));

  assert.equal(
    usageCalls.length,
    1,
    'Stripe.subscriptionItems.createUsageRecord should be called once',
  );
  assert.equal(usageCalls[0]?.subscriptionItemId, STRIPE_SI_PC);
  assert.equal(usageCalls[0]?.params.quantity, 1);
  assert.equal(usageCalls[0]?.params.action, 'increment');

  // Verify platform_fee_charged_at was stamped after the Stripe call.
  const rows = await privilegedSql<{ platform_fee_charged_at: Date | null }[]>`
    SELECT platform_fee_charged_at FROM claim WHERE id = ${claimId}
  `;
  assert.ok(
    rows[0]?.platform_fee_charged_at,
    'platform_fee_charged_at should be set after deliver',
  );

  await app.close();
});

test('step 6 — invoice.payment_failed: subscription past_due (dunning begins)', async () => {
  const { stripe } = makeMockStripe();
  const app = buildApp({
    billing: { stripe },
    billingWebhook: { stripe: makeStripeForWebhook(), webhookSecret: TEST_WEBHOOK_SECRET },
  });

  const { payload, signature } = buildWebhookPayload('invoice.payment_failed', {
    id: 'in_test_p91911_failed',
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
  assert.equal(res.statusCode, 200, `webhook step 6 failed: ${res.body}`);

  const rows = await privilegedSql<{ status: string }[]>`
    SELECT status FROM subscription
     WHERE stripe_subscription_id = ${STRIPE_SUBSCRIPTION_ID}
  `;
  assert.equal(
    rows[0]?.status,
    'past_due',
    'subscription should be past_due after payment failure',
  );

  await app.close();
});

test('step 7 — invoice.paid: subscription active again (dunning recovery complete)', async () => {
  const { stripe } = makeMockStripe();
  const app = buildApp({
    billing: { stripe },
    billingWebhook: { stripe: makeStripeForWebhook(), webhookSecret: TEST_WEBHOOK_SECRET },
  });

  const { payload, signature } = buildWebhookPayload('invoice.paid', {
    id: 'in_test_p91911_paid_2',
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
  assert.equal(res.statusCode, 200, `webhook step 7 failed: ${res.body}`);

  const rows = await privilegedSql<{ status: string }[]>`
    SELECT status FROM subscription
     WHERE stripe_subscription_id = ${STRIPE_SUBSCRIPTION_ID}
  `;
  assert.equal(
    rows[0]?.status,
    'active',
    'subscription should be active again after dunning recovery',
  );

  await app.close();
});
