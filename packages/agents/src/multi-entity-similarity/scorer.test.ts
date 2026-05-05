import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { generateOrderedPairs, type Activity } from './scorer.js';
import { MultiEntitySimilarityScan } from './prompts/multi-entity-similarity@1.0.0.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TENANT_A = '11111111-1111-4111-8111-111111111111';

function makeActivity(overrides: Partial<Activity> = {}): Activity {
  return {
    id: randomUUID(),
    title: 'Test Activity',
    description: 'A description of the R&D activity.',
    tenant_id: TENANT_A,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// runPairwiseScan: < 2 activities => pairs_scored = 0
// ---------------------------------------------------------------------------

test('runPairwiseScan with < 2 activities returns pairs_scored = 0 (via generateOrderedPairs)', () => {
  // We test the precondition that drives the early-return in runPairwiseScan:
  // when fewer than 2 activities exist, no pairs can be generated.
  const zero = generateOrderedPairs([]);
  assert.equal(zero.length, 0);

  const one = generateOrderedPairs([makeActivity()]);
  assert.equal(one.length, 0);
});

// ---------------------------------------------------------------------------
// Pair ordering: a.id < b.id
// ---------------------------------------------------------------------------

test('generateOrderedPairs enforces a.id < b.id for every pair', () => {
  // Create activities with deterministic UUIDs so we can verify ordering.
  const actA = makeActivity({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  const actB = makeActivity({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
  const actC = makeActivity({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });

  // Deliberately pass in reverse order to test that sorting is enforced.
  const pairs = generateOrderedPairs([actC, actA, actB]);

  assert.equal(pairs.length, 3); // C(3,2) = 3

  for (const pair of pairs) {
    assert.ok(pair.a.id < pair.b.id, `Expected a.id (${pair.a.id}) < b.id (${pair.b.id})`);
  }

  // Verify the exact pairs produced (sorted by a.id then b.id)
  const pairIds = pairs.map((p) => `${p.a.id}:${p.b.id}`).sort();
  assert.deepEqual(pairIds, [
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  ]);
});

// ---------------------------------------------------------------------------
// MultiEntitySimilarityScan schema: valid input
// ---------------------------------------------------------------------------

test('MultiEntitySimilarityScan schema validates correct input', () => {
  const validData = {
    scan_id: randomUUID(),
    pairs_scored: 6,
    flagged_pairs: [
      {
        activity_a_id: randomUUID(),
        activity_b_id: randomUUID(),
        historical_rejection_event_id: null,
        similarity_score: 0.82,
        similarity_kind: 'semantic' as const,
        rationale:
          'Both activities describe hypothesis testing of novel polymer blends using identical experimental methodology and shared technical vocabulary.',
      },
      {
        activity_a_id: randomUUID(),
        activity_b_id: null,
        historical_rejection_event_id: randomUUID(),
        similarity_score: 0.91,
        similarity_kind: 'vs_historical_rejection' as const,
        rationale:
          'This activity closely mirrors the approach described in AAT decision 2023/1234 which was rejected on the basis of insufficient technical uncertainty.',
      },
    ],
    prompt_version: '1.0.0' as const,
    model: 'claude-sonnet-4-5-20250514',
  };

  const result = MultiEntitySimilarityScan.safeParse(validData);
  assert.ok(result.success, `Expected valid data to parse successfully`);
  if (!result.success) return; // type narrowing
  assert.equal(result.data.scan_id, validData.scan_id);
  assert.equal(result.data.pairs_scored, 6);
  assert.equal(result.data.flagged_pairs.length, 2);
});

// ---------------------------------------------------------------------------
// MultiEntitySimilarityScan schema: rejects similarity_score > 1
// ---------------------------------------------------------------------------

test('MultiEntitySimilarityScan schema rejects similarity_score > 1', () => {
  const invalidData = {
    scan_id: randomUUID(),
    pairs_scored: 1,
    flagged_pairs: [
      {
        activity_a_id: randomUUID(),
        activity_b_id: randomUUID(),
        historical_rejection_event_id: null,
        similarity_score: 1.5, // Invalid: exceeds max of 1.0
        similarity_kind: 'lexical' as const,
        rationale:
          'This rationale explains why the pair was flagged as having high textual overlap in their methodology sections.',
      },
    ],
    prompt_version: '1.0.0' as const,
    model: 'claude-sonnet-4-5-20250514',
  };

  const result = MultiEntitySimilarityScan.safeParse(invalidData);
  assert.ok(!result.success, 'Expected schema to reject similarity_score > 1');
});

// ---------------------------------------------------------------------------
// MultiEntitySimilarityScan schema: rejects similarity_score < 0
// ---------------------------------------------------------------------------

test('MultiEntitySimilarityScan schema rejects similarity_score < 0', () => {
  const invalidData = {
    scan_id: randomUUID(),
    pairs_scored: 1,
    flagged_pairs: [
      {
        activity_a_id: randomUUID(),
        activity_b_id: randomUUID(),
        historical_rejection_event_id: null,
        similarity_score: -0.1, // Invalid: below min of 0.0
        similarity_kind: 'hybrid' as const,
        rationale:
          'This rationale explains why the pair was flagged as having combined lexical and semantic overlap in methodology.',
      },
    ],
    prompt_version: '1.0.0' as const,
    model: 'claude-sonnet-4-5-20250514',
  };

  const result = MultiEntitySimilarityScan.safeParse(invalidData);
  assert.ok(!result.success, 'Expected schema to reject similarity_score < 0');
});

// ---------------------------------------------------------------------------
// MultiEntitySimilarityScan schema: rejects invalid prompt_version
// ---------------------------------------------------------------------------

test('MultiEntitySimilarityScan schema rejects wrong prompt_version', () => {
  const invalidData = {
    scan_id: randomUUID(),
    pairs_scored: 0,
    flagged_pairs: [],
    prompt_version: '2.0.0', // Invalid: must be literal '1.0.0'
    model: 'claude-sonnet-4-5-20250514',
  };

  const result = MultiEntitySimilarityScan.safeParse(invalidData);
  assert.ok(!result.success, 'Expected schema to reject prompt_version != 1.0.0');
});

// ---------------------------------------------------------------------------
// MultiEntitySimilarityScan schema: rejects rationale too short
// ---------------------------------------------------------------------------

test('MultiEntitySimilarityScan schema rejects rationale shorter than 50 chars', () => {
  const invalidData = {
    scan_id: randomUUID(),
    pairs_scored: 1,
    flagged_pairs: [
      {
        activity_a_id: randomUUID(),
        activity_b_id: randomUUID(),
        historical_rejection_event_id: null,
        similarity_score: 0.8,
        similarity_kind: 'lexical' as const,
        rationale: 'Too short.', // Invalid: < 50 chars
      },
    ],
    prompt_version: '1.0.0' as const,
    model: 'claude-sonnet-4-5-20250514',
  };

  const result = MultiEntitySimilarityScan.safeParse(invalidData);
  assert.ok(!result.success, 'Expected schema to reject rationale shorter than 50 chars');
});

// ---------------------------------------------------------------------------
// generateOrderedPairs: correct count for N activities
// ---------------------------------------------------------------------------

test('generateOrderedPairs produces C(n,2) pairs', () => {
  const activities = Array.from({ length: 5 }, () => makeActivity());
  const pairs = generateOrderedPairs(activities);
  // C(5,2) = 10
  assert.equal(pairs.length, 10);
});
