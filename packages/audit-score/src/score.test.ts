import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeScore } from './score.js';
import { SCORING_RULES, TOTAL_MAX_PTS } from './rules.js';
import type { ScoreInput, ScoreRule, ScoreRuleResult, SqlClient } from './types.js';

const TENANT = '00000000-0000-4000-8000-0000000d0001';
const SUBJECT = '00000000-0000-4000-8000-0000000d0011';

/**
 * No-op sql client; the rule fns are stubbed out below so it never gets called.
 * Cast through `unknown` because `SqlClient` is generic over `Row` and the
 * concrete function returns `Promise<unknown[]>` — the bridge satisfies TS
 * without surfacing the no-unnecessary-assertion lint rule.
 */
const noopSqlFn = (..._args: unknown[]): Promise<unknown[]> => Promise.resolve([]);
const noopSql = noopSqlFn as unknown as SqlClient;

const baseInput: ScoreInput = {
  tenant_id: TENANT,
  subject_tenant_id: SUBJECT,
  sql_client: noopSql,
};

/**
 * Replace SCORING_RULES contents in-place with the supplied stubs and
 * restore on cleanup. Mutating the exported array is the only entry-point
 * for `computeScore` since it imports the const directly; cleaner than
 * adding a DI seam to the production code purely for tests.
 */
const withStubbedRules = async (
  stubs: Array<{ id: string; result: ScoreRuleResult; max_pts: number }>,
  body: () => Promise<void>,
): Promise<void> => {
  const original: ScoreRule[] = SCORING_RULES.slice();
  SCORING_RULES.length = 0;
  for (const s of stubs) {
    SCORING_RULES.push({
      id: s.id,
      label: s.id,
      max_pts: s.max_pts,
      fn: () => Promise.resolve(s.result),
    });
  }
  try {
    await body();
  } finally {
    SCORING_RULES.length = 0;
    for (const r of original) SCORING_RULES.push(r);
  }
};

test('computeScore: aggregates earned across all stubbed rules', async () => {
  await withStubbedRules(
    [
      { id: 'a', max_pts: 10, result: { earned: 5, details: 'a-details' } },
      { id: 'b', max_pts: 15, result: { earned: 15, details: 'b-details' } },
      { id: 'c', max_pts: 5, result: { earned: 0 } },
    ],
    async () => {
      const result = await computeScore(baseInput);
      assert.equal(result.total_pts, 20);
      assert.equal(result.max_pts, 30);
      assert.equal(result.rule_breakdown.length, 3);
      // Order matches SCORING_RULES order.
      assert.deepEqual(
        result.rule_breakdown.map((r) => r.id),
        ['a', 'b', 'c'],
      );
      // Details propagate when set, omitted when undefined.
      const a = result.rule_breakdown[0];
      assert.equal(a?.details, 'a-details');
      const c = result.rule_breakdown[2];
      assert.equal(c?.details, undefined);
      assert.ok('id' in (c ?? {}));
    },
  );
});

test('computeScore: real rules sum to TOTAL_MAX_PTS (100)', () => {
  // Quick invariant sanity check at the score.ts surface.
  const summed = SCORING_RULES.reduce((s, r) => s + r.max_pts, 0);
  assert.equal(summed, TOTAL_MAX_PTS);
  assert.equal(summed, 100);
});

test('computeScore: computed_at is fresh (within last second)', async () => {
  await withStubbedRules([{ id: 'x', max_pts: 5, result: { earned: 0 } }], async () => {
    const before = Date.now();
    const result = await computeScore(baseInput);
    const after = Date.now();
    const t = result.computed_at.getTime();
    assert.ok(t >= before - 1 && t <= after + 1, `computed_at ${t} not in [${before}, ${after}]`);
  });
});
