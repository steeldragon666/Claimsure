import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Design system signature component — YearMarker.
 *
 * Column header for the multi-cycle timeline. Uses Fraunces display-md
 * to give the timeline an editorial-archive feel (not a Gantt chart).
 *
 * Format: "FY24", "FY25", "FY26"
 * States:
 *   current — patina underline (the active fiscal year)
 *   past    — default (full opacity, ink primary)
 *   future  — ink-subtle, dashed hairline below
 *
 * See docs/design/system.md §"Year-marker (multi-cycle timeline)".
 */

export type YearMarkerState = 'current' | 'past' | 'future';

export interface YearMarkerProps {
  /** Format: "FY" + 2-digit year suffix (e.g. "FY24"). */
  fyLabel: string;
  /** Visual state. Default: 'past'. */
  state?: YearMarkerState;
  className?: string;
}

// ---------- Pure helper ----------

const FY_LABEL_PATTERN = /^FY\d{2}$/;

export function isValidFYLabel(label: string): boolean {
  return FY_LABEL_PATTERN.test(label);
}

// ---------- Component ----------

const stateStyles: Record<YearMarkerState, string> = {
  current: 'text-[hsl(var(--brand-ink))] border-b-2 border-[hsl(var(--brand-accent))] pb-1',
  past: 'text-[hsl(var(--brand-ink))] border-b border-[hsl(var(--brand-hairline))] pb-1',
  future:
    'text-[hsl(var(--brand-ink-subtle))] border-b border-dashed border-[hsl(var(--brand-hairline))] pb-1',
};

export function YearMarker({ fyLabel, state = 'past', className }: YearMarkerProps) {
  if (!isValidFYLabel(fyLabel)) {
    // Defensive: surface bad data rather than render "FY????" garbage.
    // YearMarker is consumed by consultant-facing timeline UI; bad input
    // means upstream data drift that needs to be fixed at source.
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`YearMarker: invalid fyLabel "${fyLabel}" — expected /^FY\\d{2}$/`);
    }
  }

  return (
    <span
      className={cn(
        // Fraunces display-md per scale: 24px, weight 600, tracking -0.01em
        'font-display text-2xl font-semibold tracking-tight',
        stateStyles[state],
        className,
      )}
      data-state={state}
    >
      {fyLabel}
    </span>
  );
}
