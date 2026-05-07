import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql, privilegedSql } from '@cpa/db/client';
import type Stripe from 'stripe';
import { runSubscriptionReconcileCron } from './subscription-reconcile-cron.js';

// ---------------------------------------------------------------------------
// Fixtures — P9.2.8 namespace (prefix 000000092008)
// ---------------------------------------------------------------------------

const TENANT_A = '00000000-0000-4000-8000-000000092081';
const TENANT_B = '00000000-0000-4000-8000-000000092082';

const STRIPE_SUB_ACTIVE = 'sub_rec_p928_active';
const STRIPE_SUB_DRIFTED = 'sub_rec_p928_drifted'; // DB says active, Stripe says past_due
const STRIPE_SUB_DELETED = 'sub_rec_p928_deleted'; // Stripe returns 404

// ---------------------------------------------------------------------------
// Mock Stripe
// ---------------------------------------------------------------------------

function makeMockStripe(responses: Record<string, { status: string } | 'not_found' | 'error'>) {
  const retrieveCalls: string[] = [];

  const mock = {
    subscriptions: {
      retrieve: (id: string): Promise<Stripe.Subscription> => {
        retrieveCalls.push(id);
        const resp = responses[id];
        if (resp === 'not_found') {
          const err = new Error('No such subscription') as Error & {
            statusCode: number;
          };
          err.statusCode = 404;
          return Promise.reject(err);
        }
        if (resp === 'error') {
          return Promise.reject(new Error('Stripe API error'));
        }
        return Promise.resolve({
          id,
          status: (resp as { status: string }).status,
          object: 'subscription',
        } as unknown as Stripe.Subscription);
      },
    },
  } as unknown as Stripe;

  return { mock, retrieveCalls };
}

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
  await privilegedSql`DELETE FROM subscription WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await sql`DELETE FROM tenant WHERE id IN (${TENANT_A}, ${TENANT_B})`;

  await sql`
    INSERT INTO tenant (id, name, slug, primary_idp, billing_mode, trial_status, stripe_customer_id)
    VALUES
      (${TENANT_A}, 'Reconcile Firm A', 'reconcile-firm-a', 'mixed', 'paid', 'converted', 'cus_rec_p928_a'),
      (${TENANT_B}, 'Reconcile Firm B', 'reconcile-firm-b', 'mixed', 'paid', 'converted', 'cus_rec_p928_b')
  `;

  // Seed subscriptions
  await privilegedSql`
    INSERT INTO subscription (id, tenant_id, stripe_subscription_id, status)
    VALUES
      (gen_random_uuid(), ${TENANT_A}, ${STRIPE_SUB_ACTIVE},  'active'),
      (gen_random_uuid(), ${TENANT_A}, ${STRIPE_SUB_DRIFTED}, 'active'),
      (gen_random_uuid(), ${TENANT_B}, ${STRIPE_SUB_DELETED}, 'active')
  `;
};

const teardown = async (): Promise<void> => {
  if (!dbAvailable) return;
  await privilegedSql`DELETE FROM subscription WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await sql`DELETE FROM tenant WHERE id IN (${TENANT_A}, ${TENANT_B})`;
};

before(async () => {
  await setup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('runSubscriptionReconcileCron: no drift when statuses match Stripe', async () => {
  if (!dbAvailable) return;

  // All subscriptions healthy — Stripe confirms same status
  const { mock, retrieveCalls } = makeMockStripe({
    [STRIPE_SUB_ACTIVE]: { status: 'active' },
    [STRIPE_SUB_DRIFTED]: { status: 'active' },
    [STRIPE_SUB_DELETED]: { status: 'active' },
  });

  const reporterCalls: string[] = [];
  const result = await runSubscriptionReconcileCron({
    stripe: mock,
    reporter: (msg) => reporterCalls.push(msg),
  });

  assert.equal(result.checked, 3, 'should check all 3 subscriptions');
  assert.equal(result.drifted, 0, 'no drift expected');
  assert.equal(result.errors, 0, 'no errors expected');
  assert.equal(retrieveCalls.length, 3, 'should call Stripe 3 times');
  assert.equal(reporterCalls.length, 0, 'reporter must not be called when no drift');
});

test('runSubscriptionReconcileCron: detects status drift and updates DB', async () => {
  if (!dbAvailable) return;

  const { mock } = makeMockStripe({
    [STRIPE_SUB_ACTIVE]: { status: 'active' },
    [STRIPE_SUB_DRIFTED]: { status: 'past_due' }, // <-- drift: DB says active
    [STRIPE_SUB_DELETED]: { status: 'active' },
  });

  const reporterCalls: { msg: string; data: Record<string, unknown> }[] = [];
  const result = await runSubscriptionReconcileCron({
    stripe: mock,
    reporter: (msg, data) => reporterCalls.push({ msg, data }),
  });

  assert.equal(result.drifted, 1, 'exactly one subscription drifted');

  // DB must be updated to reflect Stripe's status
  const rows = await privilegedSql<{ status: string }[]>`
    SELECT status FROM subscription WHERE stripe_subscription_id = ${STRIPE_SUB_DRIFTED}
  `;
  assert.equal(rows[0]?.status, 'past_due', 'DB status must be updated to Stripe status');

  // Reporter must be called with drift info
  assert.equal(reporterCalls.length, 1, 'reporter called once for drift');
  assert.ok(
    reporterCalls[0]?.msg.toLowerCase().includes('drift') ||
      reporterCalls[0]?.msg.toLowerCase().includes('mismatch'),
    `reporter message must describe drift; got: ${reporterCalls[0]?.msg}`,
  );

  // Restore DB state for subsequent tests
  await privilegedSql`
    UPDATE subscription SET status = 'active' WHERE stripe_subscription_id = ${STRIPE_SUB_DRIFTED}
  `;
});

test('runSubscriptionReconcileCron: treats Stripe 404 as canceled and alerts', async () => {
  if (!dbAvailable) return;

  const { mock } = makeMockStripe({
    [STRIPE_SUB_ACTIVE]: { status: 'active' },
    [STRIPE_SUB_DRIFTED]: { status: 'active' },
    [STRIPE_SUB_DELETED]: 'not_found', // <-- 404: subscription deleted in Stripe
  });

  const reporterCalls: { msg: string; data: Record<string, unknown> }[] = [];
  const result = await runSubscriptionReconcileCron({
    stripe: mock,
    reporter: (msg, data) => reporterCalls.push({ msg, data }),
  });

  assert.equal(result.drifted, 1, '404 counts as drift');

  const rows = await privilegedSql<{ status: string }[]>`
    SELECT status FROM subscription WHERE stripe_subscription_id = ${STRIPE_SUB_DELETED}
  `;
  assert.equal(rows[0]?.status, 'cancelled', 'Stripe 404 → mark as cancelled in DB');

  assert.equal(reporterCalls.length, 1, 'reporter called once for the 404');

  // Restore
  await privilegedSql`
    UPDATE subscription SET status = 'active' WHERE stripe_subscription_id = ${STRIPE_SUB_DELETED}
  `;
});

test('runSubscriptionReconcileCron: handles transient Stripe error gracefully', async () => {
  if (!dbAvailable) return;

  const { mock } = makeMockStripe({
    [STRIPE_SUB_ACTIVE]: { status: 'active' },
    [STRIPE_SUB_DRIFTED]: 'error', // <-- API error
    [STRIPE_SUB_DELETED]: { status: 'active' },
  });

  const reporterCalls: string[] = [];
  const result = await runSubscriptionReconcileCron({
    stripe: mock,
    reporter: (msg) => reporterCalls.push(msg),
  });

  // Must not throw; errors are counted
  assert.equal(result.errors, 1, 'one error counted');
  assert.equal(result.drifted, 0, 'no drift from an errored check');
  assert.equal(reporterCalls.length, 1, 'reporter called once for the Stripe error');
});

test('runSubscriptionReconcileCron: skips canceled subscriptions', async () => {
  if (!dbAvailable) return;

  // Temporarily mark one subscription as cancelled
  await privilegedSql`
    UPDATE subscription SET status = 'cancelled' WHERE stripe_subscription_id = ${STRIPE_SUB_ACTIVE}
  `;

  const { mock, retrieveCalls } = makeMockStripe({
    [STRIPE_SUB_DRIFTED]: { status: 'active' },
    [STRIPE_SUB_DELETED]: { status: 'active' },
    // STRIPE_SUB_ACTIVE not in mock: if called, it would reject
  });

  const result = await runSubscriptionReconcileCron({
    stripe: mock,
  });

  assert.ok(!retrieveCalls.includes(STRIPE_SUB_ACTIVE), 'must not call Stripe for canceled sub');
  assert.ok(result.checked < 3, 'canceled subscription excluded from checked count');

  // Restore
  await privilegedSql`
    UPDATE subscription SET status = 'active' WHERE stripe_subscription_id = ${STRIPE_SUB_ACTIVE}
  `;
});

after(async () => {
  await teardown();
  await sql.end();
  await privilegedSql.end();
});
