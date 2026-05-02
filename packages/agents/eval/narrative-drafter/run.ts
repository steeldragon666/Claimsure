/**
 * Per-agent eval driver for Agent C (narrative drafter).
 *
 * Drives the streaming orchestrator end-to-end, accumulates each
 * `segment` event into a `Record<SectionKind, NarrativeSegment[]>`,
 * and scores the post-stream tree via `validateNarrativeStructure`.
 *
 * The score function is a binary structural pass/fail (`valid` from the
 * validator) plus an additional check that every requested
 * `target_section_kinds` actually has segments. Score is the fraction
 * of structural reasons that came back clean.
 *
 * This eval is the only one that consumes a streaming generator; the
 * other two agent factories are direct call/await. We use
 * AbortController only to satisfy the orchestrator's signature; the
 * eval has no abort path.
 */

import { fileURLToPath } from 'node:url';

import { streamNarrativeDraft } from '../../src/narrative-drafter/stream.js';
import type { StreamNarrativeDraftInput } from '../../src/narrative-drafter/stream.js';
import type { SectionKind } from '../../src/narrative-drafter/types.js';
import type { NarrativeSegment } from '../../src/narrative-drafter/validate.js';
import { runEval } from '../run.js';
import { validateNarrativeStructure } from '../scoring.js';

if (process.env.EVAL_ANTHROPIC_API_KEY) {
  process.env.ANTHROPIC_API_KEY = process.env.EVAL_ANTHROPIC_API_KEY;
}

// In the golden file we serialise the input WITHOUT the abortSignal
// (signals don't survive JSON round-trips); the runner injects a fresh
// one before invoking the orchestrator.
type GoldenInput = Omit<StreamNarrativeDraftInput, 'abortSignal'>;
type Expected = {
  expected_section_kinds_present: SectionKind[];
  expected_min_claim_count_per_section: number;
};

type DraftOutput = {
  sections: Record<SectionKind, NarrativeSegment[]>;
  validation_downgraded_count: number;
  total_segments: number;
  total_claims: number;
  errored: boolean;
  error_reason: string | null;
};

async function runOne(input: GoldenInput): Promise<DraftOutput> {
  const controller = new AbortController();
  const sections: Record<SectionKind, NarrativeSegment[]> = {
    new_knowledge: [],
    hypothesis: [],
    uncertainty: [],
    experiments_and_results: [],
  };

  let downgraded = 0;
  let totalSegments = 0;
  let totalClaims = 0;
  let errored = false;
  let errorReason: string | null = null;

  for await (const event of streamNarrativeDraft({ ...input, abortSignal: controller.signal })) {
    if (event.type === 'segment') {
      const buf = sections[event.section_kind] ?? [];
      buf.push(event.segment);
      sections[event.section_kind] = buf;
    } else if (event.type === 'done') {
      downgraded = event.validation_downgraded_count;
      totalSegments = event.total_segments;
      totalClaims = event.total_claims;
    } else if (event.type === 'error') {
      errored = true;
      errorReason = event.reason;
    }
  }

  return {
    sections,
    validation_downgraded_count: downgraded,
    total_segments: totalSegments,
    total_claims: totalClaims,
    errored,
    error_reason: errorReason,
  };
}

const summary = await runEval<GoldenInput, DraftOutput, Expected>({
  agentName: 'narrative-drafter',
  goldenPath: fileURLToPath(new URL('./golden.ndjson', import.meta.url)),
  runOne,
  score: (output, expected, input) => {
    if (output.errored) {
      return Promise.resolve({
        score: 0,
        passed: false,
        details: { errored: true, error_reason: output.error_reason },
      });
    }

    const clusteredEventIds = new Set(input.clustered_events.map((e) => e.id));
    const validation = validateNarrativeStructure(
      output.sections,
      clusteredEventIds,
      expected.expected_min_claim_count_per_section,
    );

    const sectionsPresent = expected.expected_section_kinds_present.filter(
      (k) => (output.sections[k] ?? []).length > 0,
    );
    const sectionsPresentRatio =
      expected.expected_section_kinds_present.length === 0
        ? 1
        : sectionsPresent.length / expected.expected_section_kinds_present.length;

    const score = (Number(validation.valid) + sectionsPresentRatio) / 2;
    const passed = validation.valid && sectionsPresentRatio === 1;
    return Promise.resolve({
      score,
      passed,
      details: {
        validation_reasons: validation.reasons,
        sections_present: sectionsPresent,
        sections_present_ratio: sectionsPresentRatio,
        total_segments: output.total_segments,
        total_claims: output.total_claims,
        validation_downgraded_count: output.validation_downgraded_count,
      },
    });
  },
});

process.stderr.write(
  `\nnarrative-drafter eval: ${summary.passed}/${summary.totalCases} passed (mean score ${summary.meanScore.toFixed(2)})\n`,
);
process.exit(summary.failed > 0 ? 1 : 0);
