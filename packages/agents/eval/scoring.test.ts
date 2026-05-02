import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  f1Score,
  jaccardSimilarity,
  categoryAccuracy,
  validateNarrativeStructure,
} from './scoring.js';
import type { NarrativeSegment } from '../src/narrative-drafter/validate.js';

// ---------------------------------------------------------------------------
// f1Score
// ---------------------------------------------------------------------------

test('f1Score: exact match returns 1', () => {
  const result = f1Score(new Set(['a', 'b', 'c']), new Set(['a', 'b', 'c']));
  assert.equal(result.precision, 1);
  assert.equal(result.recall, 1);
  assert.equal(result.f1, 1);
});

test('f1Score: disjoint sets return 0', () => {
  const result = f1Score(new Set(['a']), new Set(['b']));
  assert.equal(result.precision, 0);
  assert.equal(result.recall, 0);
  assert.equal(result.f1, 0);
});

test('f1Score: partial overlap computes correctly', () => {
  // predicted {a,b}, expected {a,c} → tp=1, precision=0.5, recall=0.5, f1=0.5
  const result = f1Score(new Set(['a', 'b']), new Set(['a', 'c']));
  assert.equal(result.precision, 0.5);
  assert.equal(result.recall, 0.5);
  assert.equal(result.f1, 0.5);
});

test('f1Score: both empty is a vacuous match', () => {
  const result = f1Score(new Set(), new Set());
  assert.equal(result.f1, 1);
});

test('f1Score: empty predicted, non-empty expected → recall 0', () => {
  const result = f1Score(new Set(), new Set(['a']));
  assert.equal(result.recall, 0);
  assert.equal(result.f1, 0);
});

// ---------------------------------------------------------------------------
// jaccardSimilarity
// ---------------------------------------------------------------------------

test('jaccardSimilarity: identical sets → 1', () => {
  assert.equal(jaccardSimilarity(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
});

test('jaccardSimilarity: disjoint → 0', () => {
  assert.equal(jaccardSimilarity(new Set(['a']), new Set(['b'])), 0);
});

test('jaccardSimilarity: half overlap', () => {
  // {a,b} vs {b,c} → intersection 1, union 3 → 1/3
  const result = jaccardSimilarity(new Set(['a', 'b']), new Set(['b', 'c']));
  assert.ok(Math.abs(result - 1 / 3) < 1e-9);
});

test('jaccardSimilarity: both empty → 1', () => {
  assert.equal(jaccardSimilarity(new Set(), new Set()), 1);
});

// ---------------------------------------------------------------------------
// categoryAccuracy
// ---------------------------------------------------------------------------

test('categoryAccuracy: matching strings → correct true', () => {
  assert.deepEqual(categoryAccuracy('eligible', 'eligible'), { correct: true });
});

test('categoryAccuracy: mismatched strings → correct false', () => {
  assert.deepEqual(categoryAccuracy('eligible', 'ineligible'), { correct: false });
});

// ---------------------------------------------------------------------------
// validateNarrativeStructure
// ---------------------------------------------------------------------------

test('validateNarrativeStructure: passes when all claims cite in-scope events', () => {
  const sections: Record<string, NarrativeSegment[]> = {
    hypothesis: [
      { type: 'prose', text: 'background' },
      { type: 'claim', text: 'we tried X', citing_events: ['e1'] },
      { type: 'claim', text: 'and Y', citing_events: ['e2'] },
    ],
  };
  const result = validateNarrativeStructure(sections, new Set(['e1', 'e2']), 1);
  assert.equal(result.valid, true);
  assert.deepEqual(result.reasons, []);
});

test('validateNarrativeStructure: fails when claim has no citing_events', () => {
  const sections: Record<string, NarrativeSegment[]> = {
    hypothesis: [{ type: 'claim', text: 'unanchored claim', citing_events: [] }],
  };
  const result = validateNarrativeStructure(sections, new Set(['e1']), 1);
  assert.equal(result.valid, false);
  assert.ok(result.reasons.some((r) => r.includes('no citing_events')));
});

test('validateNarrativeStructure: fails on out-of-scope citation', () => {
  const sections: Record<string, NarrativeSegment[]> = {
    hypothesis: [{ type: 'claim', text: 'claim', citing_events: ['e1', 'e_other'] }],
  };
  const result = validateNarrativeStructure(sections, new Set(['e1']), 1);
  assert.equal(result.valid, false);
  assert.ok(result.reasons.some((r) => r.includes('out-of-scope event e_other')));
});

test('validateNarrativeStructure: fails when section has fewer than min claims', () => {
  const sections: Record<string, NarrativeSegment[]> = {
    hypothesis: [{ type: 'prose', text: 'no claims here' }],
  };
  const result = validateNarrativeStructure(sections, new Set(['e1']), 2);
  assert.equal(result.valid, false);
  assert.ok(result.reasons.some((r) => r.includes('< required 2')));
});

test('validateNarrativeStructure: minClaim 0 → empty section ok', () => {
  const sections: Record<string, NarrativeSegment[]> = {
    hypothesis: [{ type: 'prose', text: 'just prose' }],
  };
  const result = validateNarrativeStructure(sections, new Set(), 0);
  assert.equal(result.valid, true);
});
