import { SCORING_RULES } from './rules.js';
import type { ScoreInput, ScoreResult, ScoreRuleBreakdown } from './types.js';

/**
 * Run every scoring rule against the input and return the aggregated total
 * + per-rule breakdown.
 *
 * Rules run in parallel — they're independent and don't share state, and
 * the SQL queries are bounded enough that the connection pool can absorb
 * 10 concurrent reads. The breakdown order matches `SCORING_RULES` order
 * because `Promise.all` preserves index alignment.
 *
 * `details` is conditionally spread (`?` propagation) to honour
 * `exactOptionalPropertyTypes: true` — the rule helper omits the field when
 * undefined, so we mirror that here rather than emitting `details: undefined`.
 *
 * `max_pts` is recomputed per call (sum of `rule.max_pts` over the active
 * rules) rather than imported as a constant — this lets the test suite stub
 * `SCORING_RULES` to a smaller subset without falsely reporting the full 100.
 */
export async function computeScore(input: ScoreInput): Promise<ScoreResult> {
  const breakdown: ScoreRuleBreakdown[] = await Promise.all(
    SCORING_RULES.map(async (rule) => {
      const result = await rule.fn(input);
      const entry: ScoreRuleBreakdown = {
        id: rule.id,
        label: rule.label,
        earned: result.earned,
        max: rule.max_pts,
        ...(result.details !== undefined ? { details: result.details } : {}),
      };
      return entry;
    }),
  );
  const total = breakdown.reduce((sum, b) => sum + b.earned, 0);
  const max = breakdown.reduce((sum, b) => sum + b.max, 0);
  return {
    total_pts: total,
    max_pts: max,
    rule_breakdown: breakdown,
    computed_at: new Date(),
  };
}
