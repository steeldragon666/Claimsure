import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { signSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../app.js';
import type Stripe from 'stripe';

// ---------------------------------------------------------------------------
// Fixtures — P9.2.3 namespace (prefix 000000092003)
// ---------------------------------------------------------------------------

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

const TENANT_P923 = '00000000-0000-4000-8000-000000092003';
const ADMIN_USER_P923 = '00000000-0000-4000-8000-000000092030';

const STRIPE_CUSTOMER_ID = 'cus_test_p923_portal';
const STRIPE_SUBSCRIPTION_ID = 'sub_test_p923_portal';
const PORTAL_URL = 'https://billing.stripe.com/p/session/test_p923';

// ---------------------------------------------------------------------------
// Mock Stripe
// ---------------------------------------------------------------------------

interface PortalSessionCreateCall {
  customer: string;
  return_url: string;
}

function makeMockStripe(hasCustomer = true) {
  const createCalls: PortalSessionCreateCall[] = [];

  const mock = {
    billingPortal: {
      sessions: {
        create: (params: { customer: string; return_url: string }): Promise<{ url: string }> => {
          createCalls.push({ customer: params.customer, return_url: params.return_url });
          return Promise.resolve({ url: PORTAL_URL });
        },
      },
    },
  } as unknown as Stripe;

  void hasCustomer; // used by caller to decide whether to seed stripe_customer_id
  return { mock, createCalls };
}

const adminSession = (): Promise<string> =>
  signSession(
    {
      sub: ADMIN_USER_P923,
      email: 'p923-admin@example.com',
      primaryIdp: 'microsoft',
      activeTenantId: TENANT_P923,
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

  // Clean up any leftover fixtures
  await privilegedSql`DELETE FROM subscription WHERE tenant_id = ${TENANT_P923}`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id = ${TENANT_P923}`;
  await sql`DELETE FROM "user" WHERE id = ${ADMIN_USER_P923}`;
  await sql`DELETE FROM tenant WHERE id = ${TENANT_P923}`;

  // Create test fixtures
  await sql`
    INSERT INTO tenant (id, name, slug, primary_idp, billing_mode, trial_status, stripe_customer_id)
    VALUES (${TENANT_P923}, 'P923 Portal Test Firm', 'p923-portal-firm', 'mixed', 'paid', 'converted', ${STRIPE_CUSTOMER_ID})
  `;
  await sql`
    INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
    VALUES (${ADMIN_USER_P923}, 'p923-admin@example.com', 'microsoft', 'microsoft:p923-admin', 'P923 Admin')
  `;
  await privilegedSql`
    INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
    VALUES (gen_random_uuid(), ${TENANT_P923}, ${ADMIN_USER_P923}, 'admin', true)
  `;
  // Seed an active subscription so the activation gate passes
  await privilegedSql`
    INSERT INTO subscription (id, tenant_id, stripe_subscription_id, status)
    VALUES (gen_random_uuid(), ${TENANT_P923}, ${STRIPE_SUBSCRIPTION_ID}, 'active')
  `;
};

const teardown = async (): Promise<void> => {
  if (!dbAvailable) return;
  await privilegedSql`DELETE FROM subscription WHERE tenant_id = ${TENANT_P923}`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id = ${TENANT_P923}`;
  await sql`DELETE FROM "user" WHERE id = ${ADMIN_USER_P923}`;
  await sql`DELETE FROM tenant WHERE id = ${TENANT_P923}`;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

before(async () => {
  await setup();
});

test('POST /v1/billing/portal-session: 401 without session', async () => {
  if (!dbAvailable) return;
  const { mock } = makeMockStripe();
  const app = buildApp({ billing: { stripe: mock } });
  const res = await app.inject({
    method: 'POST',
    url: '/v1/billing/portal-session',
    payload: { return_url: 'https://app.example.com/billing' },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /v1/billing/portal-session: 400 for invalid return_url', async () => {
  if (!dbAvailable) return;
  const { mock } = makeMockStripe();
  const app = buildApp({ billing: { stripe: mock } });
  const token = await adminSession();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/billing/portal-session',
    headers: { cookie: `cpa_session=${token}` },
    payload: { return_url: 'not-a-url' },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /v1/billing/portal-session: 200 returns portal URL', async () => {
  if (!dbAvailable) return;
  const { mock, createCalls } = makeMockStripe();
  const app = buildApp({ billing: { stripe: mock } });

  const token = await adminSession();
  const returnUrl = 'https://app.example.com/billing';
  const res = await app.inject({
    method: 'POST',
    url: '/v1/billing/portal-session',
    headers: { cookie: `cpa_session=${token}` },
    payload: { return_url: returnUrl },
  });

  assert.equal(res.statusCode, 200, `portal-session failed: ${res.body}`);
  const body = JSON.parse(res.body) as { url: string };
  assert.equal(body.url, PORTAL_URL, 'should return the Stripe portal URL');

  assert.equal(createCalls.length, 1, 'billingPortal.sessions.create must be called once');
  assert.equal(createCalls[0]?.customer, STRIPE_CUSTOMER_ID);
  assert.equal(createCalls[0]?.return_url, returnUrl);

  await app.close();
});

test('POST /v1/billing/portal-session: 404 when tenant has no Stripe customer', async () => {
  if (!dbAvailable) return;

  // Temporarily clear the stripe_customer_id
  await sql`UPDATE tenant SET stripe_customer_id = NULL WHERE id = ${TENANT_P923}`;

  const { mock } = makeMockStripe(false);
  const app = buildApp({ billing: { stripe: mock } });

  const token = await adminSession();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/billing/portal-session',
    headers: { cookie: `cpa_session=${token}` },
    payload: { return_url: 'https://app.example.com/billing' },
  });

  assert.equal(res.statusCode, 404);

  // Restore
  await sql`UPDATE tenant SET stripe_customer_id = ${STRIPE_CUSTOMER_ID} WHERE id = ${TENANT_P923}`;
  await app.close();
});

after(async () => {
  await teardown();
  await sql.end();
  await privilegedSql.end();
});
