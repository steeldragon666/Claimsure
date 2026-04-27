interface RecentEvent {
  id: string;
  kind: string;
  captured_at: string;
  snippet: string;
}

interface Props {
  events: RecentEvent[];
}

/**
 * Format a timestamp as a relative time string ("3m ago", "2h ago",
 * "yesterday"). Pure function — server-component compatible.
 *
 * For v1 we keep it locale-agnostic and ASCII-only so the rendered
 * markup is stable across SSR and client hydration without needing
 * Intl.RelativeTimeFormat (which differs subtly per Node version vs.
 * browser).
 */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay === 1) return 'yesterday';
  if (diffDay < 7) return `${diffDay}d ago`;
  const diffWk = Math.floor(diffDay / 7);
  if (diffWk < 4) return `${diffWk}w ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Map an evidence kind to a human-readable label. The 12 classifiable
 * kinds + OVERRIDE come from `EVIDENCE_KINDS` in the DB schema; we
 * mirror just the labels here to keep the component decoupled from the
 * @cpa/db type boundary. Unknown kinds fall through to titlecased.
 */
const KIND_LABEL: Record<string, string> = {
  HYPOTHESIS: 'Hypothesis',
  DESIGN: 'Design',
  EXPERIMENT: 'Experiment',
  OBSERVATION: 'Observation',
  ITERATION: 'Iteration',
  NEW_KNOWLEDGE: 'New knowledge',
  UNCERTAINTY: 'Uncertainty',
  TIME_LOG: 'Time log',
  ASSOCIATE_FLAG: 'Associate flag',
  EXPENDITURE_NOTE: 'Expenditure note',
  SUPPORTING: 'Supporting',
  INELIGIBLE: 'Ineligible',
  OVERRIDE: 'Override',
};

/**
 * Recent events feed (T-C12).
 *
 * Shows the last N events (server passes 5) as a vertical list. Each
 * row: a kind chip on the left (color-coded by category — eligible
 * evidence in slate, ineligible in red, override in amber), a snippet
 * of the raw_text, and a relative timestamp.
 *
 * Empty state matters — for a freshly-onboarded claimant there are no
 * events yet, and the page still needs to render usefully. Returns an
 * inline empty-state card.
 */
export function RecentEventsFeed({ events }: Props) {
  if (events.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-slate-500">
        No evidence captured yet. Your team can start capturing on the mobile app at any time.
      </div>
    );
  }

  return (
    <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
      {events.map((ev) => (
        <li key={ev.id} className="flex items-start gap-3 px-4 py-3">
          <span
            className={
              ev.kind === 'INELIGIBLE'
                ? 'inline-flex shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800'
                : ev.kind === 'OVERRIDE'
                  ? 'inline-flex shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800'
                  : 'inline-flex shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700'
            }
          >
            {KIND_LABEL[ev.kind] ?? ev.kind}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-slate-900">
              {ev.snippet || <em className="text-slate-400">no preview</em>}
            </p>
          </div>
          <span className="shrink-0 text-xs text-slate-500">{relativeTime(ev.captured_at)}</span>
        </li>
      ))}
    </ul>
  );
}
