import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SIMILARITY_THRESHOLD,
  scoreColorClass,
  type ComparisonResponse,
} from './multi-entity-comparison.js';

/**
 * P7 Theme C Task C.4 — multi-entity comparison component tests.
 *
 * Pure-function tests for the comparison panel helper. Full DOM
 * interaction deferred to Playwright e2e.
 */

test('SIMILARITY_THRESHOLD is 0.75', () => {
  assert.equal(SIMILARITY_THRESHOLD, 0.75);
});

test('scoreColorClass: null → bg-muted', () => {
  assert.equal(scoreColorClass(null), 'bg-muted');
});

test('scoreColorClass: >= 0.75 → amber', () => {
  assert.match(scoreColorClass(0.75), /amber/);
  assert.match(scoreColorClass(0.9), /amber/);
  assert.match(scoreColorClass(1.0), /amber/);
});

test('scoreColorClass: 0.5–0.74 → yellow', () => {
  assert.match(scoreColorClass(0.5), /yellow/);
  assert.match(scoreColorClass(0.74), /yellow/);
});

test('scoreColorClass: < 0.5 → green', () => {
  assert.match(scoreColorClass(0.0), /green/);
  assert.match(scoreColorClass(0.49), /green/);
});

test('ComparisonResponse: pre-p7d shape with empty scores', () => {
  const response: ComparisonResponse = {
    activities: [
      { id: 'a1', title: 'Activity A', code: 'CA-01', kind: 'core' },
      { id: 'a2', title: 'Activity B', code: 'CA-02', kind: 'core' },
    ],
    scores: [],
    similarity_available: false,
  };
  assert.equal(response.similarity_available, false);
  assert.equal(response.scores.length, 0);
  assert.equal(response.activities.length, 2);
});

test('ComparisonResponse: with scores (post-p7d)', () => {
  const response: ComparisonResponse = {
    activities: [
      { id: 'a1', title: 'Activity A', code: 'CA-01', kind: 'core' },
      { id: 'a2', title: 'Activity B', code: 'CA-02', kind: 'core' },
    ],
    scores: [{ activity_a_id: 'a1', activity_b_id: 'a2', score: 0.82 }],
    similarity_available: true,
  };
  assert.equal(response.similarity_available, true);
  assert.equal(response.scores.length, 1);
  assert.equal(response.scores[0]!.score, 0.82);
  assert.ok(response.scores[0]!.score >= SIMILARITY_THRESHOLD);
});

test.todo('MultiEntityComparison component: full DOM interaction tested in Playwright e2e');
