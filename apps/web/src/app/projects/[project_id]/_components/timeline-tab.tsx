'use client';
import { useQuery } from '@tanstack/react-query';
import type { Project } from '@cpa/schemas';
import { KindChip } from '@/app/subject-tenants/[id]/_components/kind-chip';
import { useWhoami } from '@/hooks/use-whoami';
import { PROJECT_TIMELINE_KINDS, summariseEvent } from '@/lib/summarise-event';
import { listProjectEvents } from '../../_lib/api';

/**
 * Project-detail Timeline tab (T-A7).
 *
 * Renders a reverse-chronological feed of project + per-claim events,
 * narrowed by `PROJECT_TIMELINE_KINDS` (the project lifecycle plus the
 * narrative + activity events that happen under the project). The
 * server returns events scoped by subject_tenant_id (the only filter
 * GET /v1/events accepts beyond activity_id); the
 * `listProjectEvents` helper filters client-side to project-scoped
 * rows. See its docstring for the back-end TODO.
 *
 * Reuses the shared `summariseEvent` helper (promoted from
 * register/_components/ in this commit) so the project surface and the
 * register surface format payloads consistently. The KindChip is
 * reused from the consultant-portal feed for the same reason — every
 * timeline-style surface in the app uses the same colour/typography.
 */

const formatRelative = (iso: string): string => {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const diffMs = Date.now() - then;
  const sec = Math.round(diffMs / 1000);
  if (sec < 45) return 'just now';
  if (sec < 90) return '1 minute ago';
  const min = Math.round(sec / 60);
  if (min < 45) return `${min} minutes ago`;
  if (min < 90) return '1 hour ago';
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hours ago`;
  const day = Math.round(hr / 24);
  if (day === 1) return 'yesterday';
  if (day < 14) return `${day} days ago`;
  return new Date(iso).toLocaleDateString();
};

export interface TimelineTabProps {
  project: Pick<Project, 'id' | 'subject_tenant_id'>;
}

export function TimelineTab({ project }: TimelineTabProps) {
  // Firm scope in the query key — see project-list.tsx for the longer
  // rationale. Subject_tenant_id is always defined on the project here,
  // so it's a fine fallback when whoami hasn't resolved yet.
  const whoami = useWhoami();
  const firmScope = whoami.data?.user.tenantId ?? project.subject_tenant_id;

  const feed = useQuery({
    queryKey: ['project-timeline', firmScope, project.id],
    queryFn: ({ signal }) =>
      listProjectEvents(
        {
          project,
          kinds: [...PROJECT_TIMELINE_KINDS],
          limit: 200,
        },
        signal,
      ),
  });

  if (feed.isPending) {
    return <p className="text-sm text-muted-foreground">Loading timeline…</p>;
  }
  if (feed.error) {
    return (
      <p className="text-sm text-red-600">
        Failed to load timeline:{' '}
        {feed.error instanceof Error ? feed.error.message : 'Unknown error'}
      </p>
    );
  }
  if (feed.data.events.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No timeline events for this project yet. PROJECT_CREATED, claim stage transitions, and
        narrative events captured under this project will appear here.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {feed.data.events.map((event) => (
        <article key={event.id} className="border rounded-md p-4 space-y-2 bg-card">
          <header className="flex flex-wrap items-center gap-2">
            <KindChip kind={event.effective_kind} />
            <span className="ml-auto text-xs text-muted-foreground" title={event.captured_at}>
              {formatRelative(event.captured_at)}
            </span>
          </header>
          <p className="text-sm whitespace-pre-wrap break-words">{summariseEvent(event)}</p>
        </article>
      ))}
    </div>
  );
}
