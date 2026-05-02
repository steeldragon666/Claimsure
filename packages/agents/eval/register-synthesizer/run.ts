/**
 * Per-agent eval driver for Agent B (register synthesizer).
 *
 * Reads `./golden.ndjson`, calls `makeRegisterSynthesizer().synthesize`
 * for each case, and scores the result on:
 *
 *   1. cluster count: must fall within
 *      [expected.min_proposed_activities, expected.max_proposed_activities].
 *   2. per-expected-cluster Jaccard: each `expected_clusters[i]` is
 *      matched against the BEST-OVERLAP cluster the synthesizer
 *      produced; that cluster's Jaccard score must meet
 *      `expected_clusters[i].min_jaccard` and (if set) carry the
 *      expected statutory anchor.
 *
 * The score is the mean of (count_ok ? 1 : 0) and the average best-Jaccard
 * across expected clusters. We do NOT match on proposed_id because the
 * synthesizer mints fresh UUIDs each run — clusters are matched by
 * event-set overlap.
 */

import { fileURLToPath } from 'node:url';

import { makeRegisterSynthesizer } from '../../src/synthesizer-register/index.js';
import type {
  SynthesizerInput,
  SynthesizerOutput,
  ActivityStatutoryAnchor,
} from '../../src/synthesizer-register/index.js';
import { runEval } from '../run.js';
import { jaccardSimilarity } from '../scoring.js';

if (process.env.EVAL_ANTHROPIC_API_KEY) {
  process.env.ANTHROPIC_API_KEY = process.env.EVAL_ANTHROPIC_API_KEY;
}

type ExpectedCluster = {
  event_ids: string[];
  min_jaccard: number;
  expected_anchor?: ActivityStatutoryAnchor;
};
type Expected = {
  min_proposed_activities: number;
  max_proposed_activities: number;
  expected_clusters: ExpectedCluster[];
};

const synthesizer = makeRegisterSynthesizer();

const summary = await runEval<SynthesizerInput, SynthesizerOutput, Expected>({
  agentName: 'register-synthesizer',
  goldenPath: fileURLToPath(new URL('./golden.ndjson', import.meta.url)),
  runOne: (input) => synthesizer.synthesize(input),
  score: (output, expected) => {
    const count = output.proposed_activities.length;
    const countOk =
      count >= expected.min_proposed_activities && count <= expected.max_proposed_activities;

    const clusterDetails: Array<{
      expected_event_ids: string[];
      best_jaccard: number;
      anchor_ok: boolean;
      passed: boolean;
    }> = [];

    let jaccardSum = 0;
    for (const ec of expected.expected_clusters) {
      const expectedSet = new Set(ec.event_ids);
      let bestJaccard = 0;
      let bestAnchorOk = false;
      for (const proposed of output.proposed_activities) {
        const proposedSet = new Set(proposed.clustered_event_ids);
        const j = jaccardSimilarity(expectedSet, proposedSet);
        if (j > bestJaccard) {
          bestJaccard = j;
          bestAnchorOk =
            ec.expected_anchor === undefined || proposed.statutory_anchor === ec.expected_anchor;
        }
      }
      jaccardSum += bestJaccard;
      clusterDetails.push({
        expected_event_ids: ec.event_ids,
        best_jaccard: bestJaccard,
        anchor_ok: bestAnchorOk,
        passed: bestJaccard >= ec.min_jaccard && bestAnchorOk,
      });
    }

    const meanJaccard =
      expected.expected_clusters.length === 0 ? 1 : jaccardSum / expected.expected_clusters.length;

    const score = ((countOk ? 1 : 0) + meanJaccard) / 2;
    const allClustersOk = clusterDetails.every((c) => c.passed);
    const passed = countOk && allClustersOk;

    return Promise.resolve({
      score,
      passed,
      details: {
        proposed_activity_count: count,
        count_ok: countOk,
        mean_jaccard: meanJaccard,
        clusters: clusterDetails,
      },
    });
  },
});

process.stderr.write(
  `\nregister-synthesizer eval: ${summary.passed}/${summary.totalCases} passed (mean score ${summary.meanScore.toFixed(2)})\n`,
);
process.exit(summary.failed > 0 ? 1 : 0);
