import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  truncateRationale,
  TRANSITION_RATIONALE_MAX_CHARS,
  type TransitionBadgeProps,
  type TransitionVariant,
} from './transition-badge.js';

/**
 * Design system signature components — TransitionBadge.
 *
 * Sits in the gutter between FY columns of the multi-cycle timeline,
 * communicating how an activity evolved across reporting periods.
 * See docs/design/system.md §"Transition badge (multi-cycle timeline)".
 *
 * Variants: continuation | pivot | completion | abandoned
 * Behavior: hover reveals transition_rationale (capped to schema limit)
 */

// ---------- truncateRationale ----------

test('truncateRationale: short text returned as-is', () => {
  assert.equal(truncateRationale('Pivoted to a new approach'), 'Pivoted to a new approach');
});

test('truncateRationale: text at exact max-length returned unchanged', () => {
  const exact = 'a'.repeat(TRANSITION_RATIONALE_MAX_CHARS);
  assert.equal(truncateRationale(exact).length, TRANSITION_RATIONALE_MAX_CHARS);
  assert.equal(truncateRationale(exact), exact);
});

test('truncateRationale: long text truncated with ellipsis', () => {
  const long = 'a'.repeat(TRANSITION_RATIONALE_MAX_CHARS + 50);
  const out = truncateRationale(long);
  assert.equal(out.length, TRANSITION_RATIONALE_MAX_CHARS);
  assert.match(out, /…$/);
});

test('truncateRationale: ellipsis replaces last char so total stays at max', () => {
  // Ensures we don't exceed the schema cap by appending the ellipsis ON TOP.
  const long = 'b'.repeat(TRANSITION_RATIONALE_MAX_CHARS + 1);
  const out = truncateRationale(long);
  assert.equal(out.length, TRANSITION_RATIONALE_MAX_CHARS);
});

test('truncateRationale: empty string returned as empty', () => {
  assert.equal(truncateRationale(''), '');
});

// ---------- TRANSITION_RATIONALE_MAX_CHARS exported constant ----------

test('TRANSITION_RATIONALE_MAX_CHARS: matches schema cap of 500', () => {
  // Per docs/design/system.md and the multi-cycle narrative schema.
  assert.equal(TRANSITION_RATIONALE_MAX_CHARS, 500);
});

// ---------- TransitionVariant enum ----------

test('TransitionVariant: enum has exactly continuation/pivot/completion/abandoned', () => {
  const variants: TransitionVariant[] = ['continuation', 'pivot', 'completion', 'abandoned'];
  assert.equal(variants.length, 4);
});

// ---------- TransitionBadgeProps type contract ----------

test('TransitionBadgeProps: minimal required props compile', () => {
  const minimal: TransitionBadgeProps = {
    variant: 'continuation',
    label: 'Continuation',
  };
  assert.equal(minimal.variant, 'continuation');
});

test('TransitionBadgeProps: full prop set compiles', () => {
  const full: TransitionBadgeProps = {
    variant: 'pivot',
    label: 'Pivot',
    rationale:
      'Original quantum-tunneling approach proved infeasible — pivoted to thermal management',
    className: 'extra',
  };
  assert.equal(full.variant, 'pivot');
});
