'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Design system signature component — TransitionBadge.
 *
 * Multi-cycle timeline gutter badge. Communicates how an activity
 * evolved between reporting periods (FY24 → FY25 etc). Renders in the
 * vertical gutter between year-marker columns.
 *
 * Variants:
 *   continuation — patina (the activity continues as-is)
 *   pivot        — terracotta (the activity changed direction)
 *   completion   — slate (the activity reached its end state)
 *   abandoned    — transparent + dashed border (the activity stopped)
 *
 * Visual: pill, accent-subtle background per variant, mono-sm font
 *
 * Behavior: hover reveals transition_rationale (capped to schema limit
 * of 500 chars; longer rationales are truncated with an ellipsis here
 * — full text remains in DB and is visible in the activity detail page).
 *
 * See docs/design/system.md §"Transition badge (multi-cycle timeline)".
 */

export type TransitionVariant = 'continuation' | 'pivot' | 'completion' | 'abandoned';

/** Schema cap matches narrative_segment.transition_rationale max_length. */
export const TRANSITION_RATIONALE_MAX_CHARS = 500;

export interface TransitionBadgeProps {
  variant: TransitionVariant;
  /** Short visible label (e.g. "Continuation", "Pivot"). */
  label: string;
  /** Optional rationale shown on hover. Truncated to schema cap. */
  rationale?: string;
  className?: string;
}

// ---------- Pure helper ----------

export function truncateRationale(text: string): string {
  if (text.length <= TRANSITION_RATIONALE_MAX_CHARS) return text;
  // Reserve 1 char for the ellipsis so total stays at exactly the cap.
  return text.slice(0, TRANSITION_RATIONALE_MAX_CHARS - 1) + '…';
}

// ---------- Component ----------

const variantStyles: Record<TransitionVariant, string> = {
  // Backgrounds + text follow the design tokens. Border included where
  // the variant requires a visual rule (abandoned uses dashed).
  continuation:
    'bg-[hsl(var(--brand-accent-subtle))] text-[hsl(var(--brand-accent-strong))] border border-[hsl(var(--brand-accent))]',
  pivot:
    // Terracotta: warning token from globals.css
    'bg-[#F5E4D5] text-[hsl(var(--brand-warning))] border border-[hsl(var(--brand-warning))]',
  completion: 'bg-[#E1E5EB] text-[hsl(var(--brand-info))] border border-[hsl(var(--brand-info))]',
  abandoned:
    'bg-transparent text-[hsl(var(--brand-ink-muted))] border border-dashed border-[hsl(var(--brand-ink-subtle))]',
};

export function TransitionBadge({ variant, label, rationale, className }: TransitionBadgeProps) {
  const truncated = rationale ? truncateRationale(rationale) : undefined;

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full font-mono text-xs px-2 py-0.5 tabular-nums',
        variantStyles[variant],
        className,
      )}
      title={truncated}
      data-variant={variant}
    >
      {label}
    </span>
  );
}
