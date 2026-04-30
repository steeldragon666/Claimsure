'use client';
import Link from 'next/link';
import { use } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LIST_PAGE_SIZE } from '@cpa/schemas';
import { AuthGuard } from '@/components/auth-guard';
import { REGISTER_KINDS } from '@/lib/summarise-event';
import { getActivity, listActivityEvents } from '../../_lib/api';
import { UncertaintyFeed } from './_components/uncertainty-feed';

/**
 * /claims/[claim_id]/activities/[activity_id]/register — technical
 * uncertainty register feed (T-A6).
 *
 * Mirrors the dynamic-route pattern established in A5
 * (`app/claims/[claim_id]/activities/[activity_id]/page.tsx`):
 * `'use client'` + React.use(params) + AuthGuard. The page renders a
 * filtered events feed — the seven register kinds (HYPOTHESIS,
 * UNCERTAINTY, EXPERIMENT, OBSERVATION, ITERATION, NEW_KNOWLEDGE,
 * ACTIVITY_UPDATED) scoped to the active activity_id.
 *
 * Page composition:
 *   - Header: breadcrumb back to activity detail, activity title +
 *     code (CA/SA-NN).
 *   - Feed: reverse-chronological list of register events via
 *     <UncertaintyFeed events={events} />. Filtering is server-side
 *     (`?activity_id=...&kind=HYPOTHESIS,UNCERTAINTY,...`) so we don't
 *     ship unrelated rows over the wire.
 *
 * Test approach: same as A5 — the register page composes hooks +
 * React Query and is exercised via Playwright in T-A10. The pure
 * `summariseEvent` helper has unit-test coverage in
 * `_components/summarise-event.test.ts`.
 */
// Pulls `LIST_PAGE_SIZE` from @cpa/schemas — the canonical pagination
// cap, also enforced server-side by `listEventsQuery.limit`. Per-activity
// event volume is bounded to dozens, not thousands, so we keep this
// single-page even though the cursor surface is wired up server-side.

export default function ActivityRegisterPage({
  params,
}: {
  params: Promise<{ claim_id: string; activity_id: string }>;
}) {
  const { claim_id, activity_id } = use(params);
  return (
    <AuthGuard>
      <Inner claimId={claim_id} activityId={activity_id} />
    </AuthGuard>
  );
}

function Inner({ claimId, activityId }: { claimId: string; activityId: string }) {
  // Activity context — title, code, kind. Reused query key from A5 so
  // the two surfaces share one cache entry.
  const detail = useQuery({
    queryKey: ['activity', activityId],
    queryFn: () => getActivity(activityId),
  });

  // Register feed — server-side filter on activity_id + the seven
  // register kinds. `LIST_PAGE_SIZE` is the API max; the register is
  // bounded by per-activity event volume (dozens, not thousands) so
  // pagination isn't yet wired up. If a future activity grows past
  // `LIST_PAGE_SIZE` events the cursor surface is already there to
  // extend.
  const feed = useQuery({
    queryKey: ['activity-register', activityId],
    queryFn: () =>
      listActivityEvents({
        activity_id: activityId,
        kinds: [...REGISTER_KINDS],
        limit: LIST_PAGE_SIZE,
      }),
  });

  if (detail.isPending) {
    return (
      <main className="container mx-auto py-8 px-4">
        <p className="text-slate-500">Loading activity…</p>
      </main>
    );
  }
  if (detail.error || !detail.data) {
    return (
      <main className="container mx-auto py-8 px-4 space-y-4">
        <p className="text-red-600">
          Failed to load activity:{' '}
          {detail.error instanceof Error ? detail.error.message : 'Unknown error'}
        </p>
        <Link
          href={`/claims/${claimId}`}
          className="text-sm text-primary underline mt-4 inline-block"
        >
          Back to claim
        </Link>
      </main>
    );
  }

  const activity = detail.data;
  const kindLabel = activity.kind === 'core' ? 'Core activity' : 'Supporting activity';

  return (
    <main className="container mx-auto py-8 px-4 space-y-8">
      <div>
        <Link
          href={`/claims/${claimId}/activities/${activityId}`}
          className="text-sm text-muted-foreground hover:underline"
        >
          ← Back to activity
        </Link>
      </div>

      <div className="space-y-2">
        <h1 className="text-2xl font-bold">Technical Uncertainty Register</h1>
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          <span>{activity.title}</span>
          <span className="font-mono rounded bg-muted px-2 py-0.5 text-xs">{activity.code}</span>
          <span className="text-xs">{kindLabel}</span>
        </div>
      </div>

      <section className="space-y-3">
        {feed.isPending ? (
          <p className="text-sm text-muted-foreground">Loading register…</p>
        ) : feed.error ? (
          <p className="text-sm text-red-600">
            Failed to load register:{' '}
            {feed.error instanceof Error ? feed.error.message : 'Unknown error'}
          </p>
        ) : (
          <UncertaintyFeed events={feed.data.events} />
        )}
      </section>
    </main>
  );
}
