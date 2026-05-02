/**
 * Eval scoring helpers for the three P6 agents.
 *
 * Pure functions only — no I/O, no Anthropic dependency, no module-level
 * side effects. The per-agent `run.ts` files compose these into
 * task-specific scoring pipelines and the framework's smoke test
 * (`run.test.ts`) and the helper-level test (`scoring.test.ts`) verify
 * each branch independently.
 *
 * Scoring helpers MUST stay independent of the agent factories so that
 * a future Task 7.2 (production-quality golden datasets) can vendor or
 * extend them without inadvertently coupling the dataset format to a
 * particular model implementation.
 */

import type { NarrativeSegment } from '../src/narrative-drafter/validate.js';

// ---------------------------------------------------------------------------
// Set-comparison primitives
// ---------------------------------------------------------------------------

/**
 * Precision / recall / F1 over two id sets.
 *
 *   precision = |predicted ∩ expected| / |predicted|
 *   recall    = |predicted ∩ expected| / |expected|
 *   F1        = 2 · precision · recall / (precision + recall)
 *
 * The F1 score is the harmonic mean and is robust against class
 * imbalance — it equals 0 when either precision or recall is 0, and
 * equals 1 only when both predicted and expected sets agree exactly.
 *
 * Edge cases:
 *   - Both sets empty                → returns {precision: 1, recall: 1, f1: 1}.
 *     (Vacuous match: nothing to predict, nothing missed.)
 *   - Predicted empty, expected non-empty → precision is 1 by convention
 *     (no false positives), recall 0, F1 0.
 *   - Predicted non-empty, expected empty → precision 0, recall 1, F1 0.
 */
export function f1Score(
  predicted: ReadonlySet<string>,
  expected: ReadonlySet<string>,
): { precision: number; recall: number; f1: number } {
  if (predicted.size === 0 && expected.size === 0) {
    return { precision: 1, recall: 1, f1: 1 };
  }
  let tp = 0;
  for (const id of predicted) {
    if (expected.has(id)) tp += 1;
  }
  const precision = predicted.size === 0 ? 1 : tp / predicted.size;
  const recall = expected.size === 0 ? 1 : tp / expected.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

/**
 * Jaccard similarity = |a ∩ b| / |a ∪ b|.
 *
 * Used for set-comparison tasks where neither precision nor recall is
 * privileged (e.g., did the synthesizer cluster the same events into
 * one proposed activity as the human curator?).
 *
 * Edge case: both sets empty → returns 1 (vacuous match, mirrors the
 * F1 convention).
 */
export function jaccardSimilarity<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const x of a) {
    if (b.has(x)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------
// Categorical accuracy
// ---------------------------------------------------------------------------

/**
 * Confusion-matrix style category accuracy for a single (predicted,
 * expected) string pair.
 *
 * Used by the expenditure-classifier eval to score the (decision,
 * statutory_anchor) pair: each is a small enum, and the eval treats
 * either-mismatch as a hard failure.
 */
export function categoryAccuracy<T extends string>(
  predicted: T,
  expected: T,
): { correct: boolean } {
  return { correct: predicted === expected };
}

// ---------------------------------------------------------------------------
// Narrative-drafter structural validator
// ---------------------------------------------------------------------------

/**
 * Structural validator for Agent C's narrative output.
 *
 * Checks the post-stream segment tree for:
 *   1. every claim segment has ≥1 citing_events,
 *   2. every claim's citing_events are within the activity's
 *      clustered_events (in-scope citations),
 *   3. each section has at least `minClaimCountPerSection` claim
 *      segments (per spec: minimum claim density is a structural
 *      audit requirement, not a stylistic preference).
 *
 * Returns the boolean verdict plus a list of human-readable reasons.
 * `valid` is true iff `reasons` is empty.
 *
 * The function does NOT enforce a maximum claim count or any minimum
 * prose count: those are stylistic and live elsewhere.
 */
export function validateNarrativeStructure(
  sections: Record<string, NarrativeSegment[]>,
  clusteredEventIds: ReadonlySet<string>,
  minClaimCountPerSection: number,
): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const [sectionKind, segments] of Object.entries(sections)) {
    let claimCount = 0;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (!seg) continue; // noUncheckedIndexedAccess guard
      if (seg.type !== 'claim') continue;
      claimCount += 1;
      if (!seg.citing_events || seg.citing_events.length === 0) {
        reasons.push(`section ${sectionKind} segment ${i}: claim has no citing_events`);
        continue;
      }
      for (const eventId of seg.citing_events) {
        if (!clusteredEventIds.has(eventId)) {
          reasons.push(`section ${sectionKind} segment ${i}: cites out-of-scope event ${eventId}`);
        }
      }
    }
    if (claimCount < minClaimCountPerSection) {
      reasons.push(
        `section ${sectionKind}: ${claimCount} claim(s) < required ${minClaimCountPerSection}`,
      );
    }
  }
  return { valid: reasons.length === 0, reasons };
}
