#!/usr/bin/env tsx
/**
 * Smoke-test `draft-narrative@1.2.0` (portal-fields) end-to-end against
 * Anthropic without touching the API/DB. Useful to verify:
 *
 *   1. The prompt module loads and registers cleanly.
 *   2. Anthropic returns a `tool_use` block named `emit_portal_fields`.
 *   3. The tool input passes `emitPortalFieldsToolSchema` (discriminated
 *      on `activity_kind`, so the 13 core / 9 supporting fields and all
 *      per-field char limits are enforced).
 *
 * Why a one-shot script: the v1.2.0 prompt is registered but NOT wired
 * into any API route or job yet — the production `/v1/narrative` route
 * hardcodes `draft-narrative@1.0.0`. This script is the fastest way to
 * exercise v1.2.0 with a real LLM round-trip until wiring lands.
 *
 * Schema-shape note: `emitPortalFieldsToolSchema` is a
 * `z.discriminatedUnion`, which the minimal converter in
 * `packages/agents/src/runtime/tool-use.ts` does not support. We follow
 * the same workaround as `narrative-drafter/stream.ts` — declare a
 * permissive `additionalProperties: true` schema to Anthropic and rely
 * on the post-call Zod parse as the authoritative shape check.
 *
 * Usage:
 *   pnpm exec tsx --env-file-if-exists=../../.env \
 *     tools/scripts/test-portal-fields.ts [--kind core|supporting] [--model X]
 *
 * Flags:
 *   --kind         core (default) | supporting
 *   --model        Anthropic model override (default: claude-sonnet-4-5)
 *   --max-tokens   max output tokens (default: 8000)
 *
 * Requires ANTHROPIC_API_KEY in .env or the shell environment.
 */

// MUST be first import — force-load .env values, overriding any
// shell-leaked empty placeholders (notably ANTHROPIC_API_KEY="" from
// Claude Desktop / MCP runtimes on Windows).
import '../../apps/api/src/force-env.js';

import Anthropic from '@anthropic-ai/sdk';
import { getPrompt } from '../../packages/agents/src/runtime/prompt-registry.js';
import { callWithToolUse } from '../../packages/agents/src/runtime/tool-use.js';
import type { ToolDef } from '../../packages/agents/src/runtime/types.js';
// Side-effect import: registers `draft-narrative@1.2.0` in the prompt registry.
import type { EmitPortalFieldsToolInput } from '../../packages/agents/src/narrative-drafter/prompts/draft-narrative@1.2.0.js';
import '../../packages/agents/src/narrative-drafter/prompts/draft-narrative@1.2.0.js';

// ---------------------------------------------------------------------------
// CLI flag parsing
// ---------------------------------------------------------------------------

function parseFlags(argv: string[]): {
  kind: 'core' | 'supporting';
  model: string;
  maxTokens: number;
} {
  let kind: 'core' | 'supporting' = 'core';
  let model = process.env['NARRATIVE_DRAFTER_MODEL'] ?? 'claude-sonnet-4-5';
  let maxTokens = 8000;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--kind') {
      const v = argv[++i];
      if (v !== 'core' && v !== 'supporting') {
        throw new Error(`--kind must be 'core' or 'supporting', got '${v ?? '(missing)'}'`);
      }
      kind = v;
    } else if (a === '--model') {
      const v = argv[++i];
      if (!v) throw new Error('--model requires a value');
      model = v;
    } else if (a === '--max-tokens') {
      const v = argv[++i];
      const n = Number(v);
      if (!Number.isFinite(n) || n < 100) throw new Error(`--max-tokens must be >=100, got '${v}'`);
      maxTokens = n;
    } else if (a === '--help' || a === '-h') {
      console.log(
        [
          'Usage: tsx tools/scripts/test-portal-fields.ts [flags]',
          '  --kind core|supporting   (default: core)',
          '  --model <id>             (default: claude-sonnet-4-5)',
          '  --max-tokens <n>         (default: 8000)',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown flag: ${a}`);
    }
  }

  return { kind, model, maxTokens };
}

// ---------------------------------------------------------------------------
// Mock activity + clustered events (deterministic, no DB)
// ---------------------------------------------------------------------------

const CORE_ACTIVITY_FIXTURE = {
  activity: {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Adaptive bias-correction for satellite-derived crop NDVI under cloud-edge contamination',
    kind: 'core' as const,
    statutory_anchor: 's.355-25' as const,
    project_id: '22222222-2222-4222-8222-222222222222',
  },
  project: {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'AgriSense FY26 — remote-sensing crop telemetry',
    industry_sector: 'Agriculture, Forestry & Fishing',
    fiscal_year: 2026,
  },
  proposed_hypothesis:
    'A cloud-edge contamination index (CECI) derived from per-pixel BRDF residuals can recover unbiased NDVI for pixels within 1.5km of cloud edges, restoring usable observations from ~38% of currently-discarded Sentinel-2 scenes over north-east Australian wheat regions.',
  proposed_uncertainty:
    'Existing literature treats cloud-adjacent pixels as binary (mask or keep); no published technique yields a continuous correction factor validated against ground-truth NDVI in the cloud-edge zone. The team could not predict whether residual atmospheric scattering would dominate over BRDF effects for the FY26 sensor configuration.',
  clustered_events: [
    {
      id: '33333333-3333-4333-8333-333333333301',
      kind: 'literature_review',
      captured_at: '2025-08-12T02:14:00Z',
      body: 'Reviewed Hagolle et al. (2010) MACCS and Frantz et al. (2018) FORCE-L2 atmospheric correction; both apply pixel-wise BRDF normalisation but mask the cloud-edge zone outright. Identified no published continuous correction in the 0-1.5km adjacency band.',
    },
    {
      id: '33333333-3333-4333-8333-333333333302',
      kind: 'expert_consultation',
      captured_at: '2025-08-19T05:30:00Z',
      body: 'Discussion with Prof. K. Lyapustin (NASA Goddard) confirmed no validated technique exists for the 0-1.5km band; suggested investigating the residual-after-MAIAC channel as a candidate predictor.',
    },
    {
      id: '33333333-3333-4333-8333-333333333303',
      kind: 'experiment_design',
      captured_at: '2025-09-04T00:00:00Z',
      body: 'Designed CECI = f(BRDF_residual, view_angle, cloud_adjacency_distance) trained on a matched-pair dataset: 2,400 pixel pairs where the same ground location is observed once cloud-adjacent and once cloud-free within a 5-day window. Train/test split: 80/20 by region.',
    },
    {
      id: '33333333-3333-4333-8333-333333333304',
      kind: 'experiment_log',
      captured_at: '2025-10-22T07:45:00Z',
      body: 'Trained gradient-boosted regressor on 1,920 training pairs (XGBoost, 500 trees, max_depth=4). Validation RMSE on NDVI correction = 0.041 (target was <0.05); R² = 0.78. Failed initially when feature set excluded view_angle — retrained with view_angle added, RMSE dropped from 0.062 to 0.041.',
    },
    {
      id: '33333333-3333-4333-8333-333333333305',
      kind: 'evaluation_log',
      captured_at: '2025-11-15T03:10:00Z',
      body: 'Independent test: compared CECI-corrected NDVI to ground-truth handheld spectrometer measurements at 18 sites in the Liverpool Plains across 6 cloud-edge events. Mean absolute error = 0.038, vs 0.107 for uncorrected pixels. Recovered 41% of previously-discarded scenes for the Sept-Oct 2025 growing window.',
    },
    {
      id: '33333333-3333-4333-8333-333333333306',
      kind: 'conclusion_log',
      captured_at: '2025-12-02T22:00:00Z',
      body: 'Hypothesis supported: continuous correction is feasible. New knowledge — first validated continuous CECI for Sentinel-2 cloud-edge pixels in temperate Australian cropping systems. Documented limitations: technique not yet validated for tropical north Queensland (different cloud morphology); supporting activity SA-01 to extend to that biome in FY27.',
    },
  ],
  expenditure_estimate_aud: 286000,
};

const SUPPORTING_ACTIVITY_FIXTURE = {
  activity: {
    id: '44444444-4444-4444-8444-444444444444',
    name: 'Field-spectrometer calibration tour for CECI ground-truth validation',
    kind: 'supporting' as const,
    statutory_anchor: 's.355-30' as const,
    project_id: '22222222-2222-4222-8222-222222222222',
  },
  project: {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'AgriSense FY26 — remote-sensing crop telemetry',
    industry_sector: 'Agriculture, Forestry & Fishing',
    fiscal_year: 2026,
  },
  supports_core_activity_ids: ['11111111-1111-4111-8111-111111111111'],
  proposed_dominant_purpose:
    'The dominant purpose of the spectrometer calibration tour is to generate the ground-truth NDVI measurements that the core CECI activity required for its independent test of the correction technique. Without paired ground/satellite observations at the 18 Liverpool Plains sites, the core experiment could not have been evaluated.',
  clustered_events: [
    {
      id: '55555555-5555-4555-8555-555555555501',
      kind: 'travel_plan',
      captured_at: '2025-09-10T01:00:00Z',
      body: 'Planned 9-day field tour, Liverpool Plains NSW, covering 18 wheat and chickpea sites. Scheduled to coincide with anticipated cloud-edge satellite passes (4 Sentinel-2 overpasses with high cloud-fragmentation probability).',
    },
    {
      id: '55555555-5555-4555-8555-555555555502',
      kind: 'equipment_log',
      captured_at: '2025-09-22T06:00:00Z',
      body: 'ASD FieldSpec 4 Hi-Res spectrometer calibrated against Spectralon white reference at start and end of each day; 312 paired ground-spectra captured in total. Equipment hire cost AUD 8,400; consumables AUD 1,150.',
    },
    {
      id: '55555555-5555-4555-8555-555555555503',
      kind: 'fieldwork_log',
      captured_at: '2025-10-04T05:30:00Z',
      body: 'Captured ground-truth NDVI at all 18 sites across 4 Sentinel-2 overpass windows. 24% of measurements re-collected at +30min and +60min offsets to characterise diurnal drift. All raw spectra archived in project Zenodo deposit (DOI registered).',
    },
  ],
  expenditure_estimate_aud: 42000,
  dates_conducted: { start: '2025-09-22', end: '2025-10-04' },
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { kind, model, maxTokens } = parseFlags(process.argv.slice(2));

  console.log(`portal-fields smoke-test`);
  console.log(`  kind         : ${kind}`);
  console.log(`  model        : ${model}`);
  console.log(`  max_tokens   : ${maxTokens}`);
  console.log('');

  // Side-effect of the v1.2.0 import above is the registry entry.
  const prompt = getPrompt('draft-narrative@1.2.0');
  console.log(`  prompt found : ${prompt.name}@${prompt.version}`);
  console.log(`  tool name    : ${prompt.tool.name}`);
  console.log(`  system chars : ${prompt.system.length}`);
  console.log('');

  const fixture = kind === 'core' ? CORE_ACTIVITY_FIXTURE : SUPPORTING_ACTIVITY_FIXTURE;
  const userPayload = {
    activity_kind: kind,
    ...fixture,
  };
  const userMessage = JSON.stringify(userPayload, null, 2);
  console.log(`  user msg     : ${userMessage.length} chars`);
  console.log('');

  // We build the client locally (rather than using the shared
  // getAnthropicClient singleton) so we can bump the timeout — Sonnet
  // generating 13 portal fields with 4000-char limits can take >30s.
  // The local client is passed into callWithToolUse, which handles
  // the JSON-Schema conversion (now ZodDiscriminatedUnion-aware) and
  // the post-call Zod parse.
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY required after force-env shim');
  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
  console.log('  → calling Anthropic via callWithToolUse (timeout 120s)…');
  const t0 = Date.now();

  const { output, tokens_in, tokens_out } = await callWithToolUse<EmitPortalFieldsToolInput>(
    client,
    {
      model,
      system: prompt.system,
      user: userMessage,
      // The prompt registry types `prompt.tool` as ToolDef<unknown> so any
      // prompt's tool can sit in the same registry slot. Narrow it to the
      // specific output shape we want callWithToolUse to validate against.
      tool: prompt.tool as unknown as ToolDef<EmitPortalFieldsToolInput>,
      max_tokens: maxTokens,
    },
  );

  const elapsedMs = Date.now() - t0;
  console.log(`  ← response in ${elapsedMs}ms`);
  console.log(`    tokens_in  = ${tokens_in}`);
  console.log(`    tokens_out = ${tokens_out}`);
  console.log('');

  console.log('  ✓ callWithToolUse parsed + Zod-validated the response');
  console.log('');
  console.log('=== validated portal_fields ===');
  console.log(JSON.stringify(output, null, 2));
}

main().catch((err: unknown) => {
  console.error('\nFATAL:', err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
