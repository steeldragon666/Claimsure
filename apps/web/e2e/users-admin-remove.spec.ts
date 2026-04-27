import { expect, test } from '@playwright/test';
import { signInAs } from './fixtures/auth';
import {
  cleanupByEmailPrefix,
  cleanupBySlugPrefix,
  seedMembership,
  seedTenant,
  seedUser,
} from './fixtures/test-data';

test.describe('Users admin remove', () => {
  test.afterAll(async () => {
    await cleanupBySlugPrefix('e2e-T11-');
    await cleanupByEmailPrefix('e2e-T11-');
  });

  test('admin removes consultant via Dialog confirm; success', async ({ page, context }) => {
    const tenantId = await seedTenant('e2e-T11-firm-happy');
    const adminId = await seedUser('e2e-T11-admin@example.com', 'T11 Admin');
    const consultantId = await seedUser('e2e-T11-consultant@example.com', 'T11 Consultant');
    await seedMembership(tenantId, adminId, 'admin', true);
    await seedMembership(tenantId, consultantId, 'consultant', false);

    await signInAs(context, {
      id: adminId,
      email: 'e2e-T11-admin@example.com',
      primaryIdp: 'microsoft',
      activeTenantId: tenantId,
      activeRole: 'admin',
      availableTenants: [
        { tenantId, name: 'E2E e2e-T11-firm-happy', slug: 'e2e-T11-firm-happy', role: 'admin' },
      ],
    });

    await page.goto(`/users/${consultantId}`);

    // Click "Remove from firm" trigger (destructive Button)
    await page.getByRole('button', { name: /Remove from firm/i }).click();

    // Dialog opens; click the Remove confirm
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: /^Remove$/i }).click();

    // Expect navigation back to /users
    await page.waitForURL('**/users', { timeout: 10_000 });
  });

  test('admin (sole) tries to remove self → 409 toast surfaces', async ({ page, context }) => {
    const tenantId = await seedTenant('e2e-T11-firm-soloadmin');
    const adminId = await seedUser('e2e-T11-soloadmin@example.com', 'T11 Solo Admin');
    await seedMembership(tenantId, adminId, 'admin', true);

    await signInAs(context, {
      id: adminId,
      email: 'e2e-T11-soloadmin@example.com',
      primaryIdp: 'microsoft',
      activeTenantId: tenantId,
      activeRole: 'admin',
      availableTenants: [
        {
          tenantId,
          name: 'E2E e2e-T11-firm-soloadmin',
          slug: 'e2e-T11-firm-soloadmin',
          role: 'admin',
        },
      ],
    });

    await page.goto(`/users/${adminId}`);
    await page.getByRole('button', { name: /Remove from firm/i }).click();
    await page.getByRole('button', { name: /^Remove$/i }).click();

    // Expect 409 toast — no redirect.
    //
    // Radix Toast renders the description twice: the visible
    // ToastDescription div AND a hidden <span role="status"> notification
    // sentinel (so SR announces title+description as one utterance).
    // Using exact match scopes to the visible div (the sentinel
    // concatenates "Notification" + title + description into one string).
    await expect(
      page.getByText('Cannot remove the only firm admin. Promote another user first.', {
        exact: true,
      }),
    ).toBeVisible({ timeout: 5_000 });
  });
});
