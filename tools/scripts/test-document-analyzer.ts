#!/usr/bin/env tsx
/**
 * Smoke-test the document-analyzer agent end-to-end against Anthropic.
 *
 * Exercises the same `callWithToolUse` path that production uses, so a
 * passing run validates: prompt registration, the JSON-Schema conversion
 * of the agent's Zod schema, the Anthropic round-trip, and the Zod parse
 * of the response.
 *
 * Usage:
 *   pnpm exec tsx test-document-analyzer.ts
 */

// MUST be first import — force-load .env values, overriding any
// shell-leaked empty placeholders (e.g. ANTHROPIC_API_KEY="" on Windows).
import '../../apps/api/src/force-env.js';

import { HaikuDocumentAnalyzer } from '../../packages/agents/src/document-analyzer/haiku.js';

const FIXTURE_RAW_TEXT = `
RESEARCH LOG — AgriSense FY26 Sprint 11
Date: 2025-10-22
Author: Dr. M. Tanaka (Senior Research Scientist)

Sprint goal: Determine whether a continuous bias-correction model can recover
unbiased NDVI for Sentinel-2 pixels within 1.5 km of cloud edges.

Hypothesis: A regression model with features (BRDF_residual, view_angle,
cloud_adjacency_distance) can predict the NDVI correction factor with RMSE
< 0.05 on a held-out validation set drawn from temperate Australian wheat
regions.

Technical uncertainty: Existing operational atmospheric correction systems
(MACCS, FORCE-L2) treat the cloud-edge zone as a binary mask. No published
technique provides a continuous correction in the 0-1.5km adjacency band
that has been validated against ground-truth NDVI in Australian cropping
systems. The relative contributions of residual atmospheric scattering vs.
BRDF residuals in this band have not been characterised for Sentinel-2.

Experimental results:
- XGBoost (500 trees, max_depth=4) trained on 1,920 paired pixel pairs.
- Initial feature set (BRDF_residual + cloud_adjacency_distance only): RMSE = 0.062
- Retrained with view_angle added: RMSE = 0.041, R² = 0.78 on 480 test pairs.
- Independent ground-truth at 18 Liverpool Plains sites: MAE 0.038 corrected
  vs. 0.107 uncorrected.

Vendor expenditure this sprint:
  - Cloudtech Spectral Systems Pty Ltd | 22 Oct 2025 | INV-2025-104
    Sentinel-2 imagery preprocessing services | line: BRDF normalization pass | $14,500.00 AUD
    GST $1,450.00 | Total $15,950.00
  - NSW Field Operations | 22 Oct 2025 | spectrometer hire week 3 | $4,200.00 AUD total

Conclusion (provisional): Continuous correction is feasible in this biome.
Next step: extend validation to tropical north Queensland (different cloud
morphology) — proposed for FY27.
`.trim();

async function main(): Promise<void> {
  console.log('document-analyzer smoke-test');
  console.log(`  model        : ${process.env['DOCUMENT_ANALYZER_MODEL'] ?? 'claude-haiku-4-5'}`);
  console.log(`  raw_text len : ${FIXTURE_RAW_TEXT.length} chars`);
  console.log('');

  const analyzer = new HaikuDocumentAnalyzer();

  console.log('  → calling analyze()…');
  const t0 = Date.now();
  const result = await analyzer.analyze({
    filename: 'research-log-sprint-11.md',
    mime_type: 'text/markdown',
    raw_text: FIXTURE_RAW_TEXT,
    existing_activities: [
      {
        code: 'CA-01',
        kind: 'core',
        title: 'Cloud-edge NDVI bias correction',
        hypothesis: 'A continuous correction model can recover NDVI within 1.5km of cloud edges.',
      },
    ],
  });
  const elapsedMs = Date.now() - t0;
  const output = result.output;

  console.log(`  ← analyze() returned in ${elapsedMs}ms`);
  console.log('');
  console.log('=== summary ===');
  console.log(`  activities       : ${output.activities.length}`);
  console.log(`  invoices         : ${output.invoices.length}`);
  console.log(`  document_summary : ${output.document_summary.length} chars`);
  if (result.usage) {
    console.log(
      `  usage            : ${result.usage.tokens_in} in / ${result.usage.tokens_out} out (${result.usage.model})`,
    );
  }
  console.log('');
  console.log('=== validated output ===');
  console.log(JSON.stringify(output, null, 2));
}

main().catch((err: unknown) => {
  console.error('\nFATAL:', err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
