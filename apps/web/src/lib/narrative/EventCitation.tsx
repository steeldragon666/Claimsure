import { cn } from '@/lib/utils';

/**
 * Per-event metadata the citation card needs. Kept structural (not a
 * direct re-export of `@cpa/schemas`'s `Event`) so the component
 * stays consumable from server-rendered narrative pages without
 * pulling the full Zod-inferred event shape — the parent route
 * loads the canonical events server-side and projects them into
 * this minimal bundle (see `EventBundle` in `./render.tsx`).
 *
 * Fields:
 *  - `kind`     — e.g. 'HYPOTHESIS', 'EXPERIMENT'. Rendered in
 *                 small-caps for the ledger entry.
 *  - `captured_at` — ISO timestamp; formatted via
 *                 `Intl.DateTimeFormat('en-AU')` to "12 Mar 2024".
 *  - `summary`  — optional 50-word excerpt from
 *                 `summariseEvent(event)`. Truncated to ~120 chars
 *                 in the card; the full text appears on hover via
 *                 the `title` attribute.
 */
export interface EventCitationEvent {
  kind: string;
  captured_at: string;
  summary?: string;
}

export interface EventCitationProps {
  /** UUID of the cited event. Becomes the DOM id anchor target. */
  eventId: string;
  /** Eager-loaded event metadata. Required for v1 — parent fetches in bulk. */
  event: EventCitationEvent;
  /** Footnote number (1-based) shown in the ledger entry. */
  footnoteNumber: number;
}

/**
 * Maximum length of the inline summary snippet shown in the ledger
 * card. Longer summaries get an ellipsis and the full text is
 * accessible via the `title` attribute on hover.
 *
 * 120 chars matches roughly two lines at typical narrative-page
 * widths, keeping the per-section evidence list scannable.
 */
const SUMMARY_PREVIEW_LEN = 120;

/**
 * Truncate a summary string to `SUMMARY_PREVIEW_LEN` chars, adding
 * a single trailing ellipsis when content was dropped. Trims trailing
 * whitespace before the ellipsis so we never render "foo …" with a
 * stray space.
 */
function truncateSummary(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length <= SUMMARY_PREVIEW_LEN) return trimmed;
  return trimmed.slice(0, SUMMARY_PREVIEW_LEN - 1).trimEnd() + '…';
}

/**
 * Format an ISO timestamp as "12 Mar 2024" (en-AU short date). Falls
 * back to the raw ISO string if parsing yields an invalid Date — the
 * narrative page should never render "NaN NaN NaN" if a malformed
 * captured_at slips through the @cpa/schemas validation layer.
 */
function formatCapturedDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('en-AU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(d);
}

/**
 * Per-event ledger card rendered at the bottom of each narrative
 * section. Pure server component — no client-side interactivity in
 * v1; the "hover preview" is the native browser tooltip from the
 * `title` attribute, which works without any JS hydration.
 *
 * Layout:
 *
 *   ┌──────────────────────────────────────────┐
 *   │ [1] HYPOTHESIS  ·  12 Mar 2024           │
 *   │ Initial hypothesis: catalyst lasts 200 h │
 *   │ at 80°C without observable degradation…  │
 *   └──────────────────────────────────────────┘
 *
 * The `id` attribute is set to `evt-${eventId}` so the in-text
 * superscript markers can render as anchor links targeting the
 * matching ledger entry once Task 5.9 wires them up.
 */
export function EventCitation({ eventId, event, footnoteNumber }: EventCitationProps) {
  const fullSummary = event.summary ?? '';
  const previewSummary = truncateSummary(fullSummary);
  const isTruncated = previewSummary !== fullSummary;

  return (
    <li
      id={`evt-${eventId}`}
      className={cn(
        'group flex flex-col gap-1 rounded-md border border-muted-foreground/15 bg-muted/30 p-3',
        'text-sm text-muted-foreground',
      )}
    >
      <div className="flex items-baseline gap-2">
        <span
          className={cn(
            'inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full',
            'bg-primary/10 px-1 text-xs font-semibold text-primary',
          )}
          aria-label={`Footnote ${footnoteNumber}`}
        >
          {footnoteNumber}
        </span>
        <span className="text-xs font-semibold uppercase tracking-wide text-foreground">
          {event.kind}
        </span>
        <span aria-hidden="true">·</span>
        <time dateTime={event.captured_at} className="text-xs">
          {formatCapturedDate(event.captured_at)}
        </time>
      </div>
      {fullSummary.length > 0 ? (
        <p
          className="text-sm leading-snug"
          // Native tooltip exposes the full summary on hover without
          // requiring a client-component popover. Avoids hydration
          // overhead for a feature that's read-only in v1.
          title={isTruncated ? fullSummary : undefined}
        >
          {previewSummary}
        </p>
      ) : null}
    </li>
  );
}
