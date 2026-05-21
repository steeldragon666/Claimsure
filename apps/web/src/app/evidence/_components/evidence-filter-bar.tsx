'use client';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';
import { EVIDENCE_FEED_KINDS, type EvidenceFeedKind } from '@cpa/schemas';
import { cn } from '@/lib/utils';

/**
 * Human-readable labels for evidence kinds.
 *
 * Replaces SCREAMING_SNAKE with sentence case. If a kind isn't in this
 * map it falls through to the raw value (defensive for future additions).
 */
const KIND_LABELS: Record<EvidenceFeedKind, string> = {
  HYPOTHESIS: 'Hypothesis',
  DESIGN: 'Design',
  EXPERIMENT: 'Experiment',
  OBSERVATION: 'Observation',
  ITERATION: 'Iteration',
  NEW_KNOWLEDGE: 'New Knowledge',
  UNCERTAINTY: 'Uncertainty',
  TIME_LOG: 'Time Log',
  ASSOCIATE_FLAG: 'Associate Flag',
  EXPENDITURE_NOTE: 'Expenditure Note',
  SUPPORTING: 'Supporting',
  INELIGIBLE: 'Ineligible',
  EVIDENCE_UPLOADED: 'Upload',
};

export interface EvidenceFilterBarProps {
  /** Currently active kind filters (undefined = all). */
  activeKinds: EvidenceFeedKind[] | undefined;
}

/**
 * Filter chip strip for the /evidence feed.
 *
 * URL is the source of truth. Clicking a chip toggles its kind in/out
 * of the `?kinds=` CSV param. When all or none are selected, the param
 * is omitted (= show everything).
 *
 * Mirrors the toggle-button pattern in pipeline-filters.tsx.
 */
export function EvidenceFilterBar({ activeKinds }: EvidenceFilterBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const showAll = activeKinds === undefined;

  const onToggleKind = useCallback(
    (kind: EvidenceFeedKind) => {
      const params = new URLSearchParams(searchParams.toString());
      const current = activeKinds ?? [];
      let next: EvidenceFeedKind[];

      if (current.includes(kind)) {
        // Deselect: remove this kind.
        next = current.filter((k) => k !== kind);
      } else {
        // Select: add this kind.
        next = [...current, kind];
      }

      // If all kinds are selected (or none remain), clear the param.
      if (next.length === 0 || next.length === EVIDENCE_FEED_KINDS.length) {
        params.delete('kinds');
      } else {
        params.set('kinds', next.join(','));
      }

      // Reset cursor when filters change — stale cursor from a
      // different result set would produce wrong/empty pages.
      params.delete('cursor');

      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [activeKinds, pathname, router, searchParams],
  );

  return (
    <fieldset>
      <legend className="mb-2 text-xs font-medium text-muted-foreground">Evidence kinds</legend>
      <div className="flex flex-wrap gap-2">
        {EVIDENCE_FEED_KINDS.map((kind) => {
          const isActive = showAll || (activeKinds?.includes(kind) ?? false);
          return (
            <button
              key={kind}
              type="button"
              aria-pressed={isActive}
              aria-label={KIND_LABELS[kind]}
              onClick={() => onToggleKind(kind)}
              className={cn(
                'inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                isActive
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-input bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              )}
            >
              {KIND_LABELS[kind]}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
