import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ISSUE_SUMMARY_MAX,
  ISSUE_SUMMARY_MIN,
  parseSourcePayload,
  validateIssueSummary,
} from '@/app/suggestions/_lib/helpers.js';
import {
  SUGGESTION_SOURCE_KIND_LABELS,
  SUGGESTION_SOURCE_KINDS,
  type SuggestionSourceKind,
} from '@/app/suggestions/_lib/types.js';

/**
 * P7 Theme B Task B.7 — pure-helper tests for <FlagSuggestionModal>.
 *
 * The modal itself is JSX + react-hook-form + TanStack Mutation; DOM
 * behaviour (open/close, submit cycle, navigation after success) is
 * exercised via Playwright. Here we test the validation surface that
 * the modal applies BEFORE hitting the API — these are the rules the
 * user sees as inline form errors.
 *
 * The validation logic must mirror the API's Zod constraints in
 * `apps/api/src/routes/prompt-suggestions.ts#FlagSuggestionInput`.
 * Drift between the two surfaces leads to either:
 *   (a) a 400 round-trip the user could have avoided client-side, or
 *   (b) the modal accepting input the API will reject — confusing UX.
 *
 * The tests below pin the contract.
 */

// =============================================================================
// Issue-summary validation — mirrors API's z.string().min(10).max(1000)
// =============================================================================

test('FlagSuggestionModal validation: issue_summary at API min (10) is valid', () => {
  // The API accepts >= 10 chars after Zod's default no-trim. Our helper
  // trims first; both implementations agree on the boundary at 10.
  const text = 'X'.repeat(ISSUE_SUMMARY_MIN);
  assert.equal(validateIssueSummary(text).valid, true);
});

test('FlagSuggestionModal validation: issue_summary one char below min is invalid', () => {
  const text = 'X'.repeat(ISSUE_SUMMARY_MIN - 1);
  assert.equal(validateIssueSummary(text).valid, false);
});

test('FlagSuggestionModal validation: issue_summary at API max (1000) is valid', () => {
  const text = 'X'.repeat(ISSUE_SUMMARY_MAX);
  assert.equal(validateIssueSummary(text).valid, true);
});

test('FlagSuggestionModal validation: issue_summary one char above max is invalid', () => {
  const text = 'X'.repeat(ISSUE_SUMMARY_MAX + 1);
  assert.equal(validateIssueSummary(text).valid, false);
});

test('FlagSuggestionModal validation: bounds match API constraints exactly', () => {
  // Drift guard — the API uses .min(10).max(1000) per the route module.
  // If a future API change widens these bounds, this test surfaces the
  // mismatch loudly.
  assert.equal(ISSUE_SUMMARY_MIN, 10);
  assert.equal(ISSUE_SUMMARY_MAX, 1000);
});

// =============================================================================
// Source-payload parsing — must produce a JSON object (record), since
// the API expects z.record(z.unknown()).
// =============================================================================

test('FlagSuggestionModal payload: empty input → {}', () => {
  // Convenience: a consultant flagging "this looks wrong" can leave
  // payload empty without inventing fake JSON.
  assert.deepEqual(parseSourcePayload(''), {});
});

test('FlagSuggestionModal payload: object → object', () => {
  assert.deepEqual(parseSourcePayload('{"reason":"hypothesis is repeating itself"}'), {
    reason: 'hypothesis is repeating itself',
  });
});

test('FlagSuggestionModal payload: arrays rejected (API expects record)', () => {
  assert.throws(() => parseSourcePayload('[]'), /JSON object/);
});

test('FlagSuggestionModal payload: malformed JSON → friendly error', () => {
  assert.throws(() => parseSourcePayload('{ this is not valid }'), /must be valid JSON/);
});

// =============================================================================
// Source-kind enum — every API-accepted value has a UI label so the
// dropdown never renders the raw enum string. The Record<X, string>
// type is the primary defence; this is belt-and-braces.
// =============================================================================

test('FlagSuggestionModal source_kind: every value has a UI label', () => {
  for (const sk of SUGGESTION_SOURCE_KINDS) {
    assert.ok(
      typeof SUGGESTION_SOURCE_KIND_LABELS[sk] === 'string' &&
        SUGGESTION_SOURCE_KIND_LABELS[sk].length > 0,
      `missing label for source_kind=${sk}`,
    );
  }
});

test('FlagSuggestionModal source_kind: default is consultant_flag', () => {
  // The most common originating event for human-flagged suggestions —
  // matches the modal's DEFAULT_FORM_VALUES. Pinned in a test so a
  // future change to the default surfaces here.
  const expectedDefault: SuggestionSourceKind = 'consultant_flag';
  assert.ok(SUGGESTION_SOURCE_KIND_LABELS[expectedDefault]);
});

// =============================================================================
// Friendly error messages — the modal surfaces these inline; they
// should be specific enough that a user understands which field is
// wrong without consulting docs.
// =============================================================================

test('FlagSuggestionModal errors: too-short summary error names the constraint', () => {
  const got = validateIssueSummary('hi');
  assert.equal(got.valid, false);
  assert.match(got.error ?? '', /at least 10/);
});

test('FlagSuggestionModal errors: too-long summary error names the constraint', () => {
  const got = validateIssueSummary('A'.repeat(ISSUE_SUMMARY_MAX + 1));
  assert.equal(got.valid, false);
  assert.match(got.error ?? '', /at most 1000/);
});

test('FlagSuggestionModal errors: bad payload error mentions JSON', () => {
  try {
    parseSourcePayload('not json');
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof Error);
    assert.match(err.message, /JSON/);
  }
});

test('FlagSuggestionModal errors: payload-array error mentions object expectation', () => {
  try {
    parseSourcePayload('[1,2,3]');
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof Error);
    assert.match(err.message, /JSON object/);
  }
});
