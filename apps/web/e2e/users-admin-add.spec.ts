import { expect, test } from '@playwright/test';
import { signInAs } from './fixtures/auth';
import {
  cleanupByEmailPrefix,
  cleanupBySlugPrefix,
  seedMembership,
  seedTenant,
  seedUser,
} from './fixtures/test-data';

test.describe('Users admin add', () => {
  test.afterAll(async () => {
    await cleanupBySlugPrefix('e2e-T9-');
    await cleanupByEmailPrefix('e2e-T9-');
  });

  test('admin adds existing user by email; success toast + back to /users', async ({
    page,
    context,
  }) => {
    const tenantId = await seedTenant('e2e-T9-firm');
    const adminId = await seedUser('e2e-T9-admin@example.com', 'T9 Admin');
    // Seed a user that exists but is NOT yet a member of e2e-T9-firm
    await seedUser('e2e-T9-newcomer@example.com', 'T9 Newcomer');
    await seedMembership(tenantId, adminId, 'admin', true);

    await signInAs(context, {
      id: adminId,
      email: 'e2e-T9-admin@example.com',
      primaryIdp: 'microsoft',
      activeTenantId: tenantId,
      activeRole: 'admin',
      availableTenants: [{ tenantId, name: 'E2E e2e-T9-firm', slug: 'e2e-T9-firm', role: 'admin' }],
    });

    await page.goto('/users/new');
    await expect(page.getByRole('heading', { name: /Add firm member/i })).toBeVisible();

    // Fill the form
    await page.getByLabel(/Email/i).fill('e2e-T9-newcomer@example.com');

    // Role default is "consultant" — leave as-is

    // Submit
    await page.getByRole('button', { name: /^Add user$/i }).click();

    // Expect navigation back to /users
    await page.waitForURL('**/users', { timeout: 10_000 });

    // The newcomer should now appear in the list
    await expect(page.getByText('e2e-T9-newcomer@example.com')).toBeVisible({ timeout: 5_000 });
  });
});
