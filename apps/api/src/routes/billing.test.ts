import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type Stripe from 'stripe';
import { signSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../app.js';

// ---------------------------------------------------------------------------
// Fixtures — P9.1.4 namespace (disjoint from other test files)
// ---------------------------------------------------------------------------

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

// Fixed UUIDs in the p9/billing namespace (prefix 000000091xxx)
const TENANT_P9B = '00000000-0000-4000-8000-000000091001';
const ADMIN_USER_P9B = '00000000-0000-4000-8000-000000091010';

// Sentinel tenant used to claim all seeded founding_partner_slots so tests
// start from a "no slots available" baseline.  We release the claims in
// after() to leave the DB in the state migration 0041 intended.
const SENTINEL_TENANT = '00000000-0000-4000-8000-000000091099';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal mock Stripe object that satisfies BillingRouteDeps. */
function makeMockStripe(checkoutUrl = 'https://checkout.stripe.com/pay/cs_test_123') {
  const calls: Stripe.Checkout.SessionCreateParams[] = [];
  const mock = {
    checkout: {
      sessions: {
        create: async (params: Stripe.Checkout.SessionCreateParams) =>
          new Promise<Stripe.Response<Stripe.Checkout.Session>>((resolve) => {
            calls.push(params);
            resolve({
              url: checkoutUrl,
              id: 'cs_test_123',
            } as Stripe.Response<Stripe.Checkout.Session>);
          }),
      },
    },
  } as unknown as Stripe;
  return { mock, calls };
}

const adminSession = (): Promise<string> =>
  signSession(
    {
      sub: ADMIN_USER_P9B,
      email: 'p9b-admin@example.com',
      primaryIdp: 'microsoft',
      activeTenantId: TENANT_P9B,
      activeRole: 'admin',
      availableTenants: [],
    },
    SESSION_SECRET,
    { ttlSeconds: 3600 },
  );

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

before(async () => {
  // Clean up any leftover fixtures from a previous interrupted run.
  await privilegedSql`DELETE FROM founding_partner_slots WHERE claimed_by_tenant_id = ${SENTINEL_TENANT}`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id IN (${TENANT_P9B}, ${SENTINEL_TENANT})`;
  await sql`DELETE FROM "user" WHERE id = ${ADMIN_USER_P9B}`;
  await sql`DELETE FROM tenant WHERE id IN (${TENANT_P9B}, ${SENTINEL_TENANT})`;

  // Create test fixtures.
  await sql`
    INSERT INTO tenant (id, name, slug, primary_idp)
    VALUES (${TENANT_P9B}, 'P9 Billing Firm', 'p9-billing-firm', 'mixed'),
           (${SENTINEL_TENANT}, 'Sentinel', 'p9-sentinel', 'mixed')
  `;
  await sql`
    INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
    VALUES (${ADMIN_USER_P9B}, 'p9b-admin@example.com', 'microsoft', 'microsoft:p9b-admin', 'P9B Admin')
  `;
  await privilegedSql`
    INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
    VALUES (gen_random_uuid(), ${TENANT_P9B}, ${ADMIN_USER_P9B}, 'admin', true)
  `;

  // Claim all seeded slots with the sentinel tenant so tests start from
  // a "no slots available" baseline.  Individual tests that need a slot
  // insert their own test slot in the founding_partner_slots table.
  await privilegedSql`
    UPDATE founding_partner_slots
       SET claimed_by_tenant_id = ${SENTINEL_TENANT},
           claimed_at           = NOW()
     WHERE claimed_by_tenant_id IS NULL
  `;
});

after(async () => {
  // Release sentinel claims so the seeded rows are unclaimed again.
  await privilegedSql`
    UPDATE founding_partner_slots
       SET claimed_by_tenant_id = NULL,
           claimed_at           = NULL
     WHERE claimed_by_tenant_id = ${SENTINEL_TENANT}
  `;
  // Note: ad-hoc test slots are deleted inline in each test's finally block,
  // so no further slot cleanup is needed here. DO NOT delete unclaimed rows —
  // that would wipe the 10 seeded slots that migration 0041 requires.

  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id IN (${TENANT_P9B}, ${SENTINEL_TENANT})`;
  await sql`DELETE FROM "user" WHERE id = ${ADMIN_USER_P9B}`;
  await sql`DELETE FROM tenant WHERE id IN (${TENANT_P9B}, ${SENTINEL_TENANT})`;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('POST /v1/billing/checkout-session: 401 without session', async () => {
  const { mock } = makeMockStripe();
  const app = buildApp({ billing: { stripe: mock } });

  const res = await app.inject({
    method: 'POST',
    url: '/v1/billing/checkout-session',
    payload: {
      success_url: 'https://app.example.com/billing/success',
      cancel_url: 'https://app.example.com/billing/cancel',
    },
  });

  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /v1/billing/checkout-session: returns checkout URL (no slot)', async () => {
  // All slots are claimed by sentinel — no founding-partner coupon expected.
  const { mock, calls } = makeMockStripe();
  const app = buildApp({ billing: { stripe: mock } });

  const token = await adminSession();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/billing/checkout-session',
    headers: { cookie: `cpa_session=${token}` },
    payload: {
      success_url: 'https://app.example.com/billing/success',
      cancel_url: 'https://app.example.com/billing/cancel',
    },
  });

  assert.equal(res.statusCode, 200);
  const body = res.json<{ checkout_url: string }>();
  assert.equal(body.checkout_url, 'https://checkout.stripe.com/pay/cs_test_123');

  assert.equal(calls.length, 1);
  // No discount when no slot is available.
  assert.ok(!calls[0]?.discounts?.length, 'must not apply founder coupon when no slot available');

  await app.close();
});

test('POST /v1/billing/checkout-session: attaches founding-partner coupon when slot available', async () => {
  // Insert a fresh unclaimed test slot.
  const TEST_SLOT_ID = '00000000-0000-4000-8000-000000091050';
  await privilegedSql`
    INSERT INTO founding_partner_slots (id)
    VALUES (${TEST_SLOT_ID})
    ON CONFLICT (id) DO NOTHING
  `;

  try {
    const { mock, calls } = makeMockStripe();
    const app = buildApp({ billing: { stripe: mock } });

    const token = await adminSession();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/billing/checkout-session',
      headers: { cookie: `cpa_session=${token}` },
      payload: {
        success_url: 'https://app.example.com/billing/success',
        cancel_url: 'https://app.example.com/billing/cancel',
      },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);

    const discounts = calls[0]?.discounts ?? [];
    assert.ok(
      discounts.some((d) => typeof d.coupon === 'string' && d.coupon.startsWith('FOUNDER')),
      `founding-partner coupon must be applied; got discounts: ${JSON.stringify(discounts)}`,
    );

    await app.close();
  } finally {
    // Always clean up the test slot regardless of pass/fail.
    await privilegedSql`DELETE FROM founding_partner_slots WHERE id = ${TEST_SLOT_ID}`;
  }
});

test('POST /v1/billing/checkout-session: metadata contains tenant_id', async () => {
  const { mock, calls } = makeMockStripe();
  const app = buildApp({ billing: { stripe: mock } });

  const token = await adminSession();
  await app.inject({
    method: 'POST',
    url: '/v1/billing/checkout-session',
    headers: { cookie: `cpa_session=${token}` },
    payload: {
      success_url: 'https://app.example.com/billing/success',
      cancel_url: 'https://app.example.com/billing/cancel',
    },
  });

  assert.equal(calls[0]?.metadata?.['tenant_id'], TENANT_P9B);
  await app.close();
});

test('POST /v1/billing/checkout-session: automatic_tax enabled', async () => {
  const { mock, calls } = makeMockStripe();
  const app = buildApp({ billing: { stripe: mock } });

  const token = await adminSession();
  await app.inject({
    method: 'POST',
    url: '/v1/billing/checkout-session',
    headers: { cookie: `cpa_session=${token}` },
    payload: {
      success_url: 'https://app.example.com/billing/success',
      cancel_url: 'https://app.example.com/billing/cancel',
    },
  });

  assert.equal(calls[0]?.automatic_tax?.enabled, true, 'Stripe Tax must be enabled for AU GST');
  await app.close();
});
