'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * P7 Theme C Tasks C.2 + C.3 — Activity audit timeline component.
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
 *
 * Forensic hover-card (C.3): each row has a clickable 🔬 icon that reveals
 * first_recorded_at, content_hash (truncated), chain_position, edit_count.
 */

export interface ForensicMeta {
  first_recorded_at?: string;
  content_hash?: string;
  chain_position?: number;
  edit_count?: number;
  prev_hash?: string | null;
}

export interface TimelineRow {
  kind: 'event' | 'narrative_version' | 'audit_log' | 'suggestion' | 'similarity_flag';
  id: string;
  timestamp: string;
  event_kind?: string;
  chain_verified?: boolean;
  payload?: unknown;
  metadata?: unknown;
  forensic?: ForensicMeta;
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

/** Truncate a hex hash to 8 chars for display. */
export function truncateHash(hash: string): string {
  return hash.length > 8 ? hash.slice(0, 8) : hash;
}

async function fetchTimeline(activityId: string): Promise<TimelineResponse> {
  return apiFetch<TimelineResponse>(`/v1/audit/activity/${activityId}/timeline`);
}

function ForensicCard({ forensic }: { forensic: ForensicMeta }) {
  return (
    <dl
      className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded border border-border bg-muted/50 px-2 py-1.5 text-xs"
      data-testid="forensic-card"
    >
      {forensic.first_recorded_at && (
        <>
          <dt className="text-muted-foreground">Recorded</dt>
          <dd className="font-mono">{new Date(forensic.first_recorded_at).toLocaleString()}</dd>
        </>
      )}
      {forensic.content_hash && (
        <>
          <dt className="text-muted-foreground">Hash</dt>
          <dd className="font-mono">{truncateHash(forensic.content_hash)}</dd>
        </>
      )}
      {forensic.chain_position !== undefined && (
        <>
          <dt className="text-muted-foreground">Chain pos.</dt>
          <dd>#{forensic.chain_position}</dd>
        </>
      )}
      {forensic.edit_count !== undefined && (
        <>
          <dt className="text-muted-foreground">Edit count</dt>
          <dd>{forensic.edit_count}</dd>
        </>
      )}
      {forensic.prev_hash !== undefined && (
        <>
          <dt className="text-muted-foreground">Prev hash</dt>
          <dd className="font-mono">
            {forensic.prev_hash ? truncateHash(forensic.prev_hash) : '—'}
          </dd>
        </>
      )}
    </dl>
  );
}

function TimelineItem({ row }: { row: TimelineRow }) {
  const [showForensic, setShowForensic] = useState(false);

  return (
    <li className="ml-6 pb-4" data-testid={`timeline-row-${row.kind}`}>
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
        {row.forensic && (
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setShowForensic((v) => !v)}
            aria-expanded={showForensic}
            aria-label="Toggle forensic metadata"
            data-testid="forensic-toggle"
          >
            🔬
          </button>
        )}
      </div>

      <time className="block text-xs text-muted-foreground mt-0.5">
        {new Date(row.timestamp).toLocaleString()}
      </time>

      {showForensic && row.forensic && <ForensicCard forensic={row.forensic} />}
    </li>
  );
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
          <TimelineItem key={row.id} row={row} />
        ))}
      </ol>
    </div>
  );
}
