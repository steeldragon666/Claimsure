/**
 * Per-agent eval driver for Agent A (expenditure classifier).
 *
 * Reads `./golden.ndjson`, calls `makeExpenditureClassifier().classify`
 * for each case, and scores the result on the (decision, statutory_anchor)
 * pair. The score is the average of two boolean checks (each ½) so a
 * case must match BOTH fields to score 1.0.
 *
 * Eligibility-probability is gated by an additional floor on the
 * `expected.min_eligibility_probability` — this catches cases where the
 * model picks the right enum but expresses suspiciously low confidence.
 *
 * Exit code is non-zero if any case failed, so the script can drop into
 * CI as a smoke check before merging prompt changes (see README for the
 * `pnpm eval:expenditure` invocation).
 */

import { fileURLToPath } from 'node:url';

import { makeExpenditureClassifier } from '../../src/classifier-expenditure/index.js';
import type {
  ExpenditureClassifierInput,
  ExpenditureClassifierOutput,
  ExpenditureDecision,
  ExpenditureStatutoryAnchor,
} from '../../src/classifier-expenditure/index.js';
import { runEval } from '../run.js';
import { categoryAccuracy } from '../scoring.js';

// Honor the eval-only API key, mirroring the convention used by all
// per-agent runners. The key may be different from the production
// runtime key (e.g., a sandboxed key tied to an evals project).
if (process.env.EVAL_ANTHROPIC_API_KEY) {
  process.env.ANTHROPIC_API_KEY = process.env.EVAL_ANTHROPIC_API_KEY;
}

type Expected = {
  decision: ExpenditureDecision;
  statutory_anchor: ExpenditureStatutoryAnchor;
  min_eligibility_probability?: number;
};

const classifier = makeExpenditureClassifier();

const summary = await runEval<ExpenditureClassifierInput, ExpenditureClassifierOutput, Expected>({
  agentName: 'expenditure-classifier',
  goldenPath: fileURLToPath(new URL('./golden.ndjson', import.meta.url)),
  runOne: (input) => classifier.classify(input),
  score: (output, expected) => {
    const decisionMatch = categoryAccuracy(output.decision, expected.decision);
    const anchorMatch = categoryAccuracy(output.statutory_anchor, expected.statutory_anchor);
    const score = (Number(decisionMatch.correct) + Number(anchorMatch.correct)) / 2;
    const probabilityFloor = expected.min_eligibility_probability ?? 0;
    const probabilityOk = output.eligibility_probability >= probabilityFloor;
    const passed = score === 1 && probabilityOk;
    return Promise.resolve({
      score,
      passed,
      details: {
        decision_match: decisionMatch.correct,
        anchor_match: anchorMatch.correct,
        eligibility_probability: output.eligibility_probability,
        eligibility_probability_floor: probabilityFloor,
        eligibility_probability_ok: probabilityOk,
      },
    });
  },
});

process.stderr.write(
  `\nexpenditure-classifier eval: ${summary.passed}/${summary.totalCases} passed (mean score ${summary.meanScore.toFixed(2)})\n`,
);
process.exit(summary.failed > 0 ? 1 : 0);
