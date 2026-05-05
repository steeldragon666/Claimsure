/**
 * P7 Theme B Task B.7 — pure helpers for the /suggestions surfaces.
 *
 * Anything stateless that the page or widget computes locally lives
 * here:
 *   - `formatRelativeTime` for "5 min ago" rendering
 *   - `statusBadgeClasses(status)` color mapping per design tokens
 *   - `truncateIssueSummary(text, maxLen)` / `truncateMergeSha(sha)`
 *   - `prTrackingDisplayState(pr, suggestionStatus)` derives the
 *      widget's rendered state from the (suggestion, pr) pair
 *
 * Same separation as `multi-cycle-timeline.tsx`'s pure helpers — the
 * tests live in `helpers.test.ts` and run under tsx --test (no jsdom).
 */

import { type PromptSuggestionPr, type SuggestionStatus } from './types';

// =============================================================================
// Issue-summary truncation — list view shows a one-line preview.
// =============================================================================

/** Default max length for the list-view issue-summary preview. */
export const ISSUE_SUMMARY_PREVIEW_LIMIT = 120;

/**
 * Truncate the suggestion's issue_summary for display in the list table.
 * Returns the input unchanged when at or below the limit; otherwise
 * appends a single ellipsis (U+2026).
 *
 * The detail view shows the full untruncated summary — this helper is
 * list-view only.
 */
export function truncateIssueSummary(text: string, limit = ISSUE_SUMMARY_PREVIEW_LIMIT): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + '…';
}

// =============================================================================
// Forensic IDs — short prefixes for table cells, full strings on hover/title.
// =============================================================================

/** Length of the truncated suggestion-id badge in the table. */
export const SUGGESTION_ID_BADGE_LENGTH = 8;

/** Truncate a suggestion id (uuid) for the list-table monospace badge. */
export function truncateSuggestionId(id: string): string {
  return id.slice(0, SUGGESTION_ID_BADGE_LENGTH);
}

/** Length of the click-to-expand merge-sha display in the PR widget. */
export const MERGE_SHA_BADGE_LENGTH = 8;

/** Truncate a 40-char git sha to the conventional 8-char short form. */
export function truncateMergeSha(sha: string): string {
  return sha.slice(0, MERGE_SHA_BADGE_LENGTH);
}

// =============================================================================
// Relative-time formatting — pure, locale-stable. Avoids Intl.RelativeTimeFormat
// because (a) the Node test runner is fine with deterministic English output
// and (b) consultants need a concise audit-trail look more than locale flair.
// =============================================================================

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

/**
 * Render a timestamp as an English relative-time string.
 *
 * Examples:
 *   - "just now"
 *   - "5 min ago"
 *   - "3 hr ago"
 *   - "2 d ago"
 *   - "6 w ago"
 *   - "3 mo ago"
 *   - "1 y ago"
 *
 * Future timestamps (`now > input` is false) collapse to `"just now"` —
 * if the API ever returns a flagged_at slightly in the future due to
 * clock skew, the UI doesn't break.
 *
 * Inputs:
 *   - `iso`: ISO 8601 string (the wire shape from the API). Invalid /
 *     unparseable strings return `'unknown'` rather than crashing.
 *   - `now`: optional override for testing (default: Date.now()).
 */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return 'unknown';
  const diff = now - ms;
  if (diff < 30 * SECOND_MS) return 'just now';
  if (diff < HOUR_MS) {
    const m = Math.floor(diff / MINUTE_MS);
    return `${m} min ago`;
  }
  if (diff < DAY_MS) {
    const h = Math.floor(diff / HOUR_MS);
    return `${h} hr ago`;
  }
  if (diff < WEEK_MS) {
    const d = Math.floor(diff / DAY_MS);
    return `${d} d ago`;
  }
  if (diff < MONTH_MS) {
    const w = Math.floor(diff / WEEK_MS);
    return `${w} w ago`;
  }
  if (diff < YEAR_MS) {
    const mo = Math.floor(diff / MONTH_MS);
    return `${mo} mo ago`;
  }
  const y = Math.floor(diff / YEAR_MS);
  return `${y} y ago`;
}

// =============================================================================
// Status badge classes — design-token aware.
// =============================================================================

/**
 * Tailwind class string for a suggestion-status pill. Color choices map
 * to the design system intent:
 *   - open       → patina accent subtle (action needed)
 *   - triaged    → info / slate (work in progress)
 *   - pr_drafted → patina accent (live system action; verify-pulse worthy)
 *   - pr_merged  → emerald (success; matches Active project chip)
 *   - dismissed  → muted slate (terminal, no action)
 *
 * The status badge uses `inline-flex items-center rounded-full ...`
 * shape that wraps these classes elsewhere (see {@link STATUS_BADGE_BASE}).
 */
export function statusBadgeClasses(status: SuggestionStatus): string {
  switch (status) {
    case 'open':
      return 'bg-brand-accent-subtle text-brand-accent-strong ring-1 ring-inset ring-brand-accent';
    case 'triaged':
      return 'bg-slate-100 text-slate-800 ring-1 ring-inset ring-slate-300';
    case 'pr_drafted':
      return 'bg-brand-accent text-white ring-1 ring-inset ring-brand-accent-strong';
    case 'pr_merged':
      return 'bg-emerald-100 text-emerald-800 ring-1 ring-inset ring-emerald-300';
    case 'dismissed':
      return 'bg-muted text-muted-foreground ring-1 ring-inset ring-border';
    default: {
      // Exhaustiveness guard — adding a new status to the union lights
      // this branch up in tsc.
      const _exhaustive: never = status;
      void _exhaustive;
      return 'bg-muted text-muted-foreground ring-1 ring-inset ring-border';
    }
  }
}

/** Common base classes for a status pill. */
export const STATUS_BADGE_BASE =
  'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium';

// =============================================================================
// PR-tracking widget display state — derives what the widget renders
// from the (suggestion.status, pr) pair. Pure so it's unit-testable.
// =============================================================================

export type PrTrackingDisplayKind =
  | 'no_pr_yet' // status is open / triaged — no PR row exists
  | 'drafted' // pr exists, status is pr_drafted
  | 'merged' // pr.merged_at populated, status is pr_merged
  | 'dismissed' // status is dismissed (whether or not a PR row exists)
  | 'unknown'; // PR row exists but status disagrees — defensive

export interface PrTrackingDisplayState {
  kind: PrTrackingDisplayKind;
  /** Whether the widget should keep polling /v1/suggestions/:id. */
  shouldPoll: boolean;
  /** Whether a status flip just happened (for verify-pulse animation). */
  isInFlight: boolean;
}

/**
 * Derive the widget's display state from the (suggestion, pr) pair.
 *
 * Polling rules:
 *   - Poll while status is `open`, `triaged`, or `pr_drafted` AND not
 *     resolved. These are "in-flight" — a webhook flip from B.6 might
 *     arrive at any time.
 *   - Stop polling on terminal status (`pr_merged`, `dismissed`).
 *
 * `isInFlight` is `true` for `drafted` because the visual cue (the
 * verify-pulse border animation) is the reviewer's signal that the
 * system is actively waiting on GitHub. It's NOT for `merged` /
 * `dismissed` (terminal — animation off).
 */
export function prTrackingDisplayState(
  status: SuggestionStatus,
  pr: PromptSuggestionPr | null,
): PrTrackingDisplayState {
  if (status === 'dismissed') {
    return { kind: 'dismissed', shouldPoll: false, isInFlight: false };
  }
  if (status === 'pr_merged') {
    return { kind: 'merged', shouldPoll: false, isInFlight: false };
  }
  if (status === 'pr_drafted') {
    if (pr === null) {
      // Defensive — the suggestion claims a PR was drafted but no row
      // exists yet (race between the status flip and the pr row write).
      // Treat as in-flight and keep polling.
      return { kind: 'unknown', shouldPoll: true, isInFlight: true };
    }
    if (pr.merged_at !== null) {
      // pr.merged_at is set but suggestion.status hasn't caught up yet
      // (webhook reconciler lag, or webhook not delivered). Render as
      // merged — the truth is on the pr row — but keep polling so a
      // subsequent fetch flips suggestion.status to pr_merged and the
      // poll stops.
      return { kind: 'merged', shouldPoll: true, isInFlight: true };
    }
    return { kind: 'drafted', shouldPoll: true, isInFlight: true };
  }
  // status is 'open' or 'triaged'
  return { kind: 'no_pr_yet', shouldPoll: true, isInFlight: false };
}

// =============================================================================
// Issue-summary client validation for the flag modal — must match the
// API's Zod constraints in `prompt-suggestions.ts#FlagSuggestionInput`.
// =============================================================================

/** Min / max bounds for flagged-suggestion `issue_summary`. */
export const ISSUE_SUMMARY_MIN = 10;
export const ISSUE_SUMMARY_MAX = 1000;

export interface IssueSummaryValidation {
  valid: boolean;
  error?: string;
}

/**
 * Mirror of the Zod constraint applied at the API: 10–1000 chars after
 * trim. Surfaces a friendly error message instead of relying on the API's
 * 400 round-trip.
 */
export function validateIssueSummary(text: string): IssueSummaryValidation {
  const trimmed = text.trim();
  if (trimmed.length < ISSUE_SUMMARY_MIN) {
    return {
      valid: false,
      error: `Issue summary must be at least ${ISSUE_SUMMARY_MIN} characters`,
    };
  }
  if (trimmed.length > ISSUE_SUMMARY_MAX) {
    return {
      valid: false,
      error: `Issue summary must be at most ${ISSUE_SUMMARY_MAX} characters`,
    };
  }
  return { valid: true };
}

/**
 * Mirror of the source_payload jsonb constraint: must be a JSON object
 * (record). Empty {} is allowed so a consultant can flag a quick "this
 * looks wrong" without filling in a payload.
 *
 * Returns the parsed value when valid; throws otherwise — the modal
 * catches the throw to display a friendly error.
 */
export function parseSourcePayload(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  // Empty input → empty payload. The API requires a record but accepts
  // {} (record(unknown)).
  if (trimmed === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(
      `source_payload must be valid JSON: ${err instanceof Error ? err.message : 'parse error'}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('source_payload must be a JSON object (e.g. {"reason": "..."})');
  }
  return parsed as Record<string, unknown>;
}

// =============================================================================
// Generate-PR gate — pinned to the API state machine.
//
// POST /v1/suggestions/:id/generate-pr's preflight in
// `apps/api/src/routes/prompt-suggestions.ts` returns 409 unless
// `suggestion.status === 'triaged'`. The UI button must hide on every
// other status to keep the affordance honest.
// =============================================================================

/**
 * Returns `true` only when the Generate-PR CTA should be visible.
 *
 * Drift guard: this list is the SAME shape as the API's state-machine
 * preflight in `prompt-suggestions.ts` (line ~789). If the API ever
 * widens the allowed-from list (e.g. allow regenerating from
 * `pr_drafted` after a closed PR), update both.
 */
export function canGeneratePr(status: SuggestionStatus): boolean {
  return status === 'triaged';
}
