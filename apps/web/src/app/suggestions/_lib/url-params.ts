/**
 * URL search-param parsers for the /suggestions list view (B.7).
 *
 * Same default-on-junk shape as the /projects parsers in
 * `apps/web/src/app/projects/_lib/url-params.ts`: anything unknown /
 * null / empty / wrong-case falls back to a documented default rather
 * than 400-ing or crashing on a stale bookmark.
 *
 * Pure functions — no React, no fetch — covered by `node:test` in
 * `url-params.test.ts` without jsdom.
 */

import {
  SUGGESTION_SOURCE_KINDS,
  SUGGESTION_STATUSES,
  type SuggestionSourceKind,
  type SuggestionStatus,
} from './types';

/**
 * Status filter for the /suggestions list. The empty-string sentinel
 * `'all'` shows every status; otherwise we narrow to the chosen one.
 *
 * Default is 'all' — landing on the queue, the consultant wants to see
 * the full picture and then drill into "open" for triage work.
 */
export type SuggestionStatusFilter = SuggestionStatus | 'all';

const SUGGESTION_STATUS_FILTER_VALUES: ReadonlySet<string> = new Set([
  'all',
  ...SUGGESTION_STATUSES,
] satisfies ReadonlyArray<SuggestionStatusFilter>);

/**
 * Parse `?status=...`. Defaults to `'all'`. Accepts the five status
 * values plus `'all'`; everything else falls back to default.
 */
export function parseSuggestionStatusFilter(
  value: string | null | undefined,
): SuggestionStatusFilter {
  if (value && SUGGESTION_STATUS_FILTER_VALUES.has(value)) {
    return value as SuggestionStatusFilter;
  }
  return 'all';
}

/**
 * Source-kind filter. `'all'` shows every source.
 */
export type SuggestionSourceKindFilter = SuggestionSourceKind | 'all';

const SUGGESTION_SOURCE_KIND_FILTER_VALUES: ReadonlySet<string> = new Set([
  'all',
  ...SUGGESTION_SOURCE_KINDS,
] satisfies ReadonlyArray<SuggestionSourceKindFilter>);

/**
 * Parse `?source_kind=...`. Defaults to `'all'`.
 */
export function parseSuggestionSourceKindFilter(
  value: string | null | undefined,
): SuggestionSourceKindFilter {
  if (value && SUGGESTION_SOURCE_KIND_FILTER_VALUES.has(value)) {
    return value as SuggestionSourceKindFilter;
  }
  return 'all';
}

/**
 * Build the query string fragment for the API list call from the parsed
 * filters. Returns an object with only the keys that should hit the wire
 * — `'all'` filters drop out so the API uses its defaults.
 *
 * Exposed as a pure helper so the URL-driven UI and the api.ts client
 * agree on the contract; tested directly under tsx --test.
 */
export function suggestionListApiParams(opts: {
  status: SuggestionStatusFilter;
  sourceKind: SuggestionSourceKindFilter;
}): { status?: SuggestionStatus; source_kind?: SuggestionSourceKind } {
  const params: { status?: SuggestionStatus; source_kind?: SuggestionSourceKind } = {};
  if (opts.status !== 'all') params.status = opts.status;
  if (opts.sourceKind !== 'all') params.source_kind = opts.sourceKind;
  return params;
}

/**
 * Encode a list of (key, value) param tuples into a URLSearchParams
 * string with stable ordering. `'all'` filters and undefined values are
 * omitted so the URL stays clean.
 *
 * Pure helper — used by the list page when chip-clicks should rewrite
 * the URL via `router.replace`.
 */
export function encodeSuggestionListSearch(opts: {
  status: SuggestionStatusFilter;
  sourceKind: SuggestionSourceKindFilter;
}): string {
  const params = new URLSearchParams();
  if (opts.status !== 'all') params.set('status', opts.status);
  if (opts.sourceKind !== 'all') params.set('source_kind', opts.sourceKind);
  return params.toString();
}
