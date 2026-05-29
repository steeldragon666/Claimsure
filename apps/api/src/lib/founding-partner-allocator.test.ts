import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql, privilegedSql } from '@cpa/db/client';
import { tryClaimFoundingPartnerSlot } from './founding-partner-allocator.js';

/**
 * Founding-partner slot allocator — P9.1.8.
 *
 * Test namespace: 000000098xxx
 * Two test tenants:
 *   TENANT_A — primary requester
 *   TENANT_B — concurrent requester (concurrency test only)
 */

const TENANT_A = '00000000-0000-4000-8000-000000098001';
const TENANT_B = '00000000-0000-4000-8000-000000098002';
// Sentinel tenant used only to "park" the slots migration 0041 seeds (10 rows)
// so they are not claimable during this suite — see the parking note below.
const PARK_TENANT = '00000000-0000-4000-8000-000000098003';

// Fixed UUIDs for ad-hoc test slots (inserted / deleted per test).
const SLOT_SINGLE = '00000000-0000-4000-8000-000000098011';
const SLOT_LAST = '00000000-0000-4000-8000-000000098012';

const CLEANUP_TENANTS = [TENANT_A, TENANT_B, PARK_TENANT];
const ALL_SLOTS = [SLOT_SINGLE, SLOT_LAST];

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

// `tryClaimFoundingPartnerSlot` claims ANY unclaimed slot. Migration 0041 seeds
// 10 real slots, so without isolation the allocator would grab a seeded slot
// (not the one this test inserts) and the old cleanup DELETEd test-tenant-claimed
// rows — destroying the seed and breaking both this suite and the
// "0041 seeded 10 rows" parity check. We instead PARK every pre-existing
// unclaimed slot under PARK_TENANT during the suite (non-destructive) and
// RELEASE them in cleanup, so the allocator only ever sees the slots we insert.
const cleanup = async (): Promise<void> => {
  // Release parked seed slots first (before deleting PARK_TENANT — FK), and
  // un-claim (never delete) any real slot a test tenant grabbed.
  await privilegedSql`
    UPDATE founding_partner_slots
       SET claimed_by_tenant_id = NULL, claimed_at = NULL
     WHERE claimed_by_tenant_id = ANY(${CLEANUP_TENANTS})
  `;
  await privilegedSql`DELETE FROM founding_partner_slots WHERE id = ANY(${ALL_SLOTS})`;
  await sql`DELETE FROM tenant WHERE id = ANY(${CLEANUP_TENANTS})`;
};

before(async () => {
  await cleanup();

  await sql`
    INSERT INTO tenant (id, name, slug, primary_idp)
    VALUES
      (${TENANT_A}, 'FP Test Tenant A', 'fp-test-a-p9181', 'mixed'),
      (${TENANT_B}, 'FP Test Tenant B', 'fp-test-b-p9181', 'mixed'),
      (${PARK_TENANT}, 'FP Park Tenant', 'fp-test-park-p9181', 'mixed')
  `;

  // Park all currently-unclaimed slots so the only claimable slots are the ones
  // each test inserts. Restored to NULL in cleanup().
  await privilegedSql`
    UPDATE founding_partner_slots
       SET claimed_by_tenant_id = ${PARK_TENANT}, claimed_at = now()
     WHERE claimed_by_tenant_id IS NULL
  `;
});

after(async () => {
  await cleanup();
  await sql.end();
  await privilegedSql.end();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('founding-partner-allocator: claim succeeds when slot available', async () => {
  await privilegedSql`INSERT INTO founding_partner_slots (id) VALUES (${SLOT_SINGLE})`;
  try {
    const claimed = await tryClaimFoundingPartnerSlot(TENANT_A);
    assert.equal(claimed, true, 'should return true when an unclaimed slot exists');

    // Verify the slot is now claimed.
    const rows = await privilegedSql<{ claimed_by_tenant_id: string }[]>`
      SELECT claimed_by_tenant_id FROM founding_partner_slots WHERE id = ${SLOT_SINGLE}
    `;
    assert.equal(rows[0]?.claimed_by_tenant_id, TENANT_A);
  } finally {
    await privilegedSql`DELETE FROM founding_partner_slots WHERE id = ${SLOT_SINGLE}`;
  }
});

test('founding-partner-allocator: claim returns false when no slot available', async () => {
  // Ensure no unclaimed slots for these tenants exist.
  const claimed = await tryClaimFoundingPartnerSlot(TENANT_A);
  assert.equal(claimed, false, 'should return false when no unclaimed slot exists');
});

test('founding-partner-allocator: two concurrent claims on last slot — exactly one wins', async () => {
  // Insert exactly one unclaimed slot.
  await privilegedSql`INSERT INTO founding_partner_slots (id) VALUES (${SLOT_LAST})`;
  try {
    // Fire both claims simultaneously.
    const [resultA, resultB] = await Promise.all([
      tryClaimFoundingPartnerSlot(TENANT_A),
      tryClaimFoundingPartnerSlot(TENANT_B),
    ]);

    const winners = [resultA, resultB].filter(Boolean);
    assert.equal(winners.length, 1, 'exactly one of two concurrent claims should succeed');

    // The claimed slot must be owned by exactly one tenant.
    const rows = await privilegedSql<{ claimed_by_tenant_id: string }[]>`
      SELECT claimed_by_tenant_id FROM founding_partner_slots WHERE id = ${SLOT_LAST}
    `;
    const owner = rows[0]?.claimed_by_tenant_id;
    assert.ok(
      owner === TENANT_A || owner === TENANT_B,
      `slot must be owned by A or B; got ${owner}`,
    );
  } finally {
    await privilegedSql`DELETE FROM founding_partner_slots WHERE id = ${SLOT_LAST}`;
  }
});
