'use client';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Activity } from '@cpa/schemas';
import { useToast } from '@/hooks/use-toast';
import {
  apportionExpenditure,
  listActivities,
  listExpenditures,
  mapExpenditure,
} from '../_lib/api';
import type { ValidatedAllocation } from '../_lib/apportionment';
import {
  applyApportionmentOptimistic,
  applyMappingOptimistic,
  type ExpenditureApportionment,
  type ExpenditureRow,
} from '../_lib/expenditure-stub';
import { parseExpenditureFilter } from '../_lib/url-params';
import { ExpenditureApportionDialog } from './expenditure-apportion-dialog';
import { ExpenditureFilterChips } from './expenditure-filter';
import { ExpenditureRowItem } from './expenditure-row';

/**
 * Captured state for an in-flight optimistic mutation, used to revert if
 * the server-side call rejects. Tracks both `current_mapping` and
 * `current_apportionment` because either field could change in a revert
 * (the C5 onMap path also clears apportionment via
 * `applyMappingOptimistic`, so reverting needs to restore both).
 */
type PriorState = {
  current_mapping: ExpenditureRow['current_mapping'];
  current_apportionment: ExpenditureRow['current_apportionment'];
};

/**
 * Expenditure tab — mapping UI for tying Xero expenditures (invoices,
 * bank transactions, receipts) to activities within the current claim.
 *
 * Architecture (controller decision, P4 plan §C5):
 *
 *   Mapping persistence is event-sourced. The eventual A-swimlane
 *   endpoint posts an `EXPENDITURE_MAPPED` event via
 *   `POST /v1/expenditures/:id/map`. Current-mapping state is
 *   projected from that event stream (see
 *   `_lib/expenditure-projection.ts`).
 *
 * C5 ships UI only — the backend stub in `_lib/api.ts` documents the
 * planned wire format with a TODO block. The optimistic update flow is
 * already in place so swap-in is mechanical.
 *
 * State strategy — mirrors `pipeline-kanban.tsx` / `usePipelineClaims`:
 *   1. The query result is the source of truth; we mirror it locally
 *      so we can mutate ahead of the network.
 *   2. On mapExpenditure submit, snapshot the current rows, apply the
 *      optimistic mapping, then call the stub. On any rejection,
 *      revert to the snapshot and toast destructively. On success
 *      (single PATCH today; stays Promise.allSettled-shaped so a future
 *      bulk-map flow drops in cleanly), keep the optimistic state and
 *      toast.
 *   3. When the parent invalidates ['expenditures', ...] the local
 *      mirror re-syncs to the fresh server payload (useEffect).
 */

export function ExpenditureTab({ claimId }: { claimId: string }) {
  const searchParams = useSearchParams();
  const filter = parseExpenditureFilter(searchParams.get('expenditure_filter'));
  const { toast } = useToast();

  // Pre-A?-mapping the listExpenditures stub returns the in-memory
  // fixture filtered by `filter`. The query key is shaped to match the
  // eventual cache shape so swap-in is a one-liner once the backend
  // ships.
  const expendituresQuery = useQuery({
    queryKey: ['expenditures', { claimId, filter }] as const,
    queryFn: () => listExpenditures(claimId, filter),
  });

  const activitiesQuery = useQuery({
    // Match the activities-tab query key — when both tabs render in a
    // session, react-query dedupes the request. The activity list
    // doesn't change with the expenditure filter, so it's keyed only
    // by claim id.
    queryKey: ['activities', { claimId }] as const,
    queryFn: () => listActivities(claimId),
  });

  // --- Optimistic mirror ---
  // The picker writes here ahead of the network; on stub success we
  // keep the change, on rejection we revert. Re-syncs from the parent
  // query whenever the source data changes (filter switch, manual
  // invalidate). Same shape as `useOptimisticClaims` in
  // `pipeline/_lib/use-pipeline-claims.ts`.
  const [optimisticRows, setOptimisticRows] = useState<ExpenditureRow[]>([]);
  useEffect(() => {
    if (expendituresQuery.data) setOptimisticRows(expendituresQuery.data);
  }, [expendituresQuery.data]);

  // --- Per-row pending tracker for the spinner / disabled state ---
  // A Set instead of a single boolean so multiple rows can be in flight
  // independently — matters once the picker UX gains a "map several
  // unmapped rows in a row" rhythm (the user clicks Map → picks → the
  // dropdown closes → they immediately click the next row's Map).
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());

  // --- Apportion dialog state ---
  // Owned at the parent so the optimistic update + revert + toast all
  // live alongside the single-mapping flow. The dialog itself is
  // stateless about which row it's editing — that's tracked here via
  // `apportioningRowId` (null = closed).
  const [apportioningRowId, setApportioningRowId] = useState<string | null>(null);

  // If the apportioning row vanishes from the optimistic mirror (e.g. a
  // filter switch + invalidation removed it while the dialog was open),
  // close the dialog. This MUST run as an effect rather than inline in
  // render — calling setApportioningRowId synchronously during the
  // parent's render trips React's "Cannot update a component while
  // rendering a different component" warning under StrictMode and is
  // unsafe under React 18 concurrent rendering. The render-pass body
  // below renders nothing when target is missing; the effect tidies up
  // on the subsequent commit.
  useEffect(() => {
    if (apportioningRowId !== null) {
      const targetExists = optimisticRows.some((r) => r.id === apportioningRowId);
      if (!targetExists) {
        setApportioningRowId(null);
      }
    }
  }, [apportioningRowId, optimisticRows]);

  // --- In-flight prior-state tracker ---
  // Keyed by expenditure id. Holds the pre-mutation `current_mapping` /
  // `current_apportionment` for any optimistic update currently awaiting
  // its server confirmation. On rejection the entry is read out and
  // applied to revert; on success or rejection it's deleted.
  //
  // Why a ref:
  //   - Mutable; persists across renders without triggering re-renders.
  //   - No closure capture — the success/failure handlers read the
  //     current value rather than a value baked into the callback's
  //     closure. This means useCallback can have an empty deps array
  //     (refs are NEVER deps; React docs are explicit about this).
  //   - Idempotent under StrictMode's double-invocation of functional
  //     updaters: both runs write the same prior state to the same key.
  //
  // Replaces the previous `let snapshot; setOptimisticRows(prev => {
  // snapshot = prev; ... })` pattern, which captures `snapshot` in the
  // outer closure and races under concurrent rendering. Shared between
  // onMap (C5 path) and onApportionSubmit (C6 path).
  const inFlightPriorRef = useRef<Map<string, PriorState>>(new Map());

  const activitiesById = useMemo(() => {
    const m = new Map<string, Activity>();
    for (const a of activitiesQuery.data ?? []) m.set(a.id, a);
    return m;
  }, [activitiesQuery.data]);

  const onMap = useCallback(
    async (expenditureId: string, activityId: string): Promise<void> => {
      const activity = activitiesById.get(activityId);
      if (!activity) {
        // Defensive — picker always passes an activity from the same
        // list, but guard against future code paths.
        toast({
          title: 'Mapping failed',
          description: 'Selected activity not found.',
          variant: 'destructive',
        });
        return;
      }

      const mapping = {
        activity_id: activity.id,
        activity_code: activity.code,
        activity_title: activity.title,
        mapped_at: new Date().toISOString(),
      };
      // Capture prior state into the ref atomically with the optimistic
      // mutation. Done inside the functional updater so we read the
      // freshest React-tracked value (rapid double-click safe), and
      // because StrictMode invokes the updater twice in dev — writing
      // the same prior to the same key both times is idempotent.
      setOptimisticRows((prev) => {
        const target = prev.find((r) => r.id === expenditureId);
        if (target) {
          inFlightPriorRef.current.set(expenditureId, {
            current_mapping: target.current_mapping,
            current_apportionment: target.current_apportionment,
          });
        }
        return applyMappingOptimistic(prev, expenditureId, mapping);
      });
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.add(expenditureId);
        return next;
      });

      // Promise.allSettled-shaped even though there's a single call —
      // matches the C2-fix aggregation pattern in
      // `runStageMutationsBatch` so the future bulk-map flow drops in
      // without restructuring the toast logic.
      const results = await Promise.allSettled([mapExpenditure(expenditureId, activityId)]);
      const failed = results.filter((r) => r.status === 'rejected').length;

      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(expenditureId);
        return next;
      });

      if (failed > 0) {
        // Diagnostic for failed maps; toast is the user-facing surface.
        for (const r of results) {
          if (r.status === 'rejected') {
            console.error(`mapExpenditure failed for ${expenditureId}:`, r.reason);
          }
        }
        // Revert via the ref. Read the prior, restore exactly the two
        // tracked fields on the matching row, then drop the entry. Other
        // rows touched by other in-flight mutations stay in their
        // optimistic state — important when two different rows are
        // mid-flight at once.
        const prior = inFlightPriorRef.current.get(expenditureId);
        if (prior) {
          setOptimisticRows((cur) =>
            cur.map((r) =>
              r.id === expenditureId
                ? {
                    ...r,
                    current_mapping: prior.current_mapping,
                    current_apportionment: prior.current_apportionment,
                  }
                : r,
            ),
          );
          inFlightPriorRef.current.delete(expenditureId);
        }
        toast({
          title: 'Mapping failed',
          description: `Could not map to ${activity.code}. Please try again.`,
          variant: 'destructive',
        });
        return;
      }

      // Success — drop the in-flight entry so memory doesn't leak.
      inFlightPriorRef.current.delete(expenditureId);
      // Success toast — deliberately fires even though the row may
      // disappear from view (filter = "Unmapped" + the row just got
      // mapped). Without it the user has no acknowledgement that the
      // action succeeded; the disappearing row is otherwise
      // indistinguishable from a swallowed error.
      toast({
        title: `Mapped to ${activity.code}`,
        description: activity.title,
      });
    },
    // `optimisticRows` and `inFlightPriorRef` are intentionally NOT
    // deps. The functional updater always sees React's freshest state,
    // and refs are never deps (React docs are explicit about this).
    [activitiesById, toast],
  );

  // Apportion submit handler — same optimistic / revert / aggregate
  // pattern as `onMap`. Returns a promise so the dialog can show its
  // submitting state and close on success; on rejection the dialog
  // stays open and we revert + toast.
  const onApportionSubmit = useCallback(
    async (expenditureId: string, allocations: ValidatedAllocation[]): Promise<void> => {
      // Project the dialog's [{activity_id, percentage}] into the row's
      // `current_apportionment` shape (denormalised activity_code +
      // activity_title from the activities map). Same denormalisation
      // pattern as `current_mapping` in the C5 path — the row UI shouldn't
      // have to look up activity metadata at render time.
      const denormalised: ExpenditureApportionment = {
        allocations: allocations.map((a) => {
          const activity = activitiesById.get(a.activity_id);
          // Defensive: the dialog only offers the same activities the
          // tab loaded, so this lookup should always hit. Fall back to
          // the id if somehow it doesn't (won't happen in normal flow).
          return {
            activity_id: a.activity_id,
            activity_code: activity?.code ?? a.activity_id,
            activity_title: activity?.title ?? '',
            percentage: a.percentage,
          };
        }),
        apportioned_at: new Date().toISOString(),
      };

      // Capture prior state via the shared in-flight ref. Same pattern
      // as onMap (above) — see that callback's JSDoc for the "why
      // useRef" rationale.
      setOptimisticRows((prev) => {
        const target = prev.find((r) => r.id === expenditureId);
        if (target) {
          inFlightPriorRef.current.set(expenditureId, {
            current_mapping: target.current_mapping,
            current_apportionment: target.current_apportionment,
          });
        }
        return applyApportionmentOptimistic(prev, expenditureId, denormalised);
      });
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.add(expenditureId);
        return next;
      });

      // Promise.allSettled-shaped (single call today) — same idiom as
      // onMap, so a future bulk-apportion flow drops in cleanly.
      const results = await Promise.allSettled([apportionExpenditure(expenditureId, allocations)]);
      const failed = results.filter((r) => r.status === 'rejected').length;

      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(expenditureId);
        return next;
      });

      if (failed > 0) {
        for (const r of results) {
          if (r.status === 'rejected') {
            console.error(`apportionExpenditure failed for ${expenditureId}:`, r.reason);
          }
        }
        const prior = inFlightPriorRef.current.get(expenditureId);
        if (prior) {
          setOptimisticRows((cur) =>
            cur.map((r) =>
              r.id === expenditureId
                ? {
                    ...r,
                    current_mapping: prior.current_mapping,
                    current_apportionment: prior.current_apportionment,
                  }
                : r,
            ),
          );
          inFlightPriorRef.current.delete(expenditureId);
        }
        toast({
          title: 'Apportionment failed',
          description: `Could not apportion this expenditure across ${allocations.length} activities. Please try again.`,
          variant: 'destructive',
        });
        // Re-throw so the dialog keeps itself open for a retry.
        throw new Error('Apportionment failed');
      }

      // Success — drop the in-flight entry so memory doesn't leak.
      inFlightPriorRef.current.delete(expenditureId);
      toast({
        title: `Apportioned across ${allocations.length} activities`,
        description: denormalised.allocations
          .map((a) => `${a.activity_code} ${a.percentage}%`)
          .join(' · '),
      });
    },
    // Same dep rationale as onMap — refs and React state read inside
    // functional updaters are not deps.
    [activitiesById, toast],
  );

  if (expendituresQuery.isPending || activitiesQuery.isPending) {
    return <p className="text-sm text-muted-foreground">Loading expenditures…</p>;
  }
  if (expendituresQuery.error) {
    return (
      <p className="text-sm text-red-600">
        Failed to load expenditures:{' '}
        {expendituresQuery.error instanceof Error
          ? expendituresQuery.error.message
          : 'Unknown error'}
      </p>
    );
  }
  if (activitiesQuery.error) {
    return (
      <p className="text-sm text-red-600">
        Failed to load activities:{' '}
        {activitiesQuery.error instanceof Error ? activitiesQuery.error.message : 'Unknown error'}
      </p>
    );
  }

  const activities = activitiesQuery.data;

  return (
    <div className="space-y-4">
      <ExpenditureFilterChips active={filter} />

      {optimisticRows.length === 0 ? (
        <EmptyState
          filter={filter}
          // True when every server-loaded row in the unfiltered list is
          // empty — i.e. there's nothing synced yet, vs. the filter
          // narrowed everyone away. We can't know the unfiltered count
          // without a second fetch, so we infer: if the filter is "all"
          // and we got zero rows, the firm has nothing synced.
          firmHasNothing={filter === 'all'}
        />
      ) : (
        <ul className="divide-y rounded-md border bg-background">
          {optimisticRows.map((row) => (
            <ExpenditureRowItem
              key={row.id}
              row={row}
              activities={activities}
              isPending={pendingIds.has(row.id)}
              onMap={(activityId) => void onMap(row.id, activityId)}
              onApportion={() => setApportioningRowId(row.id)}
            />
          ))}
        </ul>
      )}

      {/*
        Apportion dialog — rendered at the tab level so the optimistic
        update + revert + toast all live alongside the single-mapping
        path. The dialog is keyed by the row id so opening it for a
        different row resets its internal state.
      */}
      {apportioningRowId !== null &&
        (() => {
          const target = optimisticRows.find((r) => r.id === apportioningRowId);
          if (!target) {
            // Row was removed (filter switch + invalidation) while the
            // dialog was open. Render nothing this pass — the
            // `apportioningRowId` cleanup effect (above) will close the
            // dialog on the subsequent commit. We deliberately do NOT
            // call setApportioningRowId(null) here: setState during a
            // parent's render trips React's StrictMode warning and is
            // unsafe under React 18 concurrent rendering.
            return null;
          }
          return (
            <ExpenditureApportionDialog
              key={apportioningRowId}
              open
              onOpenChange={(o) => !o && setApportioningRowId(null)}
              row={target}
              activities={activities}
              onSubmit={(allocations) => onApportionSubmit(apportioningRowId, allocations)}
            />
          );
        })()}
    </div>
  );
}

/**
 * Dual-shape empty state. The "no expenditures synced" copy is the
 * onboarding hint (consultant lands on a fresh firm); the "no rows
 * match filter" copy is the workflow congratulation (everything's
 * mapped). Splitting the messaging matters because the user actions
 * differ: one points at the integrations page, the other says "nice
 * work" and suggests broadening the filter.
 */
function EmptyState({
  filter,
  firmHasNothing,
}: {
  filter: 'all' | 'unmapped' | 'mapped';
  firmHasNothing: boolean;
}) {
  if (firmHasNothing) {
    return (
      <div className="rounded-md border border-dashed p-8 text-center">
        <p className="text-sm text-muted-foreground">
          No Xero expenditures synced for this firm yet.
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Connect Xero in integrations to start syncing invoices, bank transactions, and receipts.
        </p>
      </div>
    );
  }
  if (filter === 'unmapped') {
    return (
      <div className="rounded-md border border-dashed p-8 text-center">
        <p className="text-sm text-muted-foreground">No unmapped expenditures — nice work.</p>
        <p className="mt-2 text-xs text-muted-foreground">
          Switch to All or Mapped above to see the rest.
        </p>
      </div>
    );
  }
  // filter === 'mapped' with zero rows.
  return (
    <div className="rounded-md border border-dashed p-8 text-center">
      <p className="text-sm text-muted-foreground">
        No mapped expenditures yet. Switch to Unmapped above to start mapping.
      </p>
    </div>
  );
}
