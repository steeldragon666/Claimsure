'use client';
import { useQueries } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';
import type { ListEventsFilter } from '@cpa/schemas';
import { cn } from '@/lib/utils';
import { listEvents } from '../../_lib/api';

/**
 * Tab strip for the event feed: All / Needs Review / Ineligible / Overrides.
 *
 * Hand-authored (no shadcn `Tabs` primitive in the project — adding the
 * Radix dep just for this would be over-engineering). Behaviourally the
 * same: ARIA role=tablist, role=tab on each item, aria-selected on the
 * active one, keyboard activation via the underlying <button>.
 *
 * Selected tab lives in the `?filter=` URL search param so the view is
 * shareable and back-button-friendly. Counts come from running listEvents
 * once per tab in parallel via useQueries — at P2 scale (≤ 50 events per
 * claimant) that's a cheap four-query fan-out.
 */
const TABS: ReadonlyArray<{ value: ListEventsFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'needs_review', label: 'Needs Review' },
  { value: 'ineligible', label: 'Ineligible' },
  { value: 'overrides', label: 'Overrides' },
];

const FILTER_VALUES = new Set<ListEventsFilter>(['all', 'needs_review', 'ineligible', 'overrides']);

export function parseFilter(raw: string | null): ListEventsFilter {
  return raw && FILTER_VALUES.has(raw as ListEventsFilter) ? (raw as ListEventsFilter) : 'all';
}

export interface FilterTabsProps {
  subjectTenantId: string;
  active: ListEventsFilter;
}

export function FilterTabs({ subjectTenantId, active }: FilterTabsProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // One useQueries call → four parallel listEvents requests, one per tab.
  // We use limit=200 (the API max) so the count is exact for any P2-scale
  // claimant; cursor pagination would only matter once a claimant exceeds
  // 200 events on a single filter, which we'll address with a count
  // endpoint later if it becomes real.
  const queries = useQueries({
    queries: TABS.map((tab) => ({
      queryKey: ['events', subjectTenantId, tab.value, 200],
      queryFn: () =>
        listEvents({ subject_tenant_id: subjectTenantId, filter: tab.value, limit: 200 }),
    })),
  });

  const onSelect = useCallback(
    (next: ListEventsFilter) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === 'all') {
        params.delete('filter');
      } else {
        params.set('filter', next);
      }
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  return (
    <div role="tablist" aria-label="Event filter" className="flex flex-wrap gap-1 border-b">
      {TABS.map((tab, i) => {
        const q = queries[i];
        const count = q?.data?.events.length;
        const isActive = active === tab.value;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onSelect(tab.value)}
            className={cn(
              'inline-flex items-center gap-2 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
              isActive
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
            <span
              className={cn(
                'inline-flex items-center justify-center rounded-full px-2 py-0.5 text-xs font-medium min-w-[1.5rem]',
                isActive ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
              )}
            >
              {q?.isPending ? '…' : count != null ? count : '?'}
            </span>
          </button>
        );
      })}
    </div>
  );
}
