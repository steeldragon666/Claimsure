import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { signSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../app.js';
import type Stripe from 'stripe';

// ---------------------------------------------------------------------------
// Fixtures — P9.2.6 namespace (prefix 000000092006)
// ---------------------------------------------------------------------------

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

const TENANT_P926 = '00000000-0000-4000-8000-000000092006';
const ADMIN_USER_P926 = '00000000-0000-4000-8000-000000092060';
const STRIPE_CUSTOMER_ID = 'cus_test_p926_invoices';
const STRIPE_SUBSCRIPTION_ID = 'sub_test_p926_invoices';

// ---------------------------------------------------------------------------
// Stripe mock invoices
// ---------------------------------------------------------------------------

function makeStripeInvoice(overrides: Partial<Stripe.Invoice> = {}): Stripe.Invoice {
  return {
    id: 'in_test_001',
    object: 'invoice',
    created: 1_700_000_000,
    status: 'paid',
    currency: 'aud',
    total: 11000, // $110.00 AUD (incl 10% GST)
    total_excluding_tax: 10000, // $100.00 AUD (excl GST)
    tax: 1000, // $10.00 GST
    invoice_pdf: 'https://invoice.stripe.com/i/acct_test/in_test_001/pdf',
    ...overrides,
  } as unknown as Stripe.Invoice;
}

function makeMockStripe(invoices: Stripe.Invoice[] = [], hasCustomer = true) {
  const listCalls: { customer?: string }[] = [];

  const mock = {
    invoices: {
      list: (params: {
        customer?: string;
        limit?: number;
      }): Promise<Stripe.ApiList<Stripe.Invoice>> => {
        listCalls.push({ customer: params.customer });
        return Promise.resolve({
          object: 'list',
          data: invoices,
          has_more: false,
          url: '/v1/invoices',
        } as Stripe.ApiList<Stripe.Invoice>);
      },
    },
  } as unknown as Stripe;

  void hasCustomer;
  return { mock, listCalls };
}

const adminSession = (): Promise<string> =>
  signSession(
    {
      sub: ADMIN_USER_P926,
      email: 'p926-admin@example.com',
      primaryIdp: 'microsoft',
      activeTenantId: TENANT_P926,
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

  await privilegedSql`DELETE FROM subscription WHERE tenant_id = ${TENANT_P926}`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id = ${TENANT_P926}`;
  await sql`DELETE FROM "user" WHERE id = ${ADMIN_USER_P926}`;
  await sql`DELETE FROM tenant WHERE id = ${TENANT_P926}`;

  await sql`
    INSERT INTO tenant (id, name, slug, primary_idp, billing_mode, trial_status, stripe_customer_id)
    VALUES (${TENANT_P926}, 'P926 Invoices Test Firm', 'p926-invoices-firm', 'mixed', 'paid', 'converted', ${STRIPE_CUSTOMER_ID})
  `;
  await sql`
    INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
    VALUES (${ADMIN_USER_P926}, 'p926-admin@example.com', 'microsoft', 'microsoft:p926-admin', 'P926 Admin')
  `;
  await privilegedSql`
    INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
    VALUES (gen_random_uuid(), ${TENANT_P926}, ${ADMIN_USER_P926}, 'admin', true)
  `;
  await privilegedSql`
    INSERT INTO subscription (id, tenant_id, stripe_subscription_id, status)
    VALUES (gen_random_uuid(), ${TENANT_P926}, ${STRIPE_SUBSCRIPTION_ID}, 'active')
  `;
};

const teardown = async (): Promise<void> => {
  if (!dbAvailable) return;
  await privilegedSql`DELETE FROM subscription WHERE tenant_id = ${TENANT_P926}`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id = ${TENANT_P926}`;
  await sql`DELETE FROM "user" WHERE id = ${ADMIN_USER_P926}`;
  await sql`DELETE FROM tenant WHERE id = ${TENANT_P926}`;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

before(async () => {
  await setup();
});

test('GET /v1/invoices: 401 without session', async () => {
  if (!dbAvailable) return;
  const { mock } = makeMockStripe();
  const app = buildApp({ billing: { stripe: mock } });
  const res = await app.inject({ method: 'GET', url: '/v1/invoices' });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('GET /v1/invoices: 200 returns empty list when tenant has no Stripe customer', async () => {
  if (!dbAvailable) return;

  // Temporarily clear the stripe_customer_id
  await sql`UPDATE tenant SET stripe_customer_id = NULL WHERE id = ${TENANT_P926}`;

  const { mock, listCalls } = makeMockStripe([], false);
  const app = buildApp({ billing: { stripe: mock } });
  const token = await adminSession();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/invoices',
    headers: { cookie: `cpa_session=${token}` },
  });

  assert.equal(res.statusCode, 200, `invoices failed: ${res.body}`);
  const body = JSON.parse(res.body) as { invoices: unknown[] };
  assert.deepEqual(body.invoices, [], 'should return empty list when no Stripe customer');
  assert.equal(listCalls.length, 0, 'Stripe invoices.list must NOT be called without a customer');

  // Restore
  await sql`UPDATE tenant SET stripe_customer_id = ${STRIPE_CUSTOMER_ID} WHERE id = ${TENANT_P926}`;
  await app.close();
});

test('GET /v1/invoices: 200 returns invoice list with GST breakdown', async () => {
  if (!dbAvailable) return;

  const inv = makeStripeInvoice();
  const { mock, listCalls } = makeMockStripe([inv]);
  const app = buildApp({ billing: { stripe: mock } });
  const token = await adminSession();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/invoices',
    headers: { cookie: `cpa_session=${token}` },
  });

  assert.equal(res.statusCode, 200, `invoices failed: ${res.body}`);
  const body = JSON.parse(res.body) as {
    invoices: {
      id: string;
      created: number;
      status: string;
      currency: string;
      subtotal_excl_tax: number;
      tax_amount: number;
      total: number;
      invoice_pdf: string | null;
    }[];
  };

  assert.equal(body.invoices.length, 1, 'should return one invoice');
  const result = body.invoices[0]!;
  assert.equal(result.id, 'in_test_001');
  assert.equal(result.status, 'paid');
  assert.equal(result.currency, 'aud');
  assert.equal(result.total, 11000, 'total must be 110.00 AUD in cents');
  assert.equal(result.subtotal_excl_tax, 10000, 'subtotal excl tax must be 100.00 AUD in cents');
  assert.equal(result.tax_amount, 1000, 'GST must be 10.00 AUD in cents (total - excl_tax)');
  assert.equal(
    result.invoice_pdf,
    'https://invoice.stripe.com/i/acct_test/in_test_001/pdf',
    'must include PDF download URL',
  );

  assert.equal(listCalls.length, 1, 'Stripe invoices.list must be called once');
  assert.equal(listCalls[0]?.customer, STRIPE_CUSTOMER_ID, 'must list by customer ID');

  await app.close();
});

test('GET /v1/invoices: 200 returns multiple invoices sorted newest first', async () => {
  if (!dbAvailable) return;

  const inv1 = makeStripeInvoice({ id: 'in_older', created: 1_690_000_000, status: 'paid' });
  const inv2 = makeStripeInvoice({ id: 'in_newer', created: 1_710_000_000, status: 'open' });
  // Stripe returns newest first by default; we just pass through the order
  const { mock } = makeMockStripe([inv2, inv1]);
  const app = buildApp({ billing: { stripe: mock } });
  const token = await adminSession();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/invoices',
    headers: { cookie: `cpa_session=${token}` },
  });

  assert.equal(res.statusCode, 200, `invoices failed: ${res.body}`);
  const body = JSON.parse(res.body) as { invoices: { id: string }[] };
  assert.equal(body.invoices.length, 2);
  assert.equal(body.invoices[0]?.id, 'in_newer', 'first invoice must be newest');
  assert.equal(body.invoices[1]?.id, 'in_older', 'second invoice must be older');

  await app.close();
});

test('GET /v1/invoices: handles invoice with null total_excluding_tax (pre-Stripe-Tax)', async () => {
  if (!dbAvailable) return;

  const inv = makeStripeInvoice({ total_excluding_tax: null, total: 5000, tax: 0 });
  const { mock } = makeMockStripe([inv]);
  const app = buildApp({ billing: { stripe: mock } });
  const token = await adminSession();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/invoices',
    headers: { cookie: `cpa_session=${token}` },
  });

  assert.equal(res.statusCode, 200, `invoices failed: ${res.body}`);
  const body = JSON.parse(res.body) as {
    invoices: { subtotal_excl_tax: number; tax_amount: number; total: number }[];
  };
  const result = body.invoices[0]!;
  // When total_excluding_tax is null, subtotal should equal total (no tax)
  assert.equal(
    result.subtotal_excl_tax,
    5000,
    'subtotal should fall back to total when excl_tax is null',
  );
  assert.equal(result.tax_amount, 0, 'tax should be 0 when no tax breakdown available');

  await app.close();
});

after(async () => {
  await teardown();
  await sql.end();
  await privilegedSql.end();
});
