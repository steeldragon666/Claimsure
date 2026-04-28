import crypto from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signInAs } from './fixtures/auth';
import {
  cleanupByEmailPrefix,
  cleanupBySlugPrefix,
  cleanupSubjectTenantsByNamePrefix,
  seedMembership,
  seedTenant,
  seedUser,
} from './fixtures/test-data';

/**
 * T27 — /subject-tenants list view + create-claimant modal.
 *
 * Happy path: admin sees the "Claimants" header, clicks Create claimant,
 * fills the modal, submits, and lands on the new detail page (UUID URL).
 *
 * Header text is asserted via getByText (not getByRole('heading')) because
 * the surrounding shadcn-CardTitle-as-`<div>` pitfall (P1) means
 * heading-role queries can fall over depending on the wrapper element.
 */
test.describe('Subject tenants list', () => {
  test.afterAll(async () => {
    await cleanupSubjectTenantsByNamePrefix('e2e-T27-');
    await cleanupBySlugPrefix('e2e-T27-');
    await cleanupByEmailPrefix('e2e-T27-');
  });

  test('admin lists claimants and creates a new one', async ({ page, context }) => {
    const tenantId = await seedTenant('e2e-T27-firm');
    const adminId = await seedUser('e2e-T27-admin@example.com', 'T27 Admin');
    await seedMembership(tenantId, adminId, 'admin', true);

    await signInAs(context, {
      id: adminId,
      email: 'e2e-T27-admin@example.com',
      primaryIdp: 'microsoft',
      activeTenantId: tenantId,
      activeRole: 'admin',
      availableTenants: [
        { tenantId, name: 'E2E e2e-T27-firm', slug: 'e2e-T27-firm', role: 'admin' },
      ],
    });

    await page.goto('/subject-tenants');

    // Page header
    await expect(page.getByText('Claimants').first()).toBeVisible();

    // Create CTA opens the modal
    await page.getByRole('button', { name: /^Create claimant$/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    // Fill name (kind defaults to claimant)
    const claimantName = `e2e-T27-claimant-${crypto.randomUUID().slice(0, 8)}`;
    await page.getByLabel(/^Name$/i).fill(claimantName);

    // Submit
    await page.getByRole('button', { name: /^Create$/i }).click();

    // On success the modal closes and the router pushes to /subject-tenants/<uuid>
    await page.waitForURL(/\/subject-tenants\/[0-9a-f-]{36}$/i, { timeout: 10_000 });

    // The new claimant's name should be visible in the detail header.
    // Use `getByRole('heading', ...)` because the post-create toast renders
    // the same name in two additional elements ('Claimant "..." created'
    // visible div + the aria-live status span), and `getByText` substring
    // match would hit all three → strict-mode violation.
    await expect(page.getByRole('heading', { name: claimantName })).toBeVisible({ timeout: 5_000 });
  });
});
