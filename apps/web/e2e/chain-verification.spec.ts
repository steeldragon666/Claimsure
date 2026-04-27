import { expect, test } from '@playwright/test';
import { privilegedSql } from '@cpa/db/client';
import { signInAs } from './fixtures/auth';
import {
  cleanupByEmailPrefix,
  cleanupBySlugPrefix,
  cleanupSubjectTenantsByNamePrefix,
  seedEvent,
  seedMembership,
  seedSubjectTenant,
  seedTenant,
  seedUser,
} from './fixtures/test-data';

/**
 * T31 — chain-verification badge: green "Verified" when intact, red
 * "Hash break" when a row is tampered with.
 *
 * We seed two events directly with seedEvent (chain-extending insert via
 * privilegedSql) so the chain is well-formed. Then we navigate to the
 * detail page and confirm the badge says "Verified".
 *
 * Tampering: we hand-edit the first event's hash on the row to keep the
 * `^[0-9a-f]{64}$` CHECK constraint satisfied (deadbeef = 8 hex chars +
 * substring(hash from 9) = 56 hex chars → 64 total). After the page
 * reloads, verifyChain detects the mismatch (the recomputed sha256 won't
 * equal the stored hash, AND the next event's prev_hash references the
 * original head) and the badge flips to "Hash break".
 *
 * We restore the original hash in afterAll (before cleanupSubjectTenants…
 * fires) so the chain isn't broken when the cleanup DELETE walks rows —
 * not strictly required (DELETE doesn't recompute hashes) but keeps the
 * teardown deterministic.
 */
test.describe('Chain verification badge', () => {
  test.afterAll(async () => {
    await cleanupSubjectTenantsByNamePrefix('e2e-T31-');
    await cleanupBySlugPrefix('e2e-T31-');
    await cleanupByEmailPrefix('e2e-T31-');
  });

  test('Verified badge → tamper hash → Hash break badge', async ({ page, context }) => {
    const tenantId = await seedTenant('e2e-T31-firm');
    const adminId = await seedUser('e2e-T31-admin@example.com', 'T31 Admin');
    await seedMembership(tenantId, adminId, 'admin', true);
    const subjectId = await seedSubjectTenant(tenantId, 'e2e-T31-claimant');

    // Seed two well-formed events directly into the chain.
    const first = await seedEvent({
      tenantId,
      subjectTenantId: subjectId,
      capturedByUserId: adminId,
      kind: 'HYPOTHESIS',
      payload: { _v: 1, source: 'paste', raw_text: 'First event seed' },
      classification: {
        kind: 'HYPOTHESIS',
        confidence: 0.85,
        rationale: 'seed',
        statutory_anchor: '§355-25(1)(a)',
        model: 'stub-v1.0.0',
        prompt_version: 'classify@1.0.0',
        tokens_in: 0,
        tokens_out: 0,
      },
      capturedAt: new Date(Date.now() - 60_000),
    });
    await seedEvent({
      tenantId,
      subjectTenantId: subjectId,
      capturedByUserId: adminId,
      kind: 'OBSERVATION',
      payload: { _v: 1, source: 'paste', raw_text: 'Second event seed' },
      classification: {
        kind: 'OBSERVATION',
        confidence: 0.78,
        rationale: 'seed',
        statutory_anchor: '§355-25(1)(a)',
        model: 'stub-v1.0.0',
        prompt_version: 'classify@1.0.0',
        tokens_in: 0,
        tokens_out: 0,
      },
      capturedAt: new Date(),
    });

    await signInAs(context, {
      id: adminId,
      email: 'e2e-T31-admin@example.com',
      primaryIdp: 'microsoft',
      activeTenantId: tenantId,
      activeRole: 'admin',
      availableTenants: [
        { tenantId, name: 'E2E e2e-T31-firm', slug: 'e2e-T31-firm', role: 'admin' },
      ],
    });

    // Step 1: well-formed chain → "Verified"
    await page.goto(`/subject-tenants/${subjectId}`);
    await expect(page.getByText('e2e-T31-claimant')).toBeVisible();
    await expect(page.getByText(/Verified \(/i)).toBeVisible({ timeout: 5_000 });

    // Step 2: corrupt the first event's hash (deadbeef + 56 chars of original
    // = 64 lowercase hex, satisfies the CHECK constraint event_hash_format).
    // The unique-on-hash index means we can't accidentally collide with the
    // second event's hash since it starts with whatever sha256 produced, not
    // 'deadbeef'.
    await privilegedSql`
      UPDATE event
         SET hash = 'deadbeef' || substring(hash from 9)
       WHERE id = ${first.id}
    `;

    try {
      // Step 3: reload — chain status badge should show "Hash break"
      await page.reload();
      await expect(page.getByText(/Hash break/i)).toBeVisible({ timeout: 5_000 });
    } finally {
      // Restore so the cleanup teardown isn't operating on a broken chain
      // (cleanupSubjectTenantsByNamePrefix doesn't care about hashes, but
      // a clean restore keeps the test deterministic if it gets re-run).
      await privilegedSql`
        UPDATE event
           SET hash = ${first.hash}
         WHERE id = ${first.id}
      `;
    }
  });
});
