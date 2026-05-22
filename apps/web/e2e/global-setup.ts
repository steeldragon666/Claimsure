import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { request as playwrightRequest } from '@playwright/test';

/**
 * Playwright globalSetup — loads the repo-root `.env` into process.env
 * before any test (or test-file import) runs, then pre-warms the Next.js
 * routes the wizard suite visits so cold-compile latency doesn't blow
 * per-test timeouts.
 *
 * Why .env load: from a cold shell (no env vars exported), `playwright test`
 * imports `@cpa/db/client` transitively via the e2e fixtures, which reads
 * DATABASE_URL at module-eval time. Without this hook the runner falls
 * back to the dev-fallback URL in `packages/db/src/env.ts` and hits
 * ECONNREFUSED 127.0.0.1:5433. Loading `.env` here makes the suite
 * reproducible from a fresh terminal without manual `export` dances.
 *
 * Uses Node 22's built-in `process.loadEnvFile()` rather than the
 * `dotenv` package — repo `engines.node` is already `>=22.0.0` and
 * dotenv isn't a declared `apps/web` dep.
 *
 * Why pre-warm: `next dev` compiles routes on first request. Observed
 * cold compiles take 90-256s, which blows past Playwright's 30s default
 * test timeout. Hitting the routes here forces Next to compile them
 * before any test starts; subsequent in-test requests then resolve in
 * <1s. Wrapped in try/catch — if the dev server isn't ready or returns
 * 4xx/5xx, we don't fail globalSetup; the tests themselves will surface
 * any real outage.
 */
// __dirname is not defined in ESM; derive it from import.meta.url so this
// works whether Playwright's loader treats the file as CJS or ESM.
const here =
  typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));

export default async function globalSetup(): Promise<void> {
  // Playwright runs from apps/web; repo root is two levels up from e2e/.
  const envPath = path.resolve(here, '../../../.env');
  if (fs.existsSync(envPath)) {
    try {
      process.loadEnvFile(envPath);
    } catch {
      // Don't block test startup if .env is malformed — the user's
      // shell-exported vars (if any) will still apply.
    }
  }

  // Pre-warm wizard-suite routes so Next.js compiles them before tests
  // start. The claim detail route uses a [claim_id] dynamic segment;
  // any valid-shape UUID is enough to trigger compilation (the page
  // will 4xx for a non-existent claim, but the route compiles either
  // way).
  try {
    const context = await playwrightRequest.newContext({
      baseURL: 'http://localhost:5173',
    });
    await Promise.all([
      context.get('/').catch(() => {}),
      context.get('/login').catch(() => {}),
      context.get('/pipeline').catch(() => {}),
      context.get('/claims/00000000-0000-0000-0000-000000000000').catch(() => {}),
      context.get('/consultant').catch(() => {}),
    ]);
    await context.dispose();
  } catch {
    // Dev server not up yet, or @playwright/test request API misbehaved.
    // Tests will trigger their own compiles — slower, but not a hard
    // failure here.
  }
}
