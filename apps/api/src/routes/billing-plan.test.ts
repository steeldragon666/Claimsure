import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { signSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../app.js';
import type Stripe from 'stripe';

// ---------------------------------------------------------------------------
// Fixtures — P9.2.1 / P9.2.7 namespace (prefix 000000092xxx)
// ---------------------------------------------------------------------------

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

const TENANT_P92 = '00000000-0000-4000-8000-000000092001';
const ADMIN_USER_P92 = '00000000-0000-4000-8000-000000092010';

const STRIPE_CUSTOMER_ID = 'cus_test_p92_plan_change';
const STRIPE_SUBSCRIPTION_ID = 'sub_test_p92_plan_change';
const STRIPE_SI_SLA = 'si_test_p92_sla';

// Subject-tenant UUIDs for mobile-seat fixture tests (P9.2.7)
const SUBJ_1 = '00000000-0000-4000-8000-000000092071';
const SUBJ_2 = '00000000-0000-4000-8000-000000092072';
const SUBJ_3 = '00000000-0000-4000-8000-000000092073';

// ---------------------------------------------------------------------------
// Mock Stripe
// ---------------------------------------------------------------------------

interface SubscriptionUpdateCall {
  subscriptionId: string;
  params: Stripe.SubscriptionUpdateParams;
}

function makeMockStripe() {
  const updateCalls: SubscriptionUpdateCall[] = [];
  const mock = {
    subscriptions: {
      update: (
        subscriptionId: string,
        params: Stripe.SubscriptionUpdateParams,
      ): Promise<Stripe.Subscription> => {
        updateCalls.push({ subscriptionId, params });
        return Promise.resolve({
          id: subscriptionId,
          status: 'active',
          object: 'subscription',
        } as unknown as Stripe.Subscription);
      },
    },
  } as unknown as Stripe;
  return { mock, updateCalls };
}

const adminSession = (): Promise<string> =>
  signSession(
    {
      sub: ADMIN_USER_P92,
      email: 'p92-admin@example.com',
      primaryIdp: 'microsoft',
      activeTenantId: TENANT_P92,
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

const setup = async (): Promise<void> => {
  try {
    await privilegedSql`SELECT 1`;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    return;
  }

  // Clean up any leftover fixtures (including P9.2.7 mobile-seat tables)
  await privilegedSql`DELETE FROM floor_topup_invoice WHERE tenant_id = ${TENANT_P92}`;
  await privilegedSql`DELETE FROM claimant_mobile_subscription WHERE tenant_id = ${TENANT_P92}`;
  await privilegedSql`DELETE FROM subject_tenant WHERE tenant_id = ${TENANT_P92}`;
  await privilegedSql`DELETE FROM subscription_item WHERE tenant_id = ${TENANT_P92}`;
  await privilegedSql`DELETE FROM subscription WHERE tenant_id = ${TENANT_P92}`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id = ${TENANT_P92}`;
  await sql`DELETE FROM "user" WHERE id = ${ADMIN_USER_P92}`;
  await sql`DELETE FROM tenant WHERE id = ${TENANT_P92}`;

  // Create test fixtures
  await sql`
    INSERT INTO tenant (id, name, slug, primary_idp, billing_mode, trial_status, stripe_customer_id)
    VALUES (${TENANT_P92}, 'P92 Plan Test Firm', 'p92-plan-firm', 'mixed', 'paid', 'converted', ${STRIPE_CUSTOMER_ID})
  `;
  await sql`
    INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
    VALUES (${ADMIN_USER_P92}, 'p92-admin@example.com', 'microsoft', 'microsoft:p92-admin', 'P92 Admin')
  `;
  await privilegedSql`
    INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
    VALUES (gen_random_uuid(), ${TENANT_P92}, ${ADMIN_USER_P92}, 'admin', true)
  `;
  // Seed a subscription and SLA subscription_item
  await privilegedSql`
    INSERT INTO subscription (id, tenant_id, stripe_subscription_id, status)
    VALUES (gen_random_uuid(), ${TENANT_P92}, ${STRIPE_SUBSCRIPTION_ID}, 'active')
  `;
  const subRows = await privilegedSql<{ id: string }[]>`
    SELECT id FROM subscription WHERE stripe_subscription_id = ${STRIPE_SUBSCRIPTION_ID}
  `;
  await privilegedSql`
    INSERT INTO subscription_item (id, tenant_id, subscription_id, stripe_subscription_item_id, price_kind)
    VALUES (gen_random_uuid(), ${TENANT_P92}, ${subRows[0]!.id}, ${STRIPE_SI_SLA}, 'sla')
  `;
};

const teardown = async (): Promise<void> => {
  if (!dbAvailable) return;
  // Clean mobile-seat tables before subscription rows (FK order)
  await privilegedSql`DELETE FROM floor_topup_invoice WHERE tenant_id = ${TENANT_P92}`;
  await privilegedSql`DELETE FROM claimant_mobile_subscription WHERE tenant_id = ${TENANT_P92}`;
  await privilegedSql`DELETE FROM subject_tenant WHERE tenant_id = ${TENANT_P92}`;
  await privilegedSql`DELETE FROM subscription_item WHERE tenant_id = ${TENANT_P92}`;
  await privilegedSql`DELETE FROM subscription WHERE tenant_id = ${TENANT_P92}`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id = ${TENANT_P92}`;
  await sql`DELETE FROM "user" WHERE id = ${ADMIN_USER_P92}`;
  await sql`DELETE FROM tenant WHERE id = ${TENANT_P92}`;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

before(async () => {
  await setup();
});

test('POST /v1/billing/change-plan: 401 without session', async () => {
  if (!dbAvailable) return;
  const { mock } = makeMockStripe();
  const app = buildApp({ billing: { stripe: mock } });
  const res = await app.inject({
    method: 'POST',
    url: '/v1/billing/change-plan',
    payload: { sla_tier: 'silver' },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /v1/billing/change-plan: upgrade to silver — immediate proration', async () => {
  if (!dbAvailable) return;
  const { mock, updateCalls } = makeMockStripe();
  const app = buildApp({ billing: { stripe: mock } });

  const token = await adminSession();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/billing/change-plan',
    headers: { cookie: `cpa_session=${token}` },
    payload: { sla_tier: 'silver' },
  });

  assert.equal(res.statusCode, 200, `change-plan failed: ${res.body}`);
  assert.equal(updateCalls.length, 1, 'Stripe subscription.update must be called once');
  assert.equal(updateCalls[0]?.subscriptionId, STRIPE_SUBSCRIPTION_ID);

  // Upgrade uses immediate proration
  assert.equal(
    updateCalls[0]?.params.proration_behavior,
    'create_prorations',
    'upgrade must use create_prorations',
  );

  // New price ID must be set on the SLA item
  const items = updateCalls[0]?.params.items ?? [];
  assert.ok(items.length > 0, 'items array must be set');
  const slaItem = items.find((i: { id?: string }) => i.id === STRIPE_SI_SLA);
  assert.ok(slaItem, 'SLA subscription_item must be updated');

  await app.close();
});

test('POST /v1/billing/change-plan: downgrade to bronze — at-period-end', async () => {
  if (!dbAvailable) return;
  // First set to silver
  await privilegedSql`
    UPDATE subscription_item SET price_kind = 'sla' WHERE stripe_subscription_item_id = ${STRIPE_SI_SLA}
  `;

  const { mock, updateCalls } = makeMockStripe();
  const app = buildApp({ billing: { stripe: mock } });

  const token = await adminSession();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/billing/change-plan',
    headers: { cookie: `cpa_session=${token}` },
    payload: { sla_tier: 'bronze' },
  });

  assert.equal(res.statusCode, 200, `change-plan downgrade failed: ${res.body}`);
  assert.equal(updateCalls.length, 1);

  // Downgrade uses at_period_end
  assert.equal(
    updateCalls[0]?.params.proration_behavior,
    'none',
    'downgrade must use none (effective at period end)',
  );

  await app.close();
});

test('POST /v1/billing/change-plan: 400 for invalid tier', async () => {
  if (!dbAvailable) return;
  const { mock } = makeMockStripe();
  const app = buildApp({ billing: { stripe: mock } });

  const token = await adminSession();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/billing/change-plan',
    headers: { cookie: `cpa_session=${token}` },
    payload: { sla_tier: 'platinum' }, // invalid
  });

  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /v1/billing/change-plan: 404 when no SLA subscription item', async () => {
  if (!dbAvailable) return;
  // Temporarily remove the SLA item (subscription stays active so middleware passes)
  await privilegedSql`DELETE FROM subscription_item WHERE stripe_subscription_item_id = ${STRIPE_SI_SLA}`;

  const { mock } = makeMockStripe();
  const app = buildApp({ billing: { stripe: mock } });

  const token = await adminSession();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/billing/change-plan',
    headers: { cookie: `cpa_session=${token}` },
    payload: { sla_tier: 'silver' },
  });

  assert.equal(res.statusCode, 404);

  // Restore
  const subRows = await privilegedSql<{ id: string }[]>`
    SELECT id FROM subscription WHERE stripe_subscription_id = ${STRIPE_SUBSCRIPTION_ID}
  `;
  await privilegedSql`
    INSERT INTO subscription_item (id, tenant_id, subscription_id, stripe_subscription_item_id, price_kind)
    VALUES (gen_random_uuid(), ${TENANT_P92}, ${subRows[0]!.id}, ${STRIPE_SI_SLA}, 'sla')
  `;
  await app.close();
});

// ---------------------------------------------------------------------------
// P9.2.7 — Edge cases: downgrade refusal + multi-component plan change
// ---------------------------------------------------------------------------

test('POST /v1/billing/change-plan: 422 downgrade to bronze when active mobile seats (3) exceed limit (2)', async () => {
  if (!dbAvailable) return;

  // Seed 3 subject-tenants + 3 active mobile subscriptions (ended_at = NULL)
  await privilegedSql`
    INSERT INTO subject_tenant (id, tenant_id, name)
    VALUES
      (${SUBJ_1}, ${TENANT_P92}, 'P927 Subject 1'),
      (${SUBJ_2}, ${TENANT_P92}, 'P927 Subject 2'),
      (${SUBJ_3}, ${TENANT_P92}, 'P927 Subject 3')
  `;
  await privilegedSql`
    INSERT INTO claimant_mobile_subscription (id, tenant_id, subject_tenant_id)
    VALUES
      (gen_random_uuid(), ${TENANT_P92}, ${SUBJ_1}),
      (gen_random_uuid(), ${TENANT_P92}, ${SUBJ_2}),
      (gen_random_uuid(), ${TENANT_P92}, ${SUBJ_3})
  `;

  try {
    const { mock } = makeMockStripe();
    const app = buildApp({ billing: { stripe: mock } });
    const token = await adminSession();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/billing/change-plan',
      headers: { cookie: `cpa_session=${token}` },
      payload: { sla_tier: 'bronze' },
    });

    assert.equal(res.statusCode, 422, `expected 422 but got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body) as { message: string };
    assert.ok(
      body.message.toLowerCase().includes('mobile') || body.message.includes('seat'),
      `422 message must mention mobile seats; got: ${body.message}`,
    );

    await app.close();
  } finally {
    await privilegedSql`DELETE FROM claimant_mobile_subscription WHERE tenant_id = ${TENANT_P92}`;
    await privilegedSql`DELETE FROM subject_tenant WHERE id IN (${SUBJ_1}, ${SUBJ_2}, ${SUBJ_3})`;
  }
});

test('POST /v1/billing/change-plan: 200 downgrade to bronze allowed with exactly 2 active mobile seats (boundary)', async () => {
  if (!dbAvailable) return;

  // Seed exactly 2 mobile subscriptions — boundary case, should succeed
  await privilegedSql`
    INSERT INTO subject_tenant (id, tenant_id, name)
    VALUES
      (${SUBJ_1}, ${TENANT_P92}, 'P927 Subject 1'),
      (${SUBJ_2}, ${TENANT_P92}, 'P927 Subject 2')
  `;
  await privilegedSql`
    INSERT INTO claimant_mobile_subscription (id, tenant_id, subject_tenant_id)
    VALUES
      (gen_random_uuid(), ${TENANT_P92}, ${SUBJ_1}),
      (gen_random_uuid(), ${TENANT_P92}, ${SUBJ_2})
  `;

  try {
    const { mock, updateCalls } = makeMockStripe();
    const app = buildApp({ billing: { stripe: mock } });
    const token = await adminSession();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/billing/change-plan',
      headers: { cookie: `cpa_session=${token}` },
      payload: { sla_tier: 'bronze' },
    });

    assert.equal(res.statusCode, 200, `downgrade with 2 seats should succeed: ${res.body}`);
    assert.equal(updateCalls.length, 1, 'Stripe update must be called');

    await app.close();
  } finally {
    await privilegedSql`DELETE FROM claimant_mobile_subscription WHERE tenant_id = ${TENANT_P92}`;
    await privilegedSql`DELETE FROM subject_tenant WHERE id IN (${SUBJ_1}, ${SUBJ_2})`;
  }
});

test('POST /v1/billing/change-plan: multi-component — upgrade SLA + update mobile quantity in single Stripe call', async () => {
  if (!dbAvailable) return;

  const STRIPE_SI_MOBILE = 'si_test_p92_mobile_mc';
  const subRows = await privilegedSql<{ id: string }[]>`
    SELECT id FROM subscription WHERE stripe_subscription_id = ${STRIPE_SUBSCRIPTION_ID}
  `;
  const dbSubId = subRows[0]!.id;

  // Seed a mobile subscription item so the endpoint can find it
  await privilegedSql`
    INSERT INTO subscription_item (id, tenant_id, subscription_id, stripe_subscription_item_id, price_kind)
    VALUES (gen_random_uuid(), ${TENANT_P92}, ${dbSubId}, ${STRIPE_SI_MOBILE}, 'mobile')
  `;

  try {
    const { mock, updateCalls } = makeMockStripe();
    const app = buildApp({ billing: { stripe: mock } });
    const token = await adminSession();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/billing/change-plan',
      headers: { cookie: `cpa_session=${token}` },
      payload: { sla_tier: 'gold', mobile_quantity: 5 },
    });

    assert.equal(res.statusCode, 200, `multi-component failed: ${res.body}`);
    assert.equal(updateCalls.length, 1, 'must call Stripe update exactly once');

    const items = (updateCalls[0]?.params.items ?? []) as { id?: string; quantity?: number }[];
    assert.equal(items.length, 2, 'must update 2 items (SLA + mobile)');

    const slaItem = items.find((i) => i.id === STRIPE_SI_SLA);
    assert.ok(slaItem, 'SLA subscription item must be included');

    const mobileItem = items.find((i) => i.id === STRIPE_SI_MOBILE);
    assert.ok(mobileItem, 'mobile subscription item must be included');
    assert.equal(mobileItem?.quantity, 5, 'mobile quantity must be 5');

    await app.close();
  } finally {
    await privilegedSql`DELETE FROM subscription_item WHERE stripe_subscription_item_id = ${STRIPE_SI_MOBILE}`;
  }
});

after(async () => {
  await teardown();
  await sql.end();
  await privilegedSql.end();
});
