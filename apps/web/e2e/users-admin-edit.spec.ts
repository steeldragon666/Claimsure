import { expect, test } from '@playwright/test';
import { signInAs } from './fixtures/auth';
import {
  cleanupByEmailPrefix,
  cleanupBySlugPrefix,
  seedMembership,
  seedTenant,
  seedUser,
} from './fixtures/test-data';

test.describe('Users admin edit', () => {
  test.afterAll(async () => {
    await cleanupBySlugPrefix('e2e-T10-');
    await cleanupByEmailPrefix('e2e-T10-');
  });

  test('admin demotes consultant to viewer; success', async ({ page, context }) => {
    const tenantId = await seedTenant('e2e-T10-firm-happy');
    const adminId = await seedUser('e2e-T10-admin@example.com', 'T10 Admin');
    const consultantId = await seedUser('e2e-T10-consultant@example.com', 'T10 Consultant');
    await seedMembership(tenantId, adminId, 'admin', true);
    await seedMembership(tenantId, consultantId, 'consultant', false);

    await signInAs(context, {
      id: adminId,
      email: 'e2e-T10-admin@example.com',
      primaryIdp: 'microsoft',
      activeTenantId: tenantId,
      activeRole: 'admin',
      availableTenants: [
        { tenantId, name: 'E2E e2e-T10-firm-happy', slug: 'e2e-T10-firm-happy', role: 'admin' },
      ],
    });

    await page.goto(`/users/${consultantId}`);
    await expect(page.getByRole('heading', { name: /Edit firm member/i })).toBeVisible();

    // Change role to viewer
    await page.getByLabel(/Role/i).click();
    await page.getByRole('option', { name: /Viewer/i }).click();

    // Save
    await page.getByRole('button', { name: /Save changes/i }).click();

    // Expect navigation to /users
    await page.waitForURL('**/users', { timeout: 10_000 });
  });

  test('admin (sole) tries to demote self → 409 toast surfaces', async ({ page, context }) => {
    const tenantId = await seedTenant('e2e-T10-firm-soloadmin');
    const adminId = await seedUser('e2e-T10-soloadmin@example.com', 'T10 Solo Admin');
    await seedMembership(tenantId, adminId, 'admin', true);

    await signInAs(context, {
      id: adminId,
      email: 'e2e-T10-soloadmin@example.com',
      primaryIdp: 'microsoft',
      activeTenantId: tenantId,
      activeRole: 'admin',
      availableTenants: [
        {
          tenantId,
          name: 'E2E e2e-T10-firm-soloadmin',
          slug: 'e2e-T10-firm-soloadmin',
          role: 'admin',
        },
      ],
    });

    await page.goto(`/users/${adminId}`);
    await page.getByLabel(/Role/i).click();
    await page.getByRole('option', { name: /Consultant/i }).click();
    await page.getByRole('button', { name: /Save changes/i }).click();

    // Expect 409 toast — should not redirect.
    //
    // Radix Toast renders the description twice: the visible
    // ToastDescription div AND a hidden <span role="status"> notification
    // sentinel (so SR announces title+description as one utterance).
    // getByText matches both, so we use exact-text matching on the visible
    // description (the sentinel concatenates "Notification" + title +
    // description into one string, which doesn't match exact).
    await expect(
      page.getByText('Cannot demote the only firm admin. Promote another user first.', {
        exact: true,
      }),
    ).toBeVisible({ timeout: 5_000 });
  });
});
