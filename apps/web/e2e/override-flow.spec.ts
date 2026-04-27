import { expect, test } from '@playwright/test';
import { signInAs } from './fixtures/auth';
import {
  cleanupByEmailPrefix,
  cleanupBySlugPrefix,
  cleanupSubjectTenantsByNamePrefix,
  seedMembership,
  seedSubjectTenant,
  seedTenant,
  seedUser,
} from './fixtures/test-data';

/**
 * T30 — override flow: classify a HYPOTHESIS, override it to OBSERVATION,
 * see both events in the feed.
 *
 * Post-override, the API persists a new OVERRIDE event in the chain and
 * the event_with_effective_kind view bumps the original event's
 * effective_kind to the override's new_kind. So the feed renders:
 *   - top card: the OVERRIDE row (KindChip "OVERRIDE", snippet = reason)
 *   - lower card: the original paste with KindChip now "OBSERVATION"
 *     (effective_kind from the view) and a "verified" overridden-badge
 *
 * The Overrides tab filters to kind='OVERRIDE' rows only.
 */
test.describe('Override flow', () => {
  test.afterAll(async () => {
    await cleanupSubjectTenantsByNamePrefix('e2e-T30-');
    await cleanupBySlugPrefix('e2e-T30-');
    await cleanupByEmailPrefix('e2e-T30-');
  });

  test('classify HYPOTHESIS, override to OBSERVATION, verify both cards', async ({
    page,
    context,
  }) => {
    const tenantId = await seedTenant('e2e-T30-firm');
    const adminId = await seedUser('e2e-T30-admin@example.com', 'T30 Admin');
    await seedMembership(tenantId, adminId, 'admin', true);
    const subjectId = await seedSubjectTenant(tenantId, 'e2e-T30-claimant');

    await signInAs(context, {
      id: adminId,
      email: 'e2e-T30-admin@example.com',
      primaryIdp: 'microsoft',
      activeTenantId: tenantId,
      activeRole: 'admin',
      availableTenants: [
        { tenantId, name: 'E2E e2e-T30-firm', slug: 'e2e-T30-firm', role: 'admin' },
      ],
    });

    await page.goto(`/subject-tenants/${subjectId}`);
    await expect(page.getByText('e2e-T30-claimant')).toBeVisible();

    // Step 1: paste & classify a HYPOTHESIS
    await page
      .getByLabel(/Paste a transcript or note/i)
      .fill('We hypothesised the catalyst would last 200 hours.');
    await page.getByRole('button', { name: /^Classify$/i }).click();
    await expect(page.getByText('HYPOTHESIS')).toBeVisible({ timeout: 10_000 });

    // Step 2: open the Override modal
    await page.getByRole('button', { name: /^Override$/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    // Modal preselects current kind (HYPOTHESIS) — flip to OBSERVATION
    await page.getByLabel(/^New kind$/i).click();
    await page.getByRole('option', { name: /^Observation$/i }).click();
    await page
      .getByLabel(/^Reason$/i)
      .fill('Re-reading, this is a measurement record not a hypothesis.');

    // Step 3: submit
    await page.getByRole('button', { name: /^Save override$/i }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 10_000 });

    // Step 4: feed now has BOTH the OVERRIDE row and the original (with
    // effective_kind bumped to OBSERVATION + an "overridden" badge on the
    // original card).
    await expect(page.getByText('OVERRIDE')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('OBSERVATION')).toBeVisible();
    await expect(page.getByTestId('overridden-badge')).toBeVisible();
    await expect(
      page.getByText(/Re-reading, this is a measurement record not a hypothesis\./i),
    ).toBeVisible();

    // Step 5: "Overrides" tab → only the OVERRIDE row (kind='OVERRIDE')
    await page.getByRole('tab', { name: /^Overrides/i }).click();
    await expect(page.getByText('OVERRIDE')).toBeVisible({ timeout: 5_000 });
    // The original (kind=HYPOTHESIS / effective_kind=OBSERVATION) is filtered
    // out of the Overrides tab — its KindChip text shouldn't appear.
    await expect(page.getByText('OBSERVATION')).not.toBeVisible();
  });
});
