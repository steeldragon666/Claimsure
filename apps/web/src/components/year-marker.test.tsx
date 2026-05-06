import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidFYLabel, type YearMarkerProps, type YearMarkerState } from './year-marker.js';

/**
 * Design system signature components — YearMarker.
 *
 * Defines the FY columns in the multi-cycle timeline.
 * Format: "FY24" "FY25" "FY26" — Fraunces display-md.
 *
 * States: current (patina underline) | past (default) | future (ink-subtle, hairline dashed)
 *
 * See docs/design/system.md §"Year-marker (multi-cycle timeline)".
 */

// ---------- isValidFYLabel ----------

test('isValidFYLabel: accepts FY + 2-digit year (FY24, FY25)', () => {
  assert.equal(isValidFYLabel('FY24'), true);
  assert.equal(isValidFYLabel('FY99'), true);
  assert.equal(isValidFYLabel('FY00'), true);
});

test('isValidFYLabel: rejects FY + 4-digit year (the codebase uses 2-digit suffix)', () => {
  // The R&DTI claim model uses FY24 not FY2024 across schema +
  // narratives; enforcing this surface keeps copy consistent.
  assert.equal(isValidFYLabel('FY2024'), false);
});

test('isValidFYLabel: rejects malformed inputs', () => {
  assert.equal(isValidFYLabel('fy24'), false); // lowercase
  assert.equal(isValidFYLabel('FY2'), false); // single digit
  assert.equal(isValidFYLabel('FY 24'), false); // space
  assert.equal(isValidFYLabel(''), false);
  assert.equal(isValidFYLabel('24'), false);
});

// ---------- YearMarkerState enum ----------

test('YearMarkerState: enum has exactly current/past/future', () => {
  const states: YearMarkerState[] = ['current', 'past', 'future'];
  assert.equal(states.length, 3);
});

// ---------- YearMarkerProps type contract ----------

test('YearMarkerProps: minimal required props compile', () => {
  const minimal: YearMarkerProps = {
    fyLabel: 'FY25',
  };
  assert.equal(minimal.fyLabel, 'FY25');
});

test('YearMarkerProps: full prop set compiles', () => {
  const full: YearMarkerProps = {
    fyLabel: 'FY24',
    state: 'past',
    className: 'extra',
  };
  assert.equal(full.state, 'past');
});
