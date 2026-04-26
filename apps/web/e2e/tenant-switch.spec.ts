import { expect, test } from '@playwright/test';
import { signInAs } from './fixtures/auth';
import {
  cleanupByEmailPrefix,
  cleanupBySlugPrefix,
  seedMembership,
  seedTenant,
  seedUser,
} from './fixtures/test-data';

test.describe('Tenant switcher', () => {
  test.afterAll(async () => {
    await cleanupBySlugPrefix('e2e-T7-');
    await cleanupByEmailPrefix('e2e-T7-');
  });

  test('clicking a tenant in the dropdown changes the active firm', async ({ page, context }) => {
    const tenantA = await seedTenant('e2e-T7-firm-alpha', 'E2E T7 Firm Alpha');
    const tenantB = await seedTenant('e2e-T7-firm-bravo', 'E2E T7 Firm Bravo');
    const userId = await seedUser('e2e-T7-multi@example.com', 'T7 Multi-firm');
    await seedMembership(tenantA, userId, 'admin', true);
    await seedMembership(tenantB, userId, 'consultant', false);

    await signInAs(context, {
      id: userId,
      email: 'e2e-T7-multi@example.com',
      primaryIdp: 'microsoft',
      activeTenantId: tenantA,
      activeRole: 'admin',
      availableTenants: [
        { tenantId: tenantA, name: 'E2E T7 Firm Alpha', slug: 'e2e-T7-firm-alpha', role: 'admin' },
        {
          tenantId: tenantB,
          name: 'E2E T7 Firm Bravo',
          slug: 'e2e-T7-firm-bravo',
          role: 'consultant',
        },
      ],
    });

    await page.goto('/');

    // Initial active firm: Alpha
    await expect(page.getByText('E2E T7 Firm Alpha')).toBeVisible();

    // Open dropdown via the switcher button
    await page.getByRole('button', { name: /E2E T7 Firm Alpha/i }).click();

    // Click Bravo in the dropdown
    await page.getByRole('menuitem', { name: /E2E T7 Firm Bravo/i }).click();

    // Wait for the dashboard to re-render with the new active firm name visible
    await expect(page.getByText('E2E T7 Firm Bravo')).toBeVisible({ timeout: 5_000 });
  });
});
