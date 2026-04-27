'use client';
import type { Event as ApiEvent } from '@cpa/schemas';
import { Button } from '@/components/ui/button';
import { ConfidenceChip } from './confidence-chip';
import { KindChip } from './kind-chip';

/**
 * Render a single event row in the feed.
 *
 * The payload column is `unknown` over the wire (events can carry varied
 * shapes: paste, override, future ingest sources), so we narrow it with
 * a small guard before pulling raw_text out for the snippet.
 *
 * The override action is a no-op stub in this commit (T24) — T26 wires
 * up the modal. The button is hidden when kind === 'OVERRIDE' because
 * the API rejects override-of-override (events.ts step 2).
 */
interface PastePayload {
  _v: number;
  source: string;
  raw_text?: string;
}

const isPastePayload = (p: unknown): p is PastePayload =>
  typeof p === 'object' && p != null && 'source' in p;

const getRawText = (event: ApiEvent): string | null => {
  if (isPastePayload(event.payload) && typeof event.payload.raw_text === 'string') {
    return event.payload.raw_text;
  }
  return null;
};

const truncate = (s: string, max = 80): string =>
  s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…';

const formatRelative = (iso: string): string => {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const diffMs = Date.now() - then;
  const sec = Math.round(diffMs / 1000);
  if (sec < 45) return 'just now';
  if (sec < 90) return '1 minute ago';
  const min = Math.round(sec / 60);
  if (min < 45) return `${min} minutes ago`;
  if (min < 90) return '1 hour ago';
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hours ago`;
  const day = Math.round(hr / 24);
  if (day === 1) return 'yesterday';
  if (day < 14) return `${day} days ago`;
  return new Date(iso).toLocaleDateString();
};

export interface EventCardProps {
  event: ApiEvent;
  /** T26 will wire this up; pass `undefined` to keep button as a stub. */
  onOverride?: (event: ApiEvent) => void;
}

export function EventCard({ event, onOverride }: EventCardProps) {
  const rawText = getRawText(event);
  const overrideReason = event.kind === 'OVERRIDE' ? event.override_reason : null;
  const snippet = overrideReason ?? rawText;
  const showOverrideButton = event.kind !== 'OVERRIDE';

  return (
    <article className="border rounded-md p-4 space-y-2 bg-card">
      <header className="flex flex-wrap items-center gap-2">
        <KindChip kind={event.effective_kind} />
        <ConfidenceChip
          value={event.classification?.confidence}
          isOverridden={event.is_overridden}
        />
        {event.classification?.statutory_anchor ? (
          <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-medium text-slate-700">
            {event.classification.statutory_anchor}
          </span>
        ) : null}
        <span className="ml-auto text-xs text-muted-foreground">
          {formatRelative(event.captured_at)}
        </span>
      </header>

      {snippet ? (
        <p className="text-sm">
          {event.kind === 'OVERRIDE' ? (
            <span className="text-muted-foreground italic">Reason: </span>
          ) : null}
          {truncate(snippet)}
        </p>
      ) : null}

      {event.classification?.rationale ? (
        <p className="text-xs italic text-muted-foreground">{event.classification.rationale}</p>
      ) : null}

      {showOverrideButton ? (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOverride?.(event)}
            disabled={!onOverride}
          >
            Override
          </Button>
        </div>
      ) : null}
    </article>
  );
}
