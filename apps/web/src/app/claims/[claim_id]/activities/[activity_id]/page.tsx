'use client';
import Link from 'next/link';
import { use } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AuthGuard } from '@/components/auth-guard';
import { Button } from '@/components/ui/button';
import { getActivity, listActivityArtefacts } from '../_lib/api';
import { ActivityEditor } from './_components/activity-editor';

/**
 * /claims/[claim_id]/activities/[activity_id] — activity detail editor (T-A5).
 *
 * Mirrors the dynamic-route pattern established in
 * `app/subject-tenants/[id]/page.tsx`: `'use client'` + React.use(params)
 * so AuthGuard wraps cleanly without a server-side cookie read.
 *
 * Page composition:
 *   - Header: breadcrumb back to claim, code (CA/SA-NN), kind badge
 *   - Editable form (ActivityEditor): title + 6 narrative fields
 *   - Read-only metadata block: project_id, claim_id, created_at,
 *     updated_at (these are not editable here per the schema —
 *     UpdateActivityBody intentionally excludes them)
 *   - Linked artefacts panel: real list from
 *     GET /v1/activities/:id/artefacts (T-A6) + a "View register"
 *     deeplink to the technical-uncertainty register page.
 *
 * Test approach: this is a React component with a hook + useQuery + form
 * state, so it's not amenable to pure-function unit tests in the
 * apps/web Node test runner (no jsdom). The pure-function helper
 * `computeChangedFields` is unit-tested in
 * `_components/activity-editor.test.tsx`. Full DOM interaction is
 * deferred to Playwright e2e in T-A10.
 */
export default function ActivityDetailPage({
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
  const detail = useQuery({
    queryKey: ['activity', activityId],
    queryFn: () => getActivity(activityId),
  });

  // A6 wired up — real list from GET /v1/activities/:id/artefacts. Runs
  // alongside the activity detail query (parallel fetches; the panel
  // renders independently of the editor's load state).
  const artefacts = useQuery({
    queryKey: ['activity-artefacts', activityId],
    queryFn: () => listActivityArtefacts(activityId),
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
        <Link href={`/claims/${claimId}`} className="text-sm text-muted-foreground hover:underline">
          ← Back to claim
        </Link>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold">{activity.title}</h1>
          <span className="font-mono text-sm rounded bg-muted px-2 py-0.5">{activity.code}</span>
          <span className="text-xs text-muted-foreground">{kindLabel}</span>
          {/*
            Download PDF button — links straight to the API path with the
            `download` attribute so the browser saves the bytes rather
            than navigating. Suggested filename is derived server-side
            from `Content-Disposition: attachment; filename="..."`.
            Wraps an <a> via shadcn's `asChild` slot so the button
            styling is preserved.
          */}
          <Button asChild variant="outline" size="sm" className="ml-auto">
            <a
              href={`/v1/activities/${activityId}/application.pdf`}
              download
              data-testid="download-application-pdf"
            >
              Download PDF
            </a>
          </Button>
        </div>
      </div>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Edit narrative</h2>
        <ActivityEditor activity={activity} />
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Linked artefacts</h2>
          <Link
            href={`/claims/${claimId}/activities/${activityId}/register`}
            className="text-sm text-primary hover:underline"
          >
            View register →
          </Link>
        </div>
        {artefacts.isPending ? (
          <p className="text-sm text-muted-foreground">Loading linked artefacts…</p>
        ) : artefacts.error ? (
          <p className="text-sm text-red-600">
            Failed to load artefacts:{' '}
            {artefacts.error instanceof Error ? artefacts.error.message : 'Unknown error'}
          </p>
        ) : artefacts.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No artefacts linked yet. Link evidence (media, events, expenditures, time entries) from
            the consultant feed.
          </p>
        ) : (
          <ul className="space-y-2">
            {artefacts.data.map((a) => (
              <li
                key={a.linked_event_id}
                className="border rounded-md px-3 py-2 text-sm bg-card flex flex-wrap items-center gap-2"
              >
                <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-medium text-slate-700">
                  {a.artefact_kind}
                </span>
                <span className="font-mono text-xs break-all">{a.artefact_id}</span>
                {a.link_reason ? (
                  <span className="text-xs text-muted-foreground italic">— {a.link_reason}</span>
                ) : null}
                <span className="ml-auto text-xs text-muted-foreground">
                  {new Date(a.linked_at).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Details</h2>
        <dl className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-muted-foreground">Code</dt>
            <dd className="font-mono">{activity.code}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Kind</dt>
            <dd>{kindLabel}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Project</dt>
            <dd className="font-mono break-all">{activity.project_id}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Claim</dt>
            <dd className="font-mono break-all">{activity.claim_id}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Created</dt>
            <dd>{new Date(activity.created_at).toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Updated</dt>
            <dd>{new Date(activity.updated_at).toLocaleString()}</dd>
          </div>
        </dl>
      </section>
    </main>
  );
}
