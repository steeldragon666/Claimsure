'use client';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Project } from '@cpa/schemas';
import { useWhoami } from '@/hooks/use-whoami';
import { cn } from '@/lib/utils';
import { listProjects } from '../_lib/api';
import {
  PROJECT_LIST_SORT_LABELS,
  PROJECT_LIST_STATUS_LABELS,
  type ProjectListSort,
  type ProjectListStatus,
} from '../_lib/url-params';

/**
 * /projects list view (T-A7). Renders:
 *   - A status chip strip (Active / Archived / All) bound to ?status=.
 *   - A sort selector (Name / Last activity / Claim count) bound to
 *     ?sort=.
 *   - A list of project cards; one per project. Card shows name,
 *     id-suffix (no slug column on the wire shape), claim count
 *     (deferred: no API endpoint for project→claim count without
 *     fan-out, see {@link enrichProject}), most-recent-activity
 *     timestamp (also deferred), status badge.
 *
 * Status filter caveat: GET /v1/projects has no `status` query param
 * today — the route hardcodes `WHERE archived_at IS NULL`, so the
 * Archived and All chips render an empty list (with explanatory copy).
 * Once the route accepts `?status=...` (TODO flagged in
 * `_lib/api.ts#ListProjectsOptions`) the chips light up; the page is
 * already shaped to consume the broader response.
 *
 * Sort + claim-count caveat: the API doesn't return a per-project
 * claim count, and GET /v1/claims has no project_id filter, so
 * "claim count" and "last activity" sorts can't be populated without
 * an N-projects fan-out that defeats the page's load budget. Sort by
 * name is fully wired; the other two are accepted parameters and
 * sort by `started_at DESC` as a placeholder until the API surfaces
 * counts.
 */

export interface ProjectListProps {
  status: ProjectListStatus;
  sort: ProjectListSort;
}

const STATUSES: ReadonlyArray<ProjectListStatus> = ['active', 'archived', 'all'];

const SORTS: ReadonlyArray<ProjectListSort> = ['name', 'recent', 'claim_count'];

/**
 * Sort values that are wired through to a real ordering. `name` is
 * fully implemented; `recent` and `claim_count` are accepted by the URL
 * parser (so old links don't break) but the underlying signals aren't
 * on the wire shape today, so the dropdown disables them with a
 * "(coming soon)" suffix instead of silently falling back. See
 * `_lib/url-params.ts#ProjectListSort` for the longer rationale.
 */
const IMPLEMENTED_SORTS: ReadonlySet<ProjectListSort> = new Set(['name']);

export function ProjectList({ status, sort }: ProjectListProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Firm scope in the query key prevents cached project lists from
  // leaking across tenant switches. `tenantId` may be null on first
  // whoami load — use 'unknown' as a stable placeholder. The actual
  // /v1/projects fetch is gated by AuthGuard upstream, so by the time
  // this query runs whoami has resolved and the placeholder is
  // effectively never the real key.
  const whoami = useWhoami();
  const firmScope = whoami.data?.user.tenantId ?? 'unknown';

  const projects = useQuery({
    queryKey: ['projects', firmScope],
    queryFn: ({ signal }) => listProjects(undefined, signal),
  });

  const onSelectStatus = useCallback(
    (next: ProjectListStatus) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === 'active') {
        params.delete('status'); // default — keep the URL clean
      } else {
        params.set('status', next);
      }
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const onSelectSort = useCallback(
    (next: ProjectListSort) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === 'name') {
        params.delete('sort');
      } else {
        params.set('sort', next);
      }
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  // Filter + sort the list client-side. See the docstring at the top of
  // the file for why this lives here rather than on the wire.
  const visibleProjects = useMemo(() => {
    if (!projects.data) return [] as Project[];
    const filtered = projects.data.filter((p) => {
      if (status === 'all') return true;
      if (status === 'archived') return p.archived_at !== null;
      // 'active' — default. Note: today the API only returns
      // active projects (the route hardcodes archived_at IS NULL), so
      // this branch matches everything in the response. Once the route
      // accepts `?status=archived` and the page passes it through, this
      // filter narrows the response correctly.
      return p.archived_at === null;
    });
    const sorted = [...filtered];
    sorted.sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name);
      // 'recent' / 'claim_count' — neither metric is on the wire
      // shape today (see file docstring). Use started_at DESC as a
      // stable, useful placeholder so the chip is at least visibly
      // doing something.
      return new Date(b.started_at).getTime() - new Date(a.started_at).getTime();
    });
    return sorted;
  }, [projects.data, status, sort]);

  return (
    <div className="space-y-6">
      {/* Status chip strip */}
      <div role="tablist" aria-label="Filter by status" className="flex flex-wrap gap-1 border-b">
        {STATUSES.map((s) => {
          const isActive = s === status;
          return (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onSelectStatus(s)}
              className={cn(
                'inline-flex items-center px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
                isActive
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {PROJECT_LIST_STATUS_LABELS[s]}
            </button>
          );
        })}
      </div>

      {/* Sort selector — small label + native <select> rather than a custom
          dropdown, since shadcn Select is forbidden by the brief and the
          choice space is tiny (3 values). Unimplemented options render
          as `disabled` with a "(coming soon)" suffix; the URL parser
          still accepts them so old `?sort=...` links don't break, but
          the UI surface stops the user from selecting them and lets
          the placeholder fallback (started_at DESC) run silently. */}
      <div className="flex items-center gap-2 text-sm">
        <label htmlFor="project-sort" className="text-muted-foreground">
          Sort:
        </label>
        <select
          id="project-sort"
          value={sort}
          onChange={(e) => onSelectSort(e.target.value as ProjectListSort)}
          className="border rounded px-2 py-1 text-sm bg-background"
        >
          {SORTS.map((s) => {
            const isImplemented = IMPLEMENTED_SORTS.has(s);
            const label = isImplemented
              ? PROJECT_LIST_SORT_LABELS[s]
              : `${PROJECT_LIST_SORT_LABELS[s]} (coming soon)`;
            return (
              <option key={s} value={s} disabled={!isImplemented}>
                {label}
              </option>
            );
          })}
        </select>
      </div>

      {/* List */}
      {projects.isPending ? (
        <p className="text-sm text-muted-foreground">Loading projects…</p>
      ) : projects.error ? (
        <p className="text-sm text-red-600">
          Failed to load projects:{' '}
          {projects.error instanceof Error ? projects.error.message : 'Unknown error'}
        </p>
      ) : visibleProjects.length === 0 ? (
        <EmptyState status={status} />
      ) : (
        <ul className="space-y-2">
          {visibleProjects.map((p) => (
            <li key={p.id}>
              <Link
                href={`/projects/${p.id}`}
                className="block border rounded-md px-4 py-3 hover:bg-muted transition-colors"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-medium">{p.name}</span>
                  <span className="font-mono text-xs text-muted-foreground" title={p.id}>
                    {p.id.slice(0, 8)}
                  </span>
                  <span
                    className={cn(
                      'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
                      p.archived_at !== null
                        ? 'border-slate-200 bg-slate-50 text-slate-600'
                        : 'border-emerald-200 bg-emerald-50 text-emerald-700',
                    )}
                  >
                    {p.archived_at !== null ? 'Archived' : 'Active'}
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    Started {new Date(p.started_at).toLocaleDateString()}
                  </span>
                </div>
                {p.description ? (
                  <p className="mt-2 text-xs text-muted-foreground line-clamp-2">{p.description}</p>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EmptyState({ status }: { status: ProjectListStatus }) {
  if (status === 'archived') {
    return (
      <div className="border border-dashed rounded-md py-10 px-4 text-center space-y-2">
        <p className="text-sm font-medium">No archived projects</p>
        <p className="text-xs text-muted-foreground">
          Archived projects are filtered out of the default list. Note: the API currently hides
          archived projects entirely (route filters <code>archived_at IS NULL</code>); a follow-up
          will widen the response.
        </p>
      </div>
    );
  }
  if (status === 'all') {
    return (
      <div className="border border-dashed rounded-md py-10 px-4 text-center space-y-2">
        <p className="text-sm font-medium">No projects yet for this firm</p>
        <p className="text-xs text-muted-foreground">
          When the API exposes archived projects, this view will combine active and archived. Until
          then, the Active and Archived tabs are the only places to see your projects.
        </p>
      </div>
    );
  }
  return (
    <div className="border border-dashed rounded-md py-10 px-4 text-center space-y-3">
      <p className="text-sm font-medium">No projects yet</p>
      <p className="text-xs text-muted-foreground">
        Projects group activities across one or more fiscal-year claims.
      </p>
      {/* TODO(p4-a-followup): wire this CTA to a create-project dialog once
          the form lands. POST /v1/projects already exists (A1). */}
      <button
        type="button"
        disabled
        className="inline-flex items-center rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground opacity-60 cursor-not-allowed"
        title="Create form deferred to a follow-up commit"
      >
        Create project
      </button>
    </div>
  );
}
