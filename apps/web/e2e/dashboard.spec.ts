import { expect, test } from '@playwright/test';
import { signInAs } from './fixtures/auth';
import {
  cleanupByEmailPrefix,
  cleanupBySlugPrefix,
  seedMembership,
  seedTenant,
  seedUser,
} from './fixtures/test-data';

test.describe('Dashboard', () => {
  test.afterAll(async () => {
    await cleanupBySlugPrefix('e2e-T6-');
    await cleanupByEmailPrefix('e2e-T6-');
  });

  test('admin sees own email + active firm name + role badge', async ({ page, context }) => {
    const tenantId = await seedTenant('e2e-T6-firm-alpha', 'E2E T6 Firm Alpha');
    const userId = await seedUser('e2e-T6-admin@example.com', 'T6 Admin');
    await seedMembership(tenantId, userId, 'admin', true);

    await signInAs(context, {
      id: userId,
      email: 'e2e-T6-admin@example.com',
      primaryIdp: 'microsoft',
      activeTenantId: tenantId,
      activeRole: 'admin',
      availableTenants: [
        {
          tenantId,
          name: 'E2E T6 Firm Alpha',
          slug: 'e2e-T6-firm-alpha',
          role: 'admin',
        },
      ],
    });

    await page.goto('/');
    await expect(page.getByText('e2e-T6-admin@example.com')).toBeVisible();
    await expect(page.getByText('E2E T6 Firm Alpha')).toBeVisible();
    await expect(page.getByRole('link', { name: /Manage firm members/i })).toBeVisible();
  });
});
