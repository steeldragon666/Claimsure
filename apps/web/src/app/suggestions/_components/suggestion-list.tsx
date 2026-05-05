'use client';
import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { FlagSuggestionModal } from '@/components/flag-suggestion-modal';
import { useWhoami } from '@/hooks/use-whoami';
import { cn } from '@/lib/utils';
import { listSuggestions } from '../_lib/api';
import {
  formatRelativeTime,
  STATUS_BADGE_BASE,
  statusBadgeClasses,
  truncateIssueSummary,
  truncateSuggestionId,
} from '../_lib/helpers';
import {
  type ListSuggestionsResponse,
  SUGGESTION_SOURCE_KIND_LABELS,
  SUGGESTION_SOURCE_KINDS,
  SUGGESTION_STATUS_LABELS,
  SUGGESTION_STATUSES,
} from '../_lib/types';
import {
  encodeSuggestionListSearch,
  type SuggestionSourceKindFilter,
  type SuggestionStatusFilter,
  suggestionListApiParams,
} from '../_lib/url-params';

/**
 * Suggestion queue list view — `/suggestions`.
 *
 * Filter chips:
 *   - Status: open / triaged / pr_drafted / pr_merged / dismissed / all
 *   - Source kind: consultant_flag / rif_event / contract_test_failure
 *     / reviewer_disposition / all
 *
 * Filters are reflected in the URL via `?status=...&source_kind=...`
 * (default `'all'` for both — empty URL on initial render). Server-side
 * narrowing is wired through `listSuggestions`'s typed query opts.
 *
 * Pagination: cursor-based, matching B.3's API. The "Load more" button
 * fires a follow-up fetch keyed off `next_cursor`. We accumulate the
 * pages in component state so the user can scroll back through what
 * they've loaded.
 *
 * Empty / loading / error states are explicit to keep the surface
 * usable — the queue is the consultant's first stop after triage
 * notifications, so a stuck "Loading…" with no fallback would be
 * frustrating.
 */

export interface SuggestionListProps {
  status: SuggestionStatusFilter;
  sourceKind: SuggestionSourceKindFilter;
}

const STATUS_FILTERS: ReadonlyArray<SuggestionStatusFilter> = ['all', ...SUGGESTION_STATUSES];

const SOURCE_KIND_FILTERS: ReadonlyArray<SuggestionSourceKindFilter> = [
  'all',
  ...SUGGESTION_SOURCE_KINDS,
];

const STATUS_FILTER_LABELS: Record<SuggestionStatusFilter, string> = {
  all: 'All',
  ...SUGGESTION_STATUS_LABELS,
};

const SOURCE_KIND_FILTER_LABELS: Record<SuggestionSourceKindFilter, string> = {
  all: 'All sources',
  ...SUGGESTION_SOURCE_KIND_LABELS,
};

export function SuggestionList({ status, sourceKind }: SuggestionListProps): React.ReactElement {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Firm scope in the query key prevents cached suggestion lists from
  // leaking across tenant switches — same convention as project-list.
  const whoami = useWhoami();
  const firmScope = whoami.data?.user.tenantId ?? 'unknown';

  const apiParams = React.useMemo(
    () => suggestionListApiParams({ status, sourceKind }),
    [status, sourceKind],
  );

  // Cursor pagination: store the loaded pages in state and refetch the
  // first page when filters change. We keep the "next page" cursor on
  // each loaded response so the Load More button can use it.
  const [pages, setPages] = React.useState<ListSuggestionsResponse[]>([]);

  const firstPage = useQuery<ListSuggestionsResponse>({
    queryKey: ['suggestions', firmScope, apiParams],
    queryFn: ({ signal }) => listSuggestions(apiParams, signal),
    staleTime: 10_000, // mild caching to avoid hammering on quick re-renders
  });

  // Reset page accumulator whenever the keyed query refetches with new
  // filters. firstPage.data refers to the FIRST page only; clears the
  // tail if the user changed the status / source_kind filter.
  React.useEffect(() => {
    if (firstPage.data) setPages([firstPage.data]);
  }, [firstPage.data]);

  const loadMore = React.useCallback(async () => {
    const last = pages[pages.length - 1];
    if (!last?.next_cursor) return;
    const next = await listSuggestions({
      ...apiParams,
      cursor: last.next_cursor,
    });
    setPages((prev) => [...prev, next]);
  }, [pages, apiParams]);

  const onSelectStatus = React.useCallback(
    (next: SuggestionStatusFilter) => {
      const qs = encodeSuggestionListSearch({ status: next, sourceKind });
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router, sourceKind],
  );

  const onSelectSourceKind = React.useCallback(
    (next: SuggestionSourceKindFilter) => {
      const qs = encodeSuggestionListSearch({ status, sourceKind: next });
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router, status],
  );

  // Preserve incoming search params for the modal-opens-from-URL case
  // (we don't currently use this, but it's cheap to keep available).
  void searchParams;

  const allSuggestions = React.useMemo(() => pages.flatMap((p) => p.suggestions), [pages]);
  const hasMore = pages[pages.length - 1]?.next_cursor !== null && pages.length > 0;

  return (
    <div className="space-y-6">
      {/* Filter chips — status */}
      <div
        role="tablist"
        aria-label="Filter by status"
        className="flex flex-wrap gap-1 border-b"
        data-testid="suggestion-list-status-filter"
      >
        {STATUS_FILTERS.map((s) => {
          const isActive = s === status;
          return (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onSelectStatus(s)}
              className={cn(
                'inline-flex items-center px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                isActive
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {STATUS_FILTER_LABELS[s]}
            </button>
          );
        })}
      </div>

      {/* Filter — source kind */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label htmlFor="suggestion-source-kind-filter" className="text-muted-foreground">
          Source:
        </label>
        <select
          id="suggestion-source-kind-filter"
          value={sourceKind}
          onChange={(e) => onSelectSourceKind(e.target.value as SuggestionSourceKindFilter)}
          className="border rounded-sm px-2 py-1 text-sm bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {SOURCE_KIND_FILTERS.map((sk) => (
            <option key={sk} value={sk}>
              {SOURCE_KIND_FILTER_LABELS[sk]}
            </option>
          ))}
        </select>
      </div>

      {/* List */}
      {firstPage.isPending ? (
        <p className="text-sm text-muted-foreground">Loading suggestions…</p>
      ) : firstPage.error ? (
        <p className="text-sm text-destructive" data-testid="suggestion-list-error">
          Failed to load suggestions:{' '}
          {firstPage.error instanceof Error ? firstPage.error.message : 'Unknown error'}
        </p>
      ) : allSuggestions.length === 0 ? (
        <EmptyState status={status} sourceKind={sourceKind} />
      ) : (
        <>
          <div className="rounded-md border bg-card overflow-hidden">
            <Table data-testid="suggestion-list-table">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-32">Status</TableHead>
                  <TableHead>Issue</TableHead>
                  <TableHead className="w-44">Source</TableHead>
                  <TableHead className="w-36 hidden md:table-cell">Flagged</TableHead>
                  <TableHead className="w-24 hidden lg:table-cell">ID</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {allSuggestions.map((s) => (
                  <TableRow
                    key={s.id}
                    className="cursor-pointer"
                    data-testid="suggestion-list-row"
                    data-suggestion-id={s.id}
                    data-status={s.status}
                    onClick={() => router.push(`/suggestions/${s.id}`)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        router.push(`/suggestions/${s.id}`);
                      }
                    }}
                    tabIndex={0}
                  >
                    <TableCell>
                      <span
                        className={cn(STATUS_BADGE_BASE, statusBadgeClasses(s.status))}
                        data-status={s.status}
                      >
                        {SUGGESTION_STATUS_LABELS[s.status]}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/suggestions/${s.id}`}
                        className="block text-foreground hover:text-primary focus-visible:outline-none focus-visible:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {truncateIssueSummary(s.issue_summary)}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <span className="text-xs text-muted-foreground">
                        {SUGGESTION_SOURCE_KIND_LABELS[s.source_kind]}
                      </span>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <span
                        className="text-xs text-muted-foreground tabular-nums"
                        title={s.flagged_at}
                      >
                        {formatRelativeTime(s.flagged_at)}
                      </span>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <span className="font-mono text-[10px] text-muted-foreground" title={s.id}>
                        {truncateSuggestionId(s.id)}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {hasMore ? (
            <div className="flex justify-center">
              <Button
                variant="outline"
                onClick={() => {
                  void loadMore();
                }}
              >
                Load more
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

interface EmptyStateProps {
  status: SuggestionStatusFilter;
  sourceKind: SuggestionSourceKindFilter;
}

function EmptyState({ status, sourceKind }: EmptyStateProps): React.ReactElement {
  const isFiltered = status !== 'all' || sourceKind !== 'all';
  if (isFiltered) {
    return (
      <div
        className="border border-dashed rounded-md py-10 px-4 text-center space-y-2"
        data-testid="suggestion-list-empty-filtered"
      >
        <p className="text-sm font-medium">No suggestions match these filters</p>
        <p className="text-xs text-muted-foreground">
          Try widening the status or source filter, or flag a new suggestion below.
        </p>
        <FlagSuggestionModal>
          <Button>New suggestion</Button>
        </FlagSuggestionModal>
      </div>
    );
  }
  return (
    <div
      className="border border-dashed rounded-md py-10 px-4 text-center space-y-3"
      data-testid="suggestion-list-empty"
    >
      <p className="text-sm font-medium">No prompt suggestions yet</p>
      <p className="text-xs text-muted-foreground">
        Flag agent outputs that look wrong; reviewers triage them and decide whether to draft a PR.
        Once flagged, suggestions appear here with their lifecycle status.
      </p>
      <FlagSuggestionModal>
        <Button>Flag the first suggestion</Button>
      </FlagSuggestionModal>
    </div>
  );
}
