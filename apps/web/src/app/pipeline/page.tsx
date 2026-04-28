'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Claim } from '@cpa/schemas';
import { AuthGuard } from '@/components/auth-guard';
import { PipelineFilters, type ConsultantOption } from './_components/pipeline-filters';
import { PipelineKanban } from './_components/pipeline-kanban';
import {
  currentFiscalYear,
  parseFiscalYear,
  parseStages,
  parseView,
  type PipelineView,
} from './_components/url-params';
import { useUsers } from '@/hooks/use-users';
import { useWhoami } from '@/hooks/use-whoami';

/**
 * /pipeline — Swimlane C entry point. Renders a filter bar + a view
 * placeholder. Concrete kanban view lands in C2 and the tabular view in
 * C3. C1 establishes the URL-driven filter conventions (?stage, ?view,
 * ?consultant, ?fy, ?sector) and the data-fetch shape.
 *
 * Following the P1 dynamic-route pattern (see subject-tenants/[id]/page.tsx):
 * `'use client'` + AuthGuard wraps the page; URL state is read via
 * useSearchParams. AuthGuard's whoami query is the gate for showing any
 * tenant-scoped data.
 *
 * NOTE: GET /v1/claims doesn't exist yet — that's Swimlane A's A2 task.
 * For C1 we stub the data fetch by short-circuiting useQuery to an empty
 * list. C2/C3 will swap in the real listClaims() call once A2 ships and
 * use the same query key + filter shape.
 */
export default function PipelinePage() {
  return (
    <AuthGuard>
      <Inner />
    </AuthGuard>
  );
}

function Inner() {
  const searchParams = useSearchParams();
  const view = parseView(searchParams.get('view'));
  const stages = parseStages(searchParams.getAll('stage'));
  const consultantId = searchParams.get('consultant');
  const fiscalYear = parseFiscalYear(searchParams.get('fy'), currentFiscalYear());
  const sector = searchParams.get('sector') ?? '';

  // Consultants for the dropdown come from the firm-members list (the
  // existing /v1/users endpoint already returns the active firm's
  // members). Using the same query key as the /users page to share the
  // tanstack cache across pages.
  //
  // Filter to admin + consultant roles only — viewers don't own claims and
  // shouldn't pollute the "Consultant" filter dropdown. UserRef.role is
  // exposed by the /v1/users endpoint (see hooks/use-users.ts).
  const usersQuery = useUsers();
  const consultants = useMemo<ConsultantOption[]>(() => {
    if (!usersQuery.data) return [];
    return usersQuery.data
      .filter((u) => u.role === 'admin' || u.role === 'consultant')
      .map((u) => ({
        id: u.id,
        label: u.displayName ?? u.email,
      }));
  }, [usersQuery.data]);

  // TODO(A2): replace with `listClaims({ stages, consultantId, fiscalYear, sector })`
  // once Swimlane A's GET /v1/claims endpoint ships. Until then we render
  // an empty list so the page shell + filter wiring is exercisable. The
  // query key intentionally mirrors what the real fetch will use, so
  // swapping in the API call is a one-line change.
  const claimsQuery = useQuery({
    queryKey: ['claims', { stages, consultantId, fiscalYear, sector }] as const,
    queryFn: (): Promise<Claim[]> => Promise.resolve([]),
  });

  // Role drives admin-only affordances inside the kanban (revert via
  // context-menu, backward drag-drop, bulk-revert). AuthGuard guarantees
  // `whoami` data is loaded before children render, so the optional chain
  // here is just a TS courtesy — the value will be present.
  const whoami = useWhoami();
  const role = whoami.data?.user.role ?? 'viewer';

  return (
    <main className="container mx-auto space-y-6 px-4 py-8">
      <div>
        <Link href="/" className="text-sm text-muted-foreground hover:underline">
          ← Dashboard
        </Link>
      </div>

      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Pipeline</h1>
        <span className="text-xs text-muted-foreground">
          {claimsQuery.data?.length ?? 0} claim{claimsQuery.data?.length === 1 ? '' : 's'}
        </span>
      </header>

      <PipelineFilters
        view={view}
        stages={stages}
        consultantId={consultantId}
        fiscalYear={fiscalYear}
        sector={sector}
        consultants={consultants}
      />

      <ViewBody
        view={view}
        isPending={claimsQuery.isPending}
        error={claimsQuery.error}
        claims={claimsQuery.data ?? []}
        role={role}
      />
    </main>
  );
}

interface ViewBodyProps {
  view: PipelineView;
  isPending: boolean;
  error: unknown;
  claims: Claim[];
  role: 'admin' | 'consultant' | 'viewer';
}

function ViewBody({ view, isPending, error, claims, role }: ViewBodyProps) {
  if (isPending) {
    return <p className="text-sm text-muted-foreground">Loading claims…</p>;
  }
  if (error) {
    return (
      <p className="text-sm text-red-600">
        Failed to load claims: {error instanceof Error ? error.message : 'Unknown error'}
      </p>
    );
  }
  if (view === 'kanban') {
    return <PipelineKanban claims={claims} role={role} />;
  }
  // C3 (table view) lands the tabular view. Until then, the dashed
  // placeholder communicates the wait.
  return (
    <section
      role="region"
      aria-label="Table view"
      className="rounded-md border border-dashed p-12 text-center"
    >
      <p className="font-medium">Table view coming in C3</p>
      <p className="mt-1 text-sm text-muted-foreground">
        {claims.length === 0
          ? 'No claims match the current filters.'
          : `${claims.length} claim${claims.length === 1 ? '' : 's'} ready to render.`}
      </p>
    </section>
  );
}
