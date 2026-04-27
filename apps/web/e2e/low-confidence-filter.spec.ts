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
 * T29 — low-confidence event lands in the "Needs Review" tab.
 *
 * Uses input that the stub classifier hits no rule for, so it falls
 * through to the SUPPORTING default (confidence 0.50, < 0.7 threshold).
 * The API's needs_review filter is `confidence < 0.7 AND NOT is_overridden`
 * (apps/api/src/routes/events.ts), and the FilterTabs render counts via
 * the same listEvents endpoint, so we can assert routing both ways:
 *   - "Needs Review" tab: event is visible
 *   - "All" tab: event is still visible (sanity)
 *   - "Ineligible" tab: empty-state copy ("No events yet…")
 *   - "Overrides" tab: empty-state copy
 *
 * Header text uses getByText (not getByRole('heading')) per the
 * shadcn-CardTitle-as-`<div>` pitfall.
 */
test.describe('Low-confidence filter (Needs Review)', () => {
  test.afterAll(async () => {
    await cleanupSubjectTenantsByNamePrefix('e2e-T29-');
    await cleanupBySlugPrefix('e2e-T29-');
    await cleanupByEmailPrefix('e2e-T29-');
  });

  test('< 0.7 confidence shows in Needs Review, not in Ineligible/Overrides', async ({
    page,
    context,
  }) => {
    const tenantId = await seedTenant('e2e-T29-firm');
    const adminId = await seedUser('e2e-T29-admin@example.com', 'T29 Admin');
    await seedMembership(tenantId, adminId, 'admin', true);
    const subjectId = await seedSubjectTenant(tenantId, 'e2e-T29-claimant');

    await signInAs(context, {
      id: adminId,
      email: 'e2e-T29-admin@example.com',
      primaryIdp: 'microsoft',
      activeTenantId: tenantId,
      activeRole: 'admin',
      availableTenants: [
        { tenantId, name: 'E2E e2e-T29-firm', slug: 'e2e-T29-firm', role: 'admin' },
      ],
    });

    await page.goto(`/subject-tenants/${subjectId}`);
    await expect(page.getByText('e2e-T29-claimant')).toBeVisible();

    // Paste a sentence with no R&D / time / expenditure / associate vocabulary
    // → falls through stub rules to SUPPORTING@0.50.
    await page
      .getByLabel(/Paste a transcript or note/i)
      .fill('Random unrelated sentence with no R&D vocabulary.');
    await page.getByRole('button', { name: /^Classify$/i }).click();

    // Confirm the classified event landed (default tab is "All")
    await expect(page.getByText('SUPPORTING')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/50% \(review\)/i)).toBeVisible();

    // "Needs Review" tab → still visible
    await page.getByRole('tab', { name: /Needs Review/i }).click();
    await expect(page.getByText('SUPPORTING')).toBeVisible({ timeout: 5_000 });

    // "All" tab → visible
    await page.getByRole('tab', { name: /^All/i }).click();
    await expect(page.getByText('SUPPORTING')).toBeVisible();

    // "Ineligible" tab → empty (event has effective_kind SUPPORTING, not INELIGIBLE)
    await page.getByRole('tab', { name: /^Ineligible/i }).click();
    await expect(page.getByText(/No events yet/i)).toBeVisible({ timeout: 5_000 });

    // "Overrides" tab → empty (event is a paste, not an OVERRIDE)
    await page.getByRole('tab', { name: /^Overrides/i }).click();
    await expect(page.getByText(/No events yet/i)).toBeVisible({ timeout: 5_000 });
  });
});
