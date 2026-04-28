'use client';
import { useEffect, useMemo, useState } from 'react';
import type { Activity } from '@cpa/schemas';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  clampPercentage,
  computeAllocationAmount,
  computeNewRowDefault,
  isValidAllocationSet,
  makeInitialAllocations,
  MAX_ALLOCATIONS,
  sumIsValid,
  sumPercentages,
  TARGET_SUM,
  toValidatedAllocations,
  type Allocation,
  type ValidatedAllocation,
} from '../_lib/apportionment';
import { formatAmount, type ExpenditureKind, type ExpenditureRow } from '../_lib/expenditure-stub';

/**
 * Apportionment dialog (P4 plan §C6).
 *
 * Splits a single expenditure across multiple activities by percentage.
 * Up to MAX_ALLOCATIONS rows; each row has an Activity Select, a numeric
 * percentage input, a native `<input type="range">` slider, a computed
 * amount label, and (when ≥2 rows exist) a remove button.
 *
 * Design call (controller, see commit message): independent sliders, NOT
 * linked. Each row's slider only writes to its own row. Validity is
 * surfaced via the running-total indicator + the disabled submit button.
 *
 * State strategy:
 *   - Canonical state is `Allocation[]` keyed positionally (no row IDs
 *     are needed; React's index-based keys are fine because rows can
 *     only be added at the end or removed in-place — there's no
 *     re-ordering UI).
 *   - Per-row "in-flight typed value" is held in a parallel string map
 *     (`pctTextById`) keyed by row index. This lets the user clear and
 *     retype "60" without the canonical numeric state flickering through
 *     `0` between keystrokes. On blur or commit, the string is parsed,
 *     clamped, and merged back into the canonical state. Same idiom as
 *     the C5 expenditure-row's optimistic mirror.
 *   - The dialog resets state on `open` toggling true (so re-opening
 *     after a Cancel always starts fresh — no stale allocations from
 *     last time).
 *
 * The `submitting` flag disables submit/cancel during the in-flight
 * mutation; the parent owns the actual API call (via onSubmit) and the
 * optimistic update of the row in the list.
 */

const KIND_LABELS: Record<ExpenditureKind, string> = {
  INVOICE: 'Invoice',
  BANK_TX: 'Bank tx',
  RECEIPT: 'Receipt',
};

const KIND_STYLES: Record<ExpenditureKind, string> = {
  INVOICE: 'bg-blue-50 text-blue-700 border-blue-200',
  BANK_TX: 'bg-amber-50 text-amber-700 border-amber-200',
  RECEIPT: 'bg-violet-50 text-violet-700 border-violet-200',
};

export interface ExpenditureApportionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The expenditure being apportioned (header summary + amount math). */
  row: ExpenditureRow;
  /** Activities the user can pick from — same list as the C5 single-Select picker. */
  activities: ReadonlyArray<Activity>;
  /**
   * Submit handler. Returns a promise so the dialog can show a "submitting"
   * state and close on success. Throwing / rejecting keeps the dialog
   * open — the parent surfaces the error via toast and the user can fix
   * the allocations and retry.
   */
  onSubmit: (allocations: ValidatedAllocation[]) => Promise<void>;
}

export function ExpenditureApportionDialog({
  open,
  onOpenChange,
  row,
  activities,
  onSubmit,
}: ExpenditureApportionDialogProps) {
  // Canonical allocation state. Reset on every open transition so a
  // cancelled session doesn't bleed into the next one.
  const [allocations, setAllocations] = useState<Allocation[]>(makeInitialAllocations);
  // Per-row in-flight typed string. Keyed by row index — when a row is
  // removed, the keys are remapped (clearing this on remove is the
  // simplest way to keep the input controlled-ness honest).
  const [pctTextById, setPctTextById] = useState<Record<number, string>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      // Fresh seed on every open. Closing-with-Cancel doesn't fire this
      // because `open` is going false; reopening is when we reset.
      setAllocations(makeInitialAllocations());
      setPctTextById({});
      setSubmitting(false);
    }
  }, [open]);

  const sum = useMemo(() => sumPercentages(allocations), [allocations]);
  const submitEnabled = useMemo(() => isValidAllocationSet(allocations), [allocations]);
  const sumOk = useMemo(() => sumIsValid(allocations), [allocations]);

  // Activity ids that appear in more than one allocation row. Surfaced
  // as a soft warning footer — submit stays enabled because the math is
  // correct (60% + 40% to the same activity = 100% to that activity)
  // and the controller chose to preserve user agency. The warning makes
  // the redundancy visible without blocking. Empty rows (activity_id
  // === '') are excluded; those are flagged separately by the
  // submit-disabled gate.
  const duplicateActivityIds = useMemo(() => {
    const seen = new Map<string, number>();
    for (const a of allocations) {
      if (a.activity_id) {
        seen.set(a.activity_id, (seen.get(a.activity_id) ?? 0) + 1);
      }
    }
    const dupes: string[] = [];
    for (const [id, count] of seen) {
      if (count > 1) dupes.push(id);
    }
    return dupes;
  }, [allocations]);

  // Add-row enabled when below the cap. The dialog never lets the user
  // cross MAX_ALLOCATIONS — disabling the button is the simplest UX
  // (alternative: hide the button at cap; disabled is more discoverable).
  const canAddRow = allocations.length < MAX_ALLOCATIONS;
  // Remove enabled per-row when there are at least 2 rows. Hiding the
  // button at minimum-rows would be jankier than disabling because the
  // row layout would shift.
  const canRemove = allocations.length > 1;

  const updateAllocation = (index: number, patch: Partial<Allocation>): void => {
    setAllocations((prev) => prev.map((a, i) => (i === index ? { ...a, ...patch } : a)));
  };

  const setPercentageNumber = (index: number, p: number): void => {
    const clamped = clampPercentage(p);
    updateAllocation(index, { percentage: clamped });
    // Clear the text buffer for this row — the canonical numeric is
    // now authoritative until the user starts typing again.
    setPctTextById((prev) => {
      if (prev[index] === undefined) return prev;
      const next = { ...prev };
      delete next[index];
      return next;
    });
  };

  const onTypePercentage = (index: number, raw: string): void => {
    // Hold the raw string so the input is controlled to the user's
    // exact keystrokes — empty, leading dot, partial decimal etc.
    setPctTextById((prev) => ({ ...prev, [index]: raw }));
    // Try to parse-and-commit live. Empty / non-numeric stays in the
    // text buffer until blur (where we coerce to 0).
    const trimmed = raw.trim();
    if (trimmed === '') {
      // Don't commit a parse — leave the canonical value alone and let
      // the buffer drive the rendered string. On blur we'll clamp 0.
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return;
    updateAllocation(index, { percentage: clampPercentage(n) });
  };

  const onBlurPercentage = (index: number): void => {
    // Coerce the buffer to a real number on blur so typing "" then
    // tabbing away doesn't leave a poisoned text buffer over a stale
    // canonical value.
    const raw = pctTextById[index];
    if (raw === undefined) return;
    const trimmed = raw.trim();
    const n = trimmed === '' ? 0 : Number(trimmed);
    setPercentageNumber(index, Number.isFinite(n) ? n : 0);
  };

  const onSliderInput = (index: number, raw: string): void => {
    // Slider always emits a finite, in-range number string (0-100). We
    // still pipe through clampPercentage for paranoia.
    const n = Number(raw);
    setPercentageNumber(index, Number.isFinite(n) ? n : 0);
  };

  const onAddAllocation = (): void => {
    if (!canAddRow) return;
    setAllocations((prev) => {
      const def = computeNewRowDefault(prev);
      const next = prev.map((a, i) =>
        i === def.donor_index ? { ...a, percentage: def.donor_new_percentage } : a,
      );
      next.push({ activity_id: '', percentage: def.percentage });
      return next;
    });
    // The donor row's text buffer (if any) now contradicts the canonical
    // value — clear it so the input rerenders from the canonical number.
    setPctTextById({});
  };

  const onRemoveAllocation = (index: number): void => {
    if (!canRemove) return;
    setAllocations((prev) => prev.filter((_, i) => i !== index));
    // Indices shift after a removal — drop the entire text buffer rather
    // than trying to remap. The user's other rows re-render from the
    // canonical numbers, which is correct.
    setPctTextById({});
  };

  const handleSubmit = async (): Promise<void> => {
    if (!submitEnabled) return; // belt-and-braces — submit is also disabled visually
    setSubmitting(true);
    try {
      const validated = toValidatedAllocations(allocations);
      await onSubmit(validated);
      onOpenChange(false);
    } catch {
      // Parent surfaces the error via toast; keep dialog open so the
      // user can adjust and retry. Reset the submitting flag so Cancel
      // and Submit are interactive again.
      setSubmitting(false);
    }
  };

  const sumLabel = `Total: ${formatPercent(sum)}% / ${TARGET_SUM}%`;
  const sumDelta = sum - TARGET_SUM;

  return (
    <Dialog open={open} onOpenChange={(o) => !submitting && onOpenChange(o)}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Apportion expenditure across activities</DialogTitle>
          <DialogDescription>
            Split this expenditure into up to {MAX_ALLOCATIONS} parts. Percentages must total{' '}
            {TARGET_SUM}%.
          </DialogDescription>
        </DialogHeader>

        {/* Header: expenditure summary */}
        <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/40 px-4 py-3 text-sm">
          <span
            className={cn(
              'inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium uppercase tracking-wide',
              KIND_STYLES[row.kind],
            )}
          >
            {KIND_LABELS[row.kind]}
          </span>
          <span className="font-medium">{row.payee}</span>
          <span className="ml-auto tabular-nums font-mono">
            {formatAmount(row.amount, row.currency)}
          </span>
        </div>

        {/* Allocation rows */}
        <div className="space-y-3">
          {allocations.map((a, i) => {
            const renderedPctText =
              pctTextById[i] !== undefined ? pctTextById[i] : formatPercent(a.percentage);
            const allocAmount = computeAllocationAmount(row.amount, a.percentage);
            const allocAmountLabel = Number.isFinite(allocAmount)
              ? formatAmount(allocAmount.toFixed(2), row.currency)
              : '—';
            return (
              <div
                key={i}
                className="grid grid-cols-12 gap-2 items-center rounded-md border p-3"
                data-allocation-index={i}
              >
                {/* Activity picker */}
                <div className="col-span-12 sm:col-span-4">
                  <Label htmlFor={`alloc-activity-${i}`} className="text-xs text-muted-foreground">
                    Activity
                  </Label>
                  <Select
                    value={a.activity_id}
                    onValueChange={(v) => updateAllocation(i, { activity_id: v })}
                  >
                    <SelectTrigger id={`alloc-activity-${i}`} className="h-8">
                      <SelectValue placeholder="Choose…" />
                    </SelectTrigger>
                    <SelectContent>
                      {activities.length === 0 ? (
                        <SelectItem value="__none__" disabled>
                          No activities yet
                        </SelectItem>
                      ) : (
                        activities.map((act) => (
                          <SelectItem key={act.id} value={act.id}>
                            <span className="font-mono text-xs">{act.code}</span>{' '}
                            <span>{act.title}</span>
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                </div>

                {/* Percentage input */}
                <div className="col-span-4 sm:col-span-2">
                  <Label htmlFor={`alloc-pct-${i}`} className="text-xs text-muted-foreground">
                    %
                  </Label>
                  <Input
                    id={`alloc-pct-${i}`}
                    type="number"
                    min={0}
                    max={100}
                    step={0.01}
                    className="h-8 tabular-nums"
                    value={renderedPctText}
                    onChange={(e) => onTypePercentage(i, e.target.value)}
                    onBlur={() => onBlurPercentage(i)}
                  />
                </div>

                {/* Slider — mirrors the percentage input bidirectionally. */}
                <div className="col-span-8 sm:col-span-3 flex flex-col gap-1">
                  <Label htmlFor={`alloc-slider-${i}`} className="text-xs text-muted-foreground">
                    Slider
                  </Label>
                  <input
                    id={`alloc-slider-${i}`}
                    type="range"
                    min={0}
                    max={100}
                    // Slider step matches the percentage input's step
                    // (0.01) so dragging the slider after typing 33.33
                    // doesn't snap the value to 33.5 — fine-grained
                    // movement keeps the two inputs in lock-step. The
                    // input remains the authoritative way to type
                    // arbitrary values; the slider is for visual /
                    // approximate adjustment.
                    step={0.01}
                    value={a.percentage}
                    onChange={(e) => onSliderInput(i, e.target.value)}
                    className="h-8 w-full cursor-pointer accent-emerald-600"
                    aria-label={`Allocation ${i + 1} percentage`}
                  />
                </div>

                {/* Amount label */}
                <div className="col-span-8 sm:col-span-2 flex flex-col">
                  <span className="text-xs text-muted-foreground">Amount</span>
                  <span className="tabular-nums font-mono text-sm">{allocAmountLabel}</span>
                </div>

                {/* Remove button */}
                <div className="col-span-4 sm:col-span-1 flex sm:justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={!canRemove || submitting}
                    onClick={() => onRemoveAllocation(i)}
                    aria-label={`Remove allocation ${i + 1}`}
                  >
                    Remove
                  </Button>
                </div>
              </div>
            );
          })}

          <div className="flex items-center justify-between pt-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onAddAllocation}
              disabled={!canAddRow || submitting}
            >
              {canAddRow ? 'Add allocation' : `Maximum of ${MAX_ALLOCATIONS} reached`}
            </Button>
            {/* Sum indicator. Green at 100%, red otherwise — colour cue
                augments the disabled-submit so the failure mode is obvious. */}
            <div
              className={cn(
                'rounded-md px-3 py-1 text-xs font-medium tabular-nums',
                sumOk ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700',
              )}
              role="status"
              aria-live="polite"
            >
              {sumLabel}
              {!sumOk && (
                <span className="ml-2 text-[11px] opacity-80">
                  ({sumDelta > 0 ? '+' : ''}
                  {formatPercent(sumDelta)})
                </span>
              )}
            </div>
          </div>

          {/* Soft warning when multiple rows target the same activity.
              The math is correct (60% + 40% to the same activity = 100%
              to that activity) and the controller chose to preserve user
              agency, so submit stays enabled — this footer makes the
              redundancy visible without blocking. */}
          {duplicateActivityIds.length > 0 && (
            <div
              className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
              role="status"
              aria-live="polite"
            >
              <span className="font-medium">Note:</span>{' '}
              {duplicateActivityIds.length === 1
                ? 'Multiple rows target the same activity. Consider consolidating into one row.'
                : `Multiple rows target ${duplicateActivityIds.length} activities. Consider consolidating.`}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!submitEnabled || submitting}
          >
            {submitting ? 'Submitting…' : 'Apportion'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Render a number as a percentage string with up to 2dp, trimming
 * trailing zeros. The dialog wants "60%" not "60.00%" but also wants
 * "33.33%" not "33.330%" — Intl is overkill for this and the manual
 * trim is one line. Defended against NaN by the upstream clamp; if
 * something slips through we render "0".
 */
function formatPercent(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const rounded = Math.round(n * 100) / 100;
  // toFixed(2).replace(/\.?0+$/, '') trims trailing zeros and the
  // dangling dot. "100.00" -> "100"; "33.30" -> "33.3"; "33.33" -> "33.33".
  return rounded.toFixed(2).replace(/\.?0+$/, '');
}
