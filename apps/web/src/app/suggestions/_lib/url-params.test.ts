import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeSuggestionListSearch,
  parseSuggestionSourceKindFilter,
  parseSuggestionStatusFilter,
  suggestionListApiParams,
  type SuggestionSourceKindFilter,
  type SuggestionStatusFilter,
} from './url-params.js';
import { SUGGESTION_SOURCE_KINDS, SUGGESTION_STATUSES } from './types.js';

/**
 * Pure-function tests for the /suggestions URL parsers (P7 B.7).
 *
 * Same shape as `apps/web/src/app/projects/_lib/url-params.test.ts` —
 * happy-path round-trip per accepted value plus default-on-junk
 * coverage.
 */

// =============================================================================
// parseSuggestionStatusFilter
// =============================================================================

test('parseSuggestionStatusFilter: round-trip "all"', () => {
  assert.equal(parseSuggestionStatusFilter('all'), 'all');
});

test('parseSuggestionStatusFilter: round-trip every status literal', () => {
  for (const s of SUGGESTION_STATUSES) {
    assert.equal(parseSuggestionStatusFilter(s), s);
  }
});

test('parseSuggestionStatusFilter: null → "all"', () => {
  assert.equal(parseSuggestionStatusFilter(null), 'all');
});

test('parseSuggestionStatusFilter: undefined → "all"', () => {
  assert.equal(parseSuggestionStatusFilter(undefined), 'all');
});

test('parseSuggestionStatusFilter: empty string → "all"', () => {
  assert.equal(parseSuggestionStatusFilter(''), 'all');
});

test('parseSuggestionStatusFilter: unknown value → "all"', () => {
  assert.equal(parseSuggestionStatusFilter('archived'), 'all');
});

test('parseSuggestionStatusFilter: case-sensitive — "Open" → default', () => {
  assert.equal(parseSuggestionStatusFilter('Open'), 'all');
});

// =============================================================================
// parseSuggestionSourceKindFilter
// =============================================================================

test('parseSuggestionSourceKindFilter: round-trip every source kind', () => {
  for (const sk of SUGGESTION_SOURCE_KINDS) {
    assert.equal(parseSuggestionSourceKindFilter(sk), sk);
  }
});

test('parseSuggestionSourceKindFilter: round-trip "all"', () => {
  assert.equal(parseSuggestionSourceKindFilter('all'), 'all');
});

test('parseSuggestionSourceKindFilter: null → "all"', () => {
  assert.equal(parseSuggestionSourceKindFilter(null), 'all');
});

test('parseSuggestionSourceKindFilter: unknown → "all"', () => {
  assert.equal(parseSuggestionSourceKindFilter('not_a_kind'), 'all');
});

// =============================================================================
// suggestionListApiParams — produces the API query bag
// =============================================================================

test('suggestionListApiParams: all/all → empty params', () => {
  const got = suggestionListApiParams({ status: 'all', sourceKind: 'all' });
  assert.deepEqual(got, {});
});

test('suggestionListApiParams: status filter passes through', () => {
  const got = suggestionListApiParams({ status: 'open', sourceKind: 'all' });
  assert.deepEqual(got, { status: 'open' });
});

test('suggestionListApiParams: source_kind filter passes through', () => {
  const got = suggestionListApiParams({ status: 'all', sourceKind: 'rif_event' });
  assert.deepEqual(got, { source_kind: 'rif_event' });
});

test('suggestionListApiParams: both filters combine', () => {
  const got = suggestionListApiParams({
    status: 'pr_drafted',
    sourceKind: 'consultant_flag',
  });
  assert.deepEqual(got, { status: 'pr_drafted', source_kind: 'consultant_flag' });
});

// =============================================================================
// encodeSuggestionListSearch — URL-search encoding
// =============================================================================

test('encodeSuggestionListSearch: all/all → empty string', () => {
  assert.equal(encodeSuggestionListSearch({ status: 'all', sourceKind: 'all' }), '');
});

test('encodeSuggestionListSearch: status filter only', () => {
  const got = encodeSuggestionListSearch({ status: 'open', sourceKind: 'all' });
  assert.equal(got, 'status=open');
});

test('encodeSuggestionListSearch: source_kind only', () => {
  const got = encodeSuggestionListSearch({
    status: 'all',
    sourceKind: 'consultant_flag',
  });
  assert.equal(got, 'source_kind=consultant_flag');
});

test('encodeSuggestionListSearch: both filters', () => {
  const got = encodeSuggestionListSearch({
    status: 'triaged',
    sourceKind: 'reviewer_disposition',
  });
  // URLSearchParams orders insertion-order; status is added first.
  assert.equal(got, 'status=triaged&source_kind=reviewer_disposition');
});

test('encodeSuggestionListSearch: round-trips through URLSearchParams', () => {
  // Sanity check — the encoded string is parseable back into the
  // original filter shape.
  const opts = {
    status: 'pr_merged' as SuggestionStatusFilter,
    sourceKind: 'contract_test_failure' as SuggestionSourceKindFilter,
  };
  const encoded = encodeSuggestionListSearch(opts);
  const params = new URLSearchParams(encoded);
  assert.equal(params.get('status'), 'pr_merged');
  assert.equal(params.get('source_kind'), 'contract_test_failure');
});
