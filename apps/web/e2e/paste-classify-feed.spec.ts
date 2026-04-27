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
 * T28 — paste a transcript, classify, see it land in the feed.
 *
 * Uses a HYPOTHESIS-triggering input ("We hypothesised the catalyst would
 * last 200 hours.") chosen to match the stub classifier's hypothesis rule
 * deterministically (packages/agents/src/classifier/stub.ts: confidence
 * 0.85, anchor §355-25(1)(a)). CI sets CLASSIFIER_IMPL=stub so this is
 * stable run-to-run.
 *
 * Header text uses getByText (not getByRole('heading')) per the
 * shadcn-CardTitle-as-`<div>` pitfall noted in P1 e2e specs.
 */
test.describe('Paste → classify → feed', () => {
  test.afterAll(async () => {
    await cleanupSubjectTenantsByNamePrefix('e2e-T28-');
    await cleanupBySlugPrefix('e2e-T28-');
    await cleanupByEmailPrefix('e2e-T28-');
  });

  test('hypothesis paste classifies and appears in the feed', async ({ page, context }) => {
    const tenantId = await seedTenant('e2e-T28-firm');
    const adminId = await seedUser('e2e-T28-admin@example.com', 'T28 Admin');
    await seedMembership(tenantId, adminId, 'admin', true);
    const subjectId = await seedSubjectTenant(tenantId, 'e2e-T28-claimant');

    await signInAs(context, {
      id: adminId,
      email: 'e2e-T28-admin@example.com',
      primaryIdp: 'microsoft',
      activeTenantId: tenantId,
      activeRole: 'admin',
      availableTenants: [
        { tenantId, name: 'E2E e2e-T28-firm', slug: 'e2e-T28-firm', role: 'admin' },
      ],
    });

    await page.goto(`/subject-tenants/${subjectId}`);

    // Detail header is up
    await expect(page.getByText('e2e-T28-claimant')).toBeVisible();

    // Empty chain → verified=true ("Verified (0 events)")
    await expect(page.getByText(/Verified \(/i)).toBeVisible({ timeout: 5_000 });

    // Paste a hypothesis-triggering line
    await page
      .getByLabel(/Paste a transcript or note/i)
      .fill('We hypothesised the catalyst would last 200 hours.');

    // Classify
    await page.getByRole('button', { name: /^Classify$/i }).click();

    // Event card with HYPOTHESIS kind chip + 85% confidence + statutory anchor
    await expect(page.getByText('HYPOTHESIS')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('85%')).toBeVisible();
    await expect(page.getByText('§355-25(1)(a)')).toBeVisible();
  });
});
