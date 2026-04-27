import { cn } from '@/lib/utils';

/**
 * Renders a small chip showing the classifier's confidence:
 *
 *   - isOverridden=true → "verified" pill (consultant has audited this)
 *   - value null/undefined → em dash placeholder (e.g. OVERRIDE rows)
 *   - value < threshold → "65% (review)" red pill
 *   - value >= threshold → "85%" muted pill
 *
 * Threshold defaults to 0.7 — matches the API's needs_review filter
 * predicate (apps/api/src/routes/events.ts uses < 0.7).
 */
export interface ConfidenceChipProps {
  value: number | null | undefined;
  isOverridden?: boolean;
  threshold?: number;
}

export function ConfidenceChip({
  value,
  isOverridden = false,
  threshold = 0.7,
}: ConfidenceChipProps) {
  if (isOverridden) {
    return (
      <span
        data-testid="overridden-badge"
        className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700"
      >
        verified
      </span>
    );
  }
  if (value == null) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const pct = Math.round(value * 100);
  const lowConfidence = value < threshold;
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
        lowConfidence
          ? 'border-red-200 bg-red-50 text-red-700'
          : 'border-slate-200 bg-slate-50 text-slate-700',
      )}
    >
      {pct}%{lowConfidence ? ' (review)' : ''}
    </span>
  );
}
