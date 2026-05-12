import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAIM_TAB_VALUES,
  DEFAULT_CLAIM_TAB,
  DEFAULT_EXPENDITURE_FILTER,
  EXPENDITURE_FILTER_LABELS,
  EXPENDITURE_FILTER_VALUES,
  nextTabFromKey,
  parseExpenditureFilter,
  parseTab,
  TAB_LABELS,
} from './url-params.js';

// parseTab -----------------------------------------------------------------

test('parseTab: "activities" returns "activities"', () => {
  assert.equal(parseTab('activities'), 'activities');
});

test('parseTab: each known tab round-trips', () => {
  // Defends against accidental drift between CLAIM_TAB_VALUES and the
  // accept-set inside parseTab — every literal in the list must parse
  // back to itself.
  for (const tab of CLAIM_TAB_VALUES) {
    assert.equal(parseTab(tab), tab);
  }
});

test('parseTab: null returns default ("activities")', () => {
  assert.equal(parseTab(null), DEFAULT_CLAIM_TAB);
  assert.equal(parseTab(null), 'activities');
});

test('parseTab: undefined returns default', () => {
  assert.equal(parseTab(undefined), DEFAULT_CLAIM_TAB);
});

test('parseTab: empty string returns default (treated as missing)', () => {
  assert.equal(parseTab(''), DEFAULT_CLAIM_TAB);
});

test('parseTab: unknown value returns default (graceful fallback for stale links)', () => {
  assert.equal(parseTab('foo'), DEFAULT_CLAIM_TAB);
  assert.equal(parseTab('Activities'), DEFAULT_CLAIM_TAB); // case-sensitive
});

// TAB_LABELS ---------------------------------------------------------------

test('TAB_LABELS: defines a label for every CLAIM_TAB_VALUES entry', () => {
  // TS already enforces Record<ClaimTab, string> at compile-time — this
  // runtime check is belt-and-braces to catch the case where someone widens
  // ClaimTab without updating TAB_LABELS. Cheap insurance against future
  // divergence.
  for (const tab of CLAIM_TAB_VALUES) {
    assert.equal(typeof TAB_LABELS[tab], 'string');
    assert.ok(TAB_LABELS[tab].length > 0, `label for ${tab} should be non-empty`);
  }
});

// nextTabFromKey ----------------------------------------------------------
//
// Pure helper for the WAI-ARIA APG keyboard-nav pattern on claim-tabs.tsx.
// The component-level test (focus actually moving in the DOM) is a
// Playwright concern — apps/web has no jsdom. Here we exercise the
// branching: each key maps to the right neighbour, wraps at boundaries,
// returns null for non-handled keys.
//
// Current CLAIM_TAB_VALUES order:
//   analysis, activities, review, evidence, expenditure, documents, timeline, final-draft

test('nextTabFromKey: ArrowRight from "activities" → "review"', () => {
  assert.equal(nextTabFromKey('ArrowRight', 'activities'), 'review');
});

test('nextTabFromKey: ArrowDown is treated the same as ArrowRight (next)', () => {
  assert.equal(nextTabFromKey('ArrowDown', 'activities'), 'review');
});

test('nextTabFromKey: ArrowRight from last tab wraps to first', () => {
  assert.equal(nextTabFromKey('ArrowRight', 'final-draft'), 'analysis');
});

test('nextTabFromKey: ArrowLeft from "evidence" → "review"', () => {
  assert.equal(nextTabFromKey('ArrowLeft', 'evidence'), 'review');
});

test('nextTabFromKey: ArrowUp is treated the same as ArrowLeft (previous)', () => {
  assert.equal(nextTabFromKey('ArrowUp', 'evidence'), 'review');
});

test('nextTabFromKey: ArrowLeft from first tab wraps to last', () => {
  assert.equal(nextTabFromKey('ArrowLeft', 'analysis'), 'final-draft');
});

test('nextTabFromKey: Home returns the first tab regardless of current', () => {
  assert.equal(nextTabFromKey('Home', 'expenditure'), 'analysis');
  assert.equal(nextTabFromKey('Home', 'analysis'), 'analysis');
});

test('nextTabFromKey: End returns the last tab regardless of current', () => {
  assert.equal(nextTabFromKey('End', 'expenditure'), 'final-draft');
  assert.equal(nextTabFromKey('End', 'final-draft'), 'final-draft');
});

test('nextTabFromKey: unhandled keys return null (caller preserves native behaviour)', () => {
  assert.equal(nextTabFromKey('Tab', 'activities'), null);
  assert.equal(nextTabFromKey('Enter', 'activities'), null);
  assert.equal(nextTabFromKey(' ', 'activities'), null);
  assert.equal(nextTabFromKey('Escape', 'activities'), null);
  assert.equal(nextTabFromKey('a', 'activities'), null);
});

test('nextTabFromKey: full ArrowRight cycle visits every tab and wraps', () => {
  // Defends against off-by-one drift in the wrap arithmetic.
  let current: (typeof CLAIM_TAB_VALUES)[number] = CLAIM_TAB_VALUES[0];
  const visited: string[] = [current];
  for (let i = 0; i < CLAIM_TAB_VALUES.length; i += 1) {
    const next = nextTabFromKey('ArrowRight', current);
    assert.ok(next !== null);
    current = next;
    visited.push(current);
  }
  // Visited each tab in CLAIM_TAB_VALUES order, then wrapped back to the start.
  assert.deepEqual(visited, [...CLAIM_TAB_VALUES, CLAIM_TAB_VALUES[0]]);
});

// parseExpenditureFilter --------------------------------------------------
//
// C5: the expenditure tab's filter chip strip is URL-driven via
// `?expenditure_filter=...`. Default is 'unmapped' (the most common
// workflow is "what's left to map?"). Same graceful-fallback shape as
// parseTab: unknown / missing input → default, never throws.

test('parseExpenditureFilter: each known value round-trips', () => {
  for (const v of EXPENDITURE_FILTER_VALUES) {
    assert.equal(parseExpenditureFilter(v), v);
  }
});

test('parseExpenditureFilter: null returns default ("unmapped")', () => {
  assert.equal(parseExpenditureFilter(null), DEFAULT_EXPENDITURE_FILTER);
  assert.equal(parseExpenditureFilter(null), 'unmapped');
});

test('parseExpenditureFilter: undefined returns default', () => {
  assert.equal(parseExpenditureFilter(undefined), DEFAULT_EXPENDITURE_FILTER);
});

test('parseExpenditureFilter: empty string returns default (treated as missing)', () => {
  assert.equal(parseExpenditureFilter(''), DEFAULT_EXPENDITURE_FILTER);
});

test('parseExpenditureFilter: unknown value returns default (graceful fallback)', () => {
  assert.equal(parseExpenditureFilter('foo'), DEFAULT_EXPENDITURE_FILTER);
  assert.equal(parseExpenditureFilter('Unmapped'), DEFAULT_EXPENDITURE_FILTER); // case-sensitive
  assert.equal(parseExpenditureFilter('UNMAPPED'), DEFAULT_EXPENDITURE_FILTER);
});

test('EXPENDITURE_FILTER_LABELS: defines a label for every value', () => {
  for (const v of EXPENDITURE_FILTER_VALUES) {
    assert.equal(typeof EXPENDITURE_FILTER_LABELS[v], 'string');
    assert.ok(EXPENDITURE_FILTER_LABELS[v].length > 0, `label for ${v} should be non-empty`);
  }
});
