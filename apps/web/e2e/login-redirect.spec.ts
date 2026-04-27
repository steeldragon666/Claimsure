import { expect, test } from '@playwright/test';

test('anonymous user is redirected from / to /login', async ({ page }) => {
  await page.goto('/');
  await page.waitForURL('**/login', { timeout: 10_000 });
  // shadcn's CardTitle renders as <div>, not a heading element — assert by
  // text rather than role to keep the locator decoupled from the component
  // primitive (vendored, must not drift from upstream shadcn).
  await expect(page.getByText(/Sign in to CPA Platform/i)).toBeVisible();
  await expect(page.getByRole('link', { name: /Continue with Microsoft/i })).toBeVisible();
  await expect(page.getByRole('link', { name: /Continue with Google/i })).toBeVisible();
});
