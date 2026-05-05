'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * P7 Theme C Task C.2 — Activity audit timeline component.
 *
 * Vertical timeline showing all audit-relevant events for an activity:
 * chain events, narrative draft versions, audit_log entries, prompt
 * suggestions, and multi-entity similarity flags (when p7d lands).
 *
 * Icons per kind:
 *   event           → 📥
 *   narrative_version → ✏️
 *   audit_log       → 🔍
 *   suggestion      → 💡
 *   similarity_flag → ⚠️
 *
 * Chain verification: green checkmark for chain_verified=true, red X if false.
 */

export interface TimelineRow {
  kind: 'event' | 'narrative_version' | 'audit_log' | 'suggestion' | 'similarity_flag';
  id: string;
  timestamp: string;
  event_kind?: string;
  chain_verified?: boolean;
  payload?: unknown;
  metadata?: unknown;
}

export interface TimelineResponse {
  timeline: TimelineRow[];
  chain_status: {
    verified: boolean;
    head_hash: string | null;
    event_count: number;
    first_break_at: number | null;
  };
}

const KIND_ICONS: Record<TimelineRow['kind'], string> = {
  event: '📥',
  narrative_version: '✏️',
  audit_log: '🔍',
  suggestion: '💡',
  similarity_flag: '⚠️',
};

const KIND_LABELS: Record<TimelineRow['kind'], string> = {
  event: 'Event',
  narrative_version: 'Narrative version',
  audit_log: 'Audit log',
  suggestion: 'Suggestion',
  similarity_flag: 'Similarity flag',
};

async function fetchTimeline(activityId: string): Promise<TimelineResponse> {
  return apiFetch<TimelineResponse>(`/v1/audit/activity/${activityId}/timeline`);
}

export function AuditTimeline({ activityId }: { activityId: string }) {
  const { data, isPending, error } = useQuery({
    queryKey: ['audit-timeline', activityId],
    queryFn: () => fetchTimeline(activityId),
  });

  if (isPending) {
    return (
      <div className="text-sm text-muted-foreground" data-testid="audit-timeline-loading">
        Loading audit timeline…
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-sm text-red-600" data-testid="audit-timeline-error">
        Failed to load audit timeline: {error instanceof Error ? error.message : 'Unknown error'}
      </div>
    );
  }

  if (!data || data.timeline.length === 0) {
    return (
      <div className="text-sm text-muted-foreground" data-testid="audit-timeline-empty">
        No audit events recorded yet.
      </div>
    );
  }

  return (
    <div data-testid="audit-timeline">
      {/* Chain status badge */}
      <div className="mb-4 flex items-center gap-2 text-sm">
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
            data.chain_status.verified
              ? 'bg-green-50 text-green-700 border border-green-200'
              : 'bg-red-50 text-red-700 border border-red-200',
          )}
          data-testid="chain-status-badge"
        >
          {data.chain_status.verified ? '✓' : '✗'} Chain{' '}
          {data.chain_status.verified ? 'verified' : 'broken'}
        </span>
        <span className="text-muted-foreground">
          {data.chain_status.event_count} event{data.chain_status.event_count !== 1 ? 's' : ''} in
          chain
        </span>
      </div>

      {/* Vertical timeline */}
      <ol className="relative border-l border-border ml-3 space-y-0">
        {data.timeline.map((row) => (
          <li key={row.id} className="ml-6 pb-4" data-testid={`timeline-row-${row.kind}`}>
            {/* Timeline dot */}
            <span className="absolute -left-3 flex h-6 w-6 items-center justify-center rounded-full bg-card border border-border text-xs">
              {KIND_ICONS[row.kind]}
            </span>

            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-sm font-medium">{KIND_LABELS[row.kind]}</span>
              {row.event_kind && (
                <span className="font-mono text-xs text-muted-foreground">{row.event_kind}</span>
              )}
              {row.kind === 'event' && row.chain_verified !== undefined && (
                <span
                  className={cn('text-xs', row.chain_verified ? 'text-green-600' : 'text-red-600')}
                  data-testid="chain-verified-indicator"
                >
                  {row.chain_verified ? '✓' : '✗'}
                </span>
              )}
            </div>

            <time className="block text-xs text-muted-foreground mt-0.5">
              {new Date(row.timestamp).toLocaleString()}
            </time>
          </li>
        ))}
      </ol>
    </div>
  );
}
