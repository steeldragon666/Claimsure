/**
 * P7 Theme D Task D.9 — CLI entry point for manual RIF scrape runs.
 *
 * Usage: npx tsx tools/scripts/scrape-regulatory.ts
 *
 * The daily automated run is registered via pg-boss in
 * apps/api/src/jobs/rif-daily-scrape.ts.
 */

import { runDailyScrape } from '@cpa/integrations/regulatory';

async function main(): Promise<void> {
  console.log('[scrape-regulatory] starting manual run...');
  const result = await runDailyScrape();
  console.log('[scrape-regulatory] done:', JSON.stringify(result, null, 2));
  process.exit(result.errors.length > 0 ? 1 : 0);
}

void main();
