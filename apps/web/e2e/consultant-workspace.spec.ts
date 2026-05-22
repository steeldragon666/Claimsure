import { expect, test } from '@playwright/test';

/**
 * /consultant — the v6 broadcast workspace (TopBar + Sidebar + view router).
 *
 * The page is purely presentational with hardcoded fixture data, so the
 * test is a UI smoke pass: every distinct view renders without console
 * errors and shows the expected brand markers when its sidebar nav item
 * is clicked. Beta-gate is bypassed in NODE_ENV=development; production
 * cookies are not required.
 */

test.describe('Consultant broadcast workspace (/consultant)', () => {
  test.beforeEach(async ({ page }) => {
    // Surface any uncaught client-side errors so the assertions below
    // catch broken views instead of silently passing.
    page.on('pageerror', (err) => {
      throw new Error(`Client error on /consultant: ${err.message}`);
    });
    await page.goto('/consultant');
  });

  test('Dashboard renders by default with KPIs + Active claims + Watch + Chain', async ({
    page,
  }) => {
    // Brand header
    await expect(page.getByText('ClaimSure').first()).toBeVisible();
    await expect(page.getByText('Good morning, Anna.')).toBeVisible();
    // KPI tiles
    await expect(page.getByText('ACTIVE CLAIMS')).toBeVisible();
    await expect(page.getByText('EVIDENCE INDEXED')).toBeVisible();
    await expect(page.getByText('CHAIN COVERAGE')).toBeVisible();
    // Claims panel rows
    await expect(page.getByText('Vantage Industries')).toBeVisible();
    await expect(page.getByText('VANT-7').first()).toBeVisible();
    // Watch panel
    await expect(page.getByText('TODAY · 3 SIGNALS')).toBeVisible();
    // Chain panel
    await expect(page.getByText('Recent chain blocks')).toBeVisible();
  });

  test('Sidebar — clicking Active claim swaps to the Wizard view', async ({ page }) => {
    await page.getByRole('button', { name: /Active claim/ }).click();
    // Wizard-specific markers
    await expect(page.getByText('Hi-temp alloy phase-stability program')).toBeVisible();
    await expect(page.getByText(/STEP 04 · APPORTIONMENT/)).toBeVisible();
    await expect(page.getByText('How does the ledger map to the activities?')).toBeVisible();
    await expect(page.getByText('Evidence stream')).toBeVisible();
    // Ledger row that has the SUGGEST chip
    await expect(page.getByText(/SUGGEST: CORE · Vantage-7/)).toBeVisible();
  });

  test('Sidebar — clicking Watch swaps to the daily signal-scan view', async ({ page }) => {
    await page.getByRole('button', { name: /^Watch/ }).click();
    await expect(page.getByText('WATCH · DAILY SIGNAL SCAN')).toBeVisible();
    await expect(page.getByText(/Three signals ranked by/)).toBeVisible();
    // Table header
    await expect(page.getByText('SOURCE')).toBeVisible();
    await expect(page.getByText('REFERENCE')).toBeVisible();
    // Sample row
    await expect(page.getByText('TA 2026/03')).toBeVisible();
    await expect(page.getByText('[2026] AATA 412')).toBeVisible();
  });

  test('Sidebar — clicking Financing swaps to the July 1 waitlist card', async ({ page }) => {
    await page.getByRole('button', { name: /Financing/ }).click();
    await expect(page.getByText('FINANCING · BETA · FY26/27')).toBeVisible();
    await expect(page.getByText(/Claim financing arrives/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Join the waitlist/ })).toBeVisible();
  });

  test('TopBar LIVE timestamp ticks while the page is open', async ({ page }) => {
    const live = page.getByText(/LIVE · \d{2}:\d{2}:\d{2} AEST/);
    await expect(live).toBeVisible();
    const first = await live.textContent();
    // 1.5s is well past the 200ms tick interval but short enough not to
    // slow the suite.
    await page.waitForTimeout(1500);
    const second = await live.textContent();
    expect(second).not.toEqual(first);
  });

  test('Sidebar — chain-status footer shows the static block + AZ row', async ({ page }) => {
    await expect(page.getByText('#00184_3F')).toBeVisible();
    await expect(page.getByText('3,247')).toBeVisible();
    await expect(page.getByText('AZ-1 SYDNEY · AZ-2 MELB')).toBeVisible();
  });
});
