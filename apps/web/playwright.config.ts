import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the cpa-platform consultant portal e2e suite.
 *
 * - Chromium-only (per W5 design Q1; AU consultancy users are on Chrome/Edge)
 * - Serialized workers (workers: 1, fullyParallel: false) — the shared dev DB
 *   makes parallel test runs collide on RLS GUC + cleanup
 * - webServer auto-starts pnpm dev for both API (3000) and web (5173); reuses
 *   existing server in dev for fast iteration
 * - traces + screenshots only on failure to keep artefact volume small
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter @cpa/api dev',
      url: 'http://localhost:3000/healthz',
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @cpa/web dev',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env['CI'],
      timeout: 90_000,
    },
  ],
});
