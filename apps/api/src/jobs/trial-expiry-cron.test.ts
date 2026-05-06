import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql, privilegedSql } from '@cpa/db/client';
import { runTrialExpiryCron } from './trial-expiry-cron.js';

// ---------------------------------------------------------------------------
// Fixtures — P9.1.6.2 namespace (prefix 000000093xxx)
// ---------------------------------------------------------------------------

const TENANT_EXPIRED = '00000000-0000-4000-8000-000000093001'; // trial_ends_at in the past
const TENANT_ACTIVE = '00000000-0000-4000-8000-000000093002'; // trial_ends_at in the future
const TENANT_ALREADY_EXPIRED = '00000000-0000-4000-8000-000000093003'; // already trial_status='expired'
const TENANT_CONVERTED = '00000000-0000-4000-8000-000000093004'; // already converted

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

before(async () => {
  // Clean up any leftover fixtures
  await privilegedSql`DELETE FROM tenant WHERE id IN (${TENANT_EXPIRED}, ${TENANT_ACTIVE}, ${TENANT_ALREADY_EXPIRED}, ${TENANT_CONVERTED})`;

  const pastDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 days ago
  const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days from now

  await sql`
    INSERT INTO tenant (id, name, slug, primary_idp, trial_status, trial_ends_at, billing_mode)
    VALUES
      (${TENANT_EXPIRED}, 'Expired Firm', 'expired-firm', 'mixed', 'active', ${pastDate}, 'trial'),
      (${TENANT_ACTIVE}, 'Active Firm', 'active-firm', 'mixed', 'active', ${futureDate}, 'trial'),
      (${TENANT_ALREADY_EXPIRED}, 'Already Expired', 'already-expired', 'mixed', 'expired', ${pastDate}, 'trial'),
      (${TENANT_CONVERTED}, 'Converted Firm', 'converted-firm', 'mixed', 'converted', ${futureDate}, 'paid')
  `;
});

after(async () => {
  await privilegedSql`DELETE FROM tenant WHERE id IN (${TENANT_EXPIRED}, ${TENANT_ACTIVE}, ${TENANT_ALREADY_EXPIRED}, ${TENANT_CONVERTED})`;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('runTrialExpiryCron: marks overdue active trials as expired', async () => {
  const result = await runTrialExpiryCron();

  // At least TENANT_EXPIRED should be marked expired
  assert.ok(result.expired >= 1, 'should expire at least one tenant');

  const rows = await sql<{ trial_status: string }[]>`
    SELECT trial_status FROM tenant WHERE id = ${TENANT_EXPIRED}
  `;
  assert.equal(rows[0]?.trial_status, 'expired');
});

test('runTrialExpiryCron: does not expire tenants with future trial_ends_at', async () => {
  await runTrialExpiryCron();

  const rows = await sql<{ trial_status: string }[]>`
    SELECT trial_status FROM tenant WHERE id = ${TENANT_ACTIVE}
  `;
  assert.equal(rows[0]?.trial_status, 'active');
});

test('runTrialExpiryCron: does not touch already-expired tenants', async () => {
  await runTrialExpiryCron();

  // The already-expired tenant should still be expired (no double-processing)
  const rows = await sql<{ trial_status: string }[]>`
    SELECT trial_status FROM tenant WHERE id = ${TENANT_ALREADY_EXPIRED}
  `;
  assert.equal(rows[0]?.trial_status, 'expired');
});

test('runTrialExpiryCron: does not touch converted tenants', async () => {
  await runTrialExpiryCron();

  const rows = await sql<{ trial_status: string; billing_mode: string }[]>`
    SELECT trial_status, billing_mode FROM tenant WHERE id = ${TENANT_CONVERTED}
  `;
  assert.equal(rows[0]?.trial_status, 'converted');
  assert.equal(rows[0]?.billing_mode, 'paid');
});

test('runTrialExpiryCron: returns count of newly expired tenants', async () => {
  // Reset TENANT_EXPIRED back to 'active' to test counting
  const pastDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
  await privilegedSql`
    UPDATE tenant SET trial_status = 'active', trial_ends_at = ${pastDate}
    WHERE id = ${TENANT_EXPIRED}
  `;

  const result = await runTrialExpiryCron();
  assert.ok(typeof result.expired === 'number', 'expired count should be a number');
  assert.ok(result.expired >= 1, 'should report at least 1 expired');
});
