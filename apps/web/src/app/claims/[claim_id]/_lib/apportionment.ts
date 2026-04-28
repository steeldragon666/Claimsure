/**
 * Apportionment helpers — pure logic for the C6 dialog.
 *
 * UX (P4 plan §C6): a single Xero expenditure can be split across
 * multiple activities by percentage (e.g. "$5,000 invoice = 60% CA-001
 * + 40% CA-002"). This module provides the pure helpers the dialog uses
 * for validation, percentage→amount conversion, and seeding default
 * allocations as the user adds rows. The React component lives in
 * `_components/expenditure-apportion-dialog.tsx`.
 *
 * Architecture context (controller decision, P4 plan §C6):
 *
 *   Apportionment persistence will be event-sourced via a new
 *   `EXPENDITURE_APPORTIONED` event added by A-swimlane. C6 ships UI
 *   only — the stub in `./api.ts` documents the planned wire format.
 *   The composition rules (line > apportionment > parent) are
 *   documented in `./expenditure-projection.ts`.
 *
 * Design call (controller, see commit message): independent sliders,
 * NOT linked. Each row has its own percentage input + slider; the user
 * is responsible for hitting 100%. The submit button is disabled until
 * the sum equals 100% (within tolerance), which gives clear feedback
 * without producing the "stuck-at-zero / proportional creep" footguns
 * of linked sliders.
 */
import type { Uuid } from '@cpa/schemas';

/**
 * UX cap on allocation rows. Five is a deliberate limit — the dialog is
 * for "split a single invoice across a handful of activities", not for
 * arbitrary tagging. Beyond ~5 splits the consultant is better served
 * by re-issuing the invoice as line items (which the F5 line-mapped
 * surface handles separately). Adjusting the cap is a one-line change
 * if the workflow proves we need more.
 */
export const MAX_ALLOCATIONS = 5;

/**
 * Min rows. Rendering a dialog with zero rows is meaningless (there's
 * nothing to validate); the dialog seeds with one row at 100% on open.
 */
export const MIN_ALLOCATIONS = 1;

/**
 * Float-equality tolerance for the "sum = 100%" check. Percentages flow
 * through string<->number conversions in the input, so an exact equality
 * test would reject e.g. 33.333 + 33.333 + 33.334 (which sums to
 * 100.00000000000001 in IEEE-754). 0.001 (one-thousandth of a percent)
 * is generous enough to absorb the float drift while still rejecting any
 * meaningful under/over-allocation.
 *
 * The future server-side endpoint should use the same tolerance so the
 * client-side disabled-submit and the server-side reject align — see
 * the JSDoc on `apportionExpenditure` in `./api.ts`.
 */
export const SUM_TOLERANCE = 0.001;

/** Target sum for a valid apportionment. 100% by definition. */
export const TARGET_SUM = 100;

/**
 * One row in the dialog's allocation list. The activity picker is
 * unselected at row creation time (`activity_id` is the empty string),
 * which doubles as the "no activity yet" sentinel the submit-disabled
 * check looks for. Using a literal '' instead of undefined matches the
 * existing Radix Select convention (the Select onValueChange always
 * fires with a string).
 *
 * `activity_id` is typed as `string` rather than `Uuid | ''` because
 * `Uuid` is just an alias for `string` at the type level (the v4 regex
 * only runs at the API boundary — see `packages/schemas/src/primitives.ts`).
 * The empty-string sentinel is documented here and enforced via the
 * `allActivitiesPicked` helper.
 *
 * `percentage` is a number rather than a string because the dialog
 * keeps two parallel inputs (number input + range slider) writing to
 * the same value, and stringly-typing it forces a parse on every
 * render of the slider position. The dialog component holds an
 * additional string buffer for the in-flight typed value (so the user
 * can clear and retype "60") but the canonical state is the number.
 */
export interface Allocation {
  /** Empty string = "no activity picked yet". Otherwise an Activity.id. */
  activity_id: string;
  /**
   * 0-100, may be fractional. The dialog renders both a number input
   * (step 0.01) and a range slider (step 0.01) writing to this; the two
   * step-values match deliberately so dragging the slider after typing
   * a fractional value (e.g. 33.33) doesn't snap it to a coarser grid.
   */
  percentage: number;
}

/**
 * Submission shape — the dialog's onSubmit callback gets this. Mirrors
 * the planned `apportionExpenditure(expenditureId, allocations)` API
 * signature; all activity_ids are guaranteed populated (the submit
 * button is disabled until they are) and the sum is within
 * SUM_TOLERANCE of 100.
 *
 * `Uuid` is preserved here (rather than `string`) so the type signals
 * "this is API-bound and the v4 regex will run on it" — purely a
 * documentation aid; the runtime is identical.
 */
export interface ValidatedAllocation {
  activity_id: Uuid;
  percentage: number;
}

// ---------------------------------------------------------------------------
// Default-allocation logic
// ---------------------------------------------------------------------------

/**
 * Seed the dialog's initial state. A single row at 100% — the user
 * either commits to single-activity (in which case they could have
 * used the C5 single-Select picker instead — but the dialog still
 * works) or clicks "Add allocation" to split.
 */
export function makeInitialAllocations(): Allocation[] {
  return [{ activity_id: '', percentage: 100 }];
}

/**
 * Compute the default percentage for a freshly-added row.
 *
 * Strategy: take half of whatever's in the row that's currently the
 * largest, give half to the new row, and leave the donor at the smaller
 * half. Exception — if every existing row already sums to ≥100, the new
 * row enters at 0% so the user has to manually rebalance (the alternative,
 * pulling from rows the user has already balanced, is more disruptive).
 *
 * Rationale: the alternatives all have worse failure modes:
 *   - "always 0%" — the user MUST type a number into both the new row
 *     AND a donor row, which is two interactions for the common
 *     "actually it's 50/50" case.
 *   - "equal split" (rebalance every row to 1/N) — destroys the user's
 *     prior typing on every Add. Frustrating during careful balancing.
 *   - "remaining = 100 - sum" — only works if the user is already
 *     under 100; if they're at exactly 100 (the natural state before
 *     Add) the new row gets 0 and we're back to alternative #1.
 *
 * The "split largest" heuristic preserves prior typing on all rows
 * EXCEPT the donor, and the donor is the one row most likely to be
 * "the placeholder" anyway. Documented here because it's an arbitrary
 * call and a future reader will want to know why.
 *
 * Returns BOTH the new row's percentage AND the index of the donor
 * (so the caller can update the donor's percentage in lockstep).
 * Returns donor_index=-1 when no donor was selected (current sum is
 * already at-or-over 100, so the new row enters at 0%).
 */
export function computeNewRowDefault(existing: ReadonlyArray<Allocation>): {
  percentage: number;
  donor_index: number;
  donor_new_percentage: number;
} {
  // Edge case: no rows. Shouldn't happen — the dialog always seeds with
  // one row — but defending against it keeps the helper composable.
  if (existing.length === 0) {
    return { percentage: 100, donor_index: -1, donor_new_percentage: 0 };
  }

  const currentSum = existing.reduce((s, a) => s + a.percentage, 0);
  if (currentSum >= TARGET_SUM - SUM_TOLERANCE) {
    // Already at-or-above target — find the largest donor.
    let maxIdx = 0;
    let maxVal = existing[0]?.percentage ?? 0;
    for (let i = 1; i < existing.length; i += 1) {
      const p = existing[i]?.percentage ?? 0;
      if (p > maxVal) {
        maxVal = p;
        maxIdx = i;
      }
    }
    if (maxVal <= 0) {
      // Pathological — sum hit 100 via tolerance noise but no row has
      // any percentage to donate. Bail out at 0% and let the user
      // rebalance manually rather than picking arbitrarily.
      return { percentage: 0, donor_index: -1, donor_new_percentage: 0 };
    }
    const half = maxVal / 2;
    return {
      percentage: half,
      donor_index: maxIdx,
      donor_new_percentage: maxVal - half,
    };
  }

  // Sum is under target — give the new row the gap to 100, no donor
  // needed. This is the path users hit if they explicitly under-allocated
  // (e.g. typed 60 into row 1 then clicked Add expecting "the rest").
  return {
    percentage: TARGET_SUM - currentSum,
    donor_index: -1,
    donor_new_percentage: 0,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Sum the allocations' percentages. Pulled out so the dialog can render
 * the running total below the rows even when the value is invalid (e.g.
 * 87% — show "Total: 87% / 100%" in red).
 */
export function sumPercentages(allocations: ReadonlyArray<Allocation>): number {
  return allocations.reduce((s, a) => s + a.percentage, 0);
}

/**
 * Check that every row has an activity selected. Pulled out so the
 * dialog can show the "missing activity" footer message distinctly from
 * the "wrong sum" message.
 */
export function allActivitiesPicked(allocations: ReadonlyArray<Allocation>): boolean {
  return allocations.every((a) => a.activity_id !== '');
}

/**
 * Check that every row has a strictly positive percentage. Zero-percent
 * rows are nonsensical (they don't allocate anything) and the future
 * server-side endpoint will reject them — see `apportionExpenditure`
 * JSDoc. Equivalent to "every row contributes some money".
 *
 * Note: we use `> 0` not `>= SUM_TOLERANCE`. A row at e.g. 0.0005 is
 * weird but technically permitted; rejecting it would force users to
 * either delete the row or bump it to a meaningful number. The intent
 * is to reject the obvious "added a row and forgot to fill it" case,
 * which always shows up as 0 (or NaN — see `isValidAllocationSet`).
 */
export function allPercentagesPositive(allocations: ReadonlyArray<Allocation>): boolean {
  return allocations.every((a) => Number.isFinite(a.percentage) && a.percentage > 0);
}

/**
 * Check that the sum is within tolerance of 100%. Wraps the float
 * comparison so the dialog and the test suite agree on what "100%"
 * means.
 */
export function sumIsValid(allocations: ReadonlyArray<Allocation>): boolean {
  const sum = sumPercentages(allocations);
  return Math.abs(sum - TARGET_SUM) <= SUM_TOLERANCE;
}

/**
 * The composite check the submit button uses. Returns true iff every
 * row has an activity, every row has a positive percentage, and the
 * sum is within tolerance of 100. Pure — no side effects — so the
 * dialog can call it on every render.
 *
 * Doesn't enforce uniqueness of activity_ids — duplicate picks (the
 * same activity in two rows) are technically permitted and would just
 * mean "this expenditure is 60% + 40% to the same activity = 100% to
 * that activity". Weird but harmless. The dialog could surface a
 * "duplicate activity" warning later if it proves to be a footgun, but
 * it's not a hard rejection.
 */
export function isValidAllocationSet(allocations: ReadonlyArray<Allocation>): boolean {
  if (allocations.length < MIN_ALLOCATIONS) return false;
  if (allocations.length > MAX_ALLOCATIONS) return false;
  if (!allActivitiesPicked(allocations)) return false;
  if (!allPercentagesPositive(allocations)) return false;
  if (!sumIsValid(allocations)) return false;
  return true;
}

/**
 * Narrow Allocation[] -> ValidatedAllocation[] for the API call. The
 * dialog calls `isValidAllocationSet` first; this just refines the type
 * (and re-checks defensively). Throws if called on an invalid set —
 * the caller should never see that, but it's a louder failure than
 * silently corrupting data.
 */
export function toValidatedAllocations(
  allocations: ReadonlyArray<Allocation>,
): ValidatedAllocation[] {
  if (!isValidAllocationSet(allocations)) {
    throw new Error('toValidatedAllocations called on invalid set');
  }
  return allocations.map((a) => ({
    // a.activity_id is `string`; ValidatedAllocation typing wants `Uuid`,
    // which is just a `string` alias at the type level — the assignment
    // is structurally compatible without a cast.
    activity_id: a.activity_id,
    percentage: a.percentage,
  }));
}

// ---------------------------------------------------------------------------
// Percentage <-> amount
// ---------------------------------------------------------------------------

/**
 * Compute the per-allocation amount as a numeric value. The total amount
 * arrives as the N.NN string from `ExpenditureRow.amount` (postgres
 * NUMERIC(12,2)); we parse it once, multiply, and let the caller format.
 *
 * Returns NaN if the total can't be parsed — the caller (the dialog
 * row) shows "—" or the raw string in that case rather than a NaN
 * label. Mirrors the defensive fallback in `formatAmount`.
 */
export function computeAllocationAmount(totalAmount: string, percentage: number): number {
  const total = Number(totalAmount);
  if (!Number.isFinite(total)) return NaN;
  if (!Number.isFinite(percentage)) return NaN;
  return (total * percentage) / 100;
}

/**
 * Clamp a typed percentage into [0, 100]. The number input has min/max
 * attributes but pasting a value bypasses them in some browsers, and
 * the slider's range is also [0, 100] so any out-of-range typed value
 * desyncs the two inputs. Centralised here so both write paths agree.
 *
 * NaN returns 0 — the user typed something that doesn't parse, treat
 * it as "nothing yet" rather than leaving a poison value in the state.
 * +/-Infinity clamp to the range edges; pasting "1e308" produces
 * +Infinity in some browsers and snapping to 100 is the
 * least-surprising outcome (the slider would also pin to its max).
 */
export function clampPercentage(p: number): number {
  if (Number.isNaN(p)) return 0;
  if (p < 0) return 0;
  if (p > 100) return 100;
  return p;
}
