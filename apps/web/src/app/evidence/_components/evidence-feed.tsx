'use client';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { EvidenceFeedKind } from '@cpa/schemas';
import { fetchEvidence } from '../_lib/api';
import { EvidenceCard } from './evidence-card';

export interface EvidenceFeedProps {
  kinds: EvidenceFeedKind[] | undefined;
  claimantIds: string[] | undefined;
}

/**
 * Infinite-scrolling evidence feed.
 *
 * Fetches pages from GET /v1/evidence, keyed by the current filter
 * state. When filters change, the query key changes and React Query
 * refetches from page 1 automatically.
 *
 * "Load more" is a manual button (not IntersectionObserver) — simpler
 * and avoids the double-fire foot-gun with React 18 strict mode.
 */
export function EvidenceFeed({ kinds, claimantIds }: EvidenceFeedProps) {
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading, isError, error } =
    useInfiniteQuery({
      queryKey: ['evidence', { kinds, claimantIds }],
      queryFn: ({ pageParam }) =>
        fetchEvidence({
          kinds,
          claimant_ids: claimantIds,
          cursor: pageParam ?? undefined,
        }),
      initialPageParam: null as string | null,
      getNextPageParam: (lastPage) => lastPage.next_cursor,
    });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        Loading evidence...
      </div>
    );
  }

  if (isError) {
    return (
      <div className="rounded-md border border-destructive/50 bg-destructive/5 p-4 text-sm text-destructive">
        Failed to load evidence: {error instanceof Error ? error.message : 'Unknown error'}
      </div>
    );
  }

  const items = data?.pages.flatMap((page) => page.items) ?? [];

  if (items.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        No evidence found for the current filters.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {items.map((item) => (
        <EvidenceCard key={item.id} item={item} />
      ))}

      {hasNextPage ? (
        <div className="flex justify-center pt-2">
          <button
            type="button"
            onClick={() => {
              void fetchNextPage();
            }}
            disabled={isFetchingNextPage}
            className="rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-50"
          >
            {isFetchingNextPage ? 'Loading...' : 'Load more'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
