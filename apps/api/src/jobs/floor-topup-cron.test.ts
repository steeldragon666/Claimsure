import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { privilegedSql, sql } from '@cpa/db/client';
import type Stripe from 'stripe';
import { runFloorTopupCron } from './floor-topup-cron.js';

// ---------------------------------------------------------------------------
// Fixtures — P9.2.2 namespace (prefix 000000092002)
// ---------------------------------------------------------------------------

const TENANT_STD_A = '00000000-0000-4000-8000-000000092021';
const TENANT_STD_B = '00000000-0000-4000-8000-000000092022';
const TENANT_FOUNDER = '00000000-0000-4000-8000-000000092023';

const CUS_STD_A = 'cus_p922_std_a';
const CUS_STD_B = 'cus_p922_std_b';
const CUS_FOUNDER = 'cus_p922_founder';

const BILLING_MONTH = '2026-05';

// ---------------------------------------------------------------------------
// Mock Stripe
// ---------------------------------------------------------------------------

interface InvoiceItemCreateCall {
  customer: string;
  amount: number;
}

interface InvoicesCreateCall {
  customer: string;
}

// Module-level counter so mock IDs are globally unique across test runs.
let globalInvoiceSeq = 0;

function makeMockStripe(upcomingByCus: Record<string, number>) {
  const invoiceItemCalls: InvoiceItemCreateCall[] = [];
  const invoiceCreateCalls: InvoicesCreateCall[] = [];

  const mock = {
    invoices: {
      retrieveUpcoming: (params: { customer: string }): Promise<{ amount_due: number }> => {
        const amount = upcomingByCus[params.customer];
        if (amount === undefined) {
          return Promise.reject(new Error(`No upcoming invoice for ${params.customer}`));
        }
        return Promise.resolve({ amount_due: amount });
      },
      create: (params: { customer: string }): Promise<{ id: string }> => {
        invoiceCreateCalls.push({ customer: params.customer });
        return Promise.resolve({ id: `in_p922_topup_${++globalInvoiceSeq}` });
      },
    },
    invoiceItems: {
      create: (params: { customer: string; amount: number }): Promise<{ id: string }> => {
        invoiceItemCalls.push({ customer: params.customer, amount: params.amount });
        return Promise.resolve({ id: `ii_p922_${globalInvoiceSeq}` });
      },
    },
  } as unknown as Stripe;

  return { mock, invoiceItemCalls, invoiceCreateCalls };
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
  await privilegedSql`DELETE FROM floor_topup_invoice WHERE tenant_id IN (${TENANT_STD_A}, ${TENANT_STD_B}, ${TENANT_FOUNDER})`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id IN (${TENANT_STD_A}, ${TENANT_STD_B}, ${TENANT_FOUNDER})`;
  await sql`DELETE FROM tenant WHERE id IN (${TENANT_STD_A}, ${TENANT_STD_B}, ${TENANT_FOUNDER})`;

  // Standard tenant A (will receive top-up)
  await sql`
    INSERT INTO tenant (id, name, slug, primary_idp, billing_mode, trial_status, tier, stripe_customer_id)
    VALUES (${TENANT_STD_A}, 'P922 Std A', 'p922-std-a', 'mixed', 'paid', 'converted', 'standard', ${CUS_STD_A})
  `;
  // Standard tenant B (usage above floor, no top-up)
  await sql`
    INSERT INTO tenant (id, name, slug, primary_idp, billing_mode, trial_status, tier, stripe_customer_id)
    VALUES (${TENANT_STD_B}, 'P922 Std B', 'p922-std-b', 'mixed', 'paid', 'converted', 'standard', ${CUS_STD_B})
  `;
  // Founding partner tenant (discounted floor, usage above discounted floor)
  await sql`
    INSERT INTO tenant (id, name, slug, primary_idp, billing_mode, trial_status, tier, stripe_customer_id)
    VALUES (${TENANT_FOUNDER}, 'P922 Founder', 'p922-founder', 'mixed', 'paid', 'converted', 'founding_partner', ${CUS_FOUNDER})
  `;
};

const teardown = async (): Promise<void> => {
  if (!dbAvailable) return;
  await privilegedSql`DELETE FROM floor_topup_invoice WHERE tenant_id IN (${TENANT_STD_A}, ${TENANT_STD_B}, ${TENANT_FOUNDER})`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id IN (${TENANT_STD_A}, ${TENANT_STD_B}, ${TENANT_FOUNDER})`;
  await sql`DELETE FROM tenant WHERE id IN (${TENANT_STD_A}, ${TENANT_STD_B}, ${TENANT_FOUNDER})`;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

before(async () => {
  await setup();
});

test('floor-topup-cron: standard tenant $4K usage → $1K top-up invoiced', async () => {
  if (!dbAvailable) return;

  // upcoming invoices: A=$4K, B=$6K, founder=$3K
  const { mock, invoiceItemCalls, invoiceCreateCalls } = makeMockStripe({
    [CUS_STD_A]: 400_000, // $4,000 AUD cents
    [CUS_STD_B]: 600_000, // $6,000 AUD cents
    [CUS_FOUNDER]: 300_000, // $3,000 AUD cents
  });

  const result = await runFloorTopupCron(mock, BILLING_MONTH);

  // Only tenant A gets billed
  assert.equal(result.billed, 1, `expected 1 billed, got ${result.billed}`);
  assert.equal(result.skipped, 2, `expected 2 skipped`);

  // Invoice item for $1K (500_000 - 400_000 = 100_000 cents)
  assert.equal(invoiceItemCalls.length, 1, 'one invoice item created');
  assert.equal(invoiceItemCalls[0]?.customer, CUS_STD_A);
  assert.equal(invoiceItemCalls[0]?.amount, 100_000, '$1K top-up = 100_000 cents');

  // Invoice created for tenant A
  assert.equal(invoiceCreateCalls.length, 1, 'one invoice created');
  assert.equal(invoiceCreateCalls[0]?.customer, CUS_STD_A);

  // DB record created for tenant A
  const rows = await privilegedSql<{ topup_amount_aud_cents: number; billing_month: string }[]>`
    SELECT topup_amount_aud_cents, billing_month
      FROM floor_topup_invoice
     WHERE tenant_id = ${TENANT_STD_A} AND billing_month = ${BILLING_MONTH}
  `;
  assert.equal(rows.length, 1, 'floor_topup_invoice row created');
  assert.equal(rows[0]?.topup_amount_aud_cents, 100_000);
  assert.equal(rows[0]?.billing_month, BILLING_MONTH);
});

test('floor-topup-cron: standard tenant $6K usage → no top-up', async () => {
  if (!dbAvailable) return;

  const { mock, invoiceItemCalls } = makeMockStripe({
    [CUS_STD_A]: 400_000, // already processed above (idempotency skips it)
    [CUS_STD_B]: 600_000,
    [CUS_FOUNDER]: 300_000,
  });

  await runFloorTopupCron(mock, BILLING_MONTH);

  // Tenant B: $6K >= $5K floor → no top-up
  // Tenant A and C already skipped (A: idempotency from prior test, C: above founder floor)
  // Tenant A is also idempotent now (row from prior test exists)
  const noStdBItem = invoiceItemCalls.every((c) => c.customer !== CUS_STD_B);
  assert.ok(noStdBItem, 'no invoice item for tenant B');

  // Verify no DB row for tenant B
  const rows = await privilegedSql<{ id: string }[]>`
    SELECT id FROM floor_topup_invoice
     WHERE tenant_id = ${TENANT_STD_B} AND billing_month = ${BILLING_MONTH}
  `;
  assert.equal(rows.length, 0, 'no floor_topup_invoice for tenant B');
});

test('floor-topup-cron: founding partner $3K usage → no top-up (floor=$2.5K)', async () => {
  if (!dbAvailable) return;

  // $3K (300_000 cents) > $2.5K founder floor (250_000 cents) → no top-up
  const { mock, invoiceItemCalls } = makeMockStripe({
    [CUS_STD_A]: 400_000,
    [CUS_STD_B]: 600_000,
    [CUS_FOUNDER]: 300_000,
  });

  await runFloorTopupCron(mock, BILLING_MONTH);

  const noFounderItem = invoiceItemCalls.every((c) => c.customer !== CUS_FOUNDER);
  assert.ok(noFounderItem, 'no invoice item for founding partner');

  const rows = await privilegedSql<{ id: string }[]>`
    SELECT id FROM floor_topup_invoice
     WHERE tenant_id = ${TENANT_FOUNDER} AND billing_month = ${BILLING_MONTH}
  `;
  assert.equal(rows.length, 0, 'no floor_topup_invoice for founding partner');
});

test('floor-topup-cron: idempotency — re-run does not double-bill', async () => {
  if (!dbAvailable) return;

  // Clean up and start fresh for a new billing month
  const freshMonth = '2026-06';
  await privilegedSql`DELETE FROM floor_topup_invoice WHERE tenant_id = ${TENANT_STD_A} AND billing_month = ${freshMonth}`;

  const { mock, invoiceItemCalls } = makeMockStripe({
    [CUS_STD_A]: 400_000,
    [CUS_STD_B]: 600_000,
    [CUS_FOUNDER]: 300_000,
  });

  // First run — should bill tenant A
  const first = await runFloorTopupCron(mock, freshMonth);
  assert.equal(first.billed, 1);

  // Second run — should be skipped (idempotency)
  const { mock: mock2, invoiceItemCalls: calls2 } = makeMockStripe({
    [CUS_STD_A]: 400_000,
    [CUS_STD_B]: 600_000,
    [CUS_FOUNDER]: 300_000,
  });
  const second = await runFloorTopupCron(mock2, freshMonth);
  assert.equal(second.billed, 0, 'second run should bill 0 (idempotent)');
  assert.equal(calls2.length, 0, 'no Stripe calls on second run');

  // Cleanup
  await privilegedSql`DELETE FROM floor_topup_invoice WHERE tenant_id = ${TENANT_STD_A} AND billing_month = ${freshMonth}`;
  void invoiceItemCalls; // used
});

test('floor-topup-cron: founding partner $1.5K usage → top-up to $2.5K founder floor', async () => {
  if (!dbAvailable) return;

  const freshMonth = '2026-07';
  await privilegedSql`DELETE FROM floor_topup_invoice WHERE tenant_id = ${TENANT_FOUNDER} AND billing_month = ${freshMonth}`;

  // $1.5K < $2.5K founder floor → top-up = $2.5K - $1.5K = $1K
  const { mock, invoiceItemCalls } = makeMockStripe({
    [CUS_STD_A]: 600_000, // no top-up
    [CUS_STD_B]: 600_000, // no top-up
    [CUS_FOUNDER]: 150_000, // $1.5K → top-up needed
  });

  const result = await runFloorTopupCron(mock, freshMonth);
  assert.equal(result.billed, 1, 'founder billed');

  const founderCall = invoiceItemCalls.find((c) => c.customer === CUS_FOUNDER);
  assert.ok(founderCall, 'invoice item created for founder');
  assert.equal(founderCall?.amount, 100_000, '$1K top-up = 100_000 cents (250K - 150K)');

  // Cleanup
  await privilegedSql`DELETE FROM floor_topup_invoice WHERE tenant_id = ${TENANT_FOUNDER} AND billing_month = ${freshMonth}`;
});

after(async () => {
  await teardown();
  await sql.end();
  await privilegedSql.end();
});
