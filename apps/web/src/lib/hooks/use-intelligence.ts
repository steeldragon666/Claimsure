'use client';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

/**
 * Hooks for the consultant Watch page (realtime regulatory news + facts +
 * processing status + insights). All reuse existing read-only endpoints —
 * no new API surface:
 *   - /v1/intelligence/events   recent news/announcements + per-item facts
 *   - /v1/intelligence/sources  scrape pipeline / processing status
 *   - /v1/insights              the "top facts" generative insights feed
 *
 * Each query carries a `refetchInterval` so the page feels realtime via
 * polling (the design choice over SSE) and refetches on window focus.
 */

export interface RegulatoryEvent {
  id: string;
  source_id: string;
  external_id: string;
  raw_title: string;
  raw_content: string;
  source_url: string | null;
  published_at: string;
  classified_at: string | null;
  classification_kind: string | null;
  classification_severity: string | null;
  source_name: string;
}

interface EventsResponse {
  events: RegulatoryEvent[];
  total: number;
}

export interface IntelligenceEventsParams {
  severity?: string;
  kind?: string;
  limit?: number;
  offset?: number;
}

export function useIntelligenceEvents(params: IntelligenceEventsParams) {
  const search = new URLSearchParams();
  if (params.severity && params.severity !== 'all') search.set('severity', params.severity);
  if (params.kind && params.kind !== 'all') search.set('kind', params.kind);
  search.set('limit', String(params.limit ?? 25));
  search.set('offset', String(params.offset ?? 0));

  return useQuery({
    queryKey: ['intelligence-events', params],
    queryFn: () => apiFetch<EventsResponse>(`/v1/intelligence/events?${search.toString()}`),
    refetchInterval: 45_000,
    refetchOnWindowFocus: true,
  });
}

export interface RegulatorySource {
  id: string;
  source_name: string;
  parser_kind: string;
  source_url: string;
  fetch_interval_hours: number;
  enabled: boolean;
  last_polled_at: string | null;
  last_polled_status: string | null;
  stale: boolean;
}

interface SourcesResponse {
  sources: RegulatorySource[];
}

export function useIntelligenceSources() {
  return useQuery({
    queryKey: ['intelligence-sources'],
    queryFn: () => apiFetch<SourcesResponse>('/v1/intelligence/sources'),
    refetchInterval: 45_000,
    refetchOnWindowFocus: true,
  });
}

export interface WatchInsight {
  id: string;
  rank: number;
  category: string;
  icon: string;
  headline: string;
  detail: string;
  source: string;
}

export interface WatchInsightsResponse {
  insights: WatchInsight[];
  generated_at: string;
  scope: string;
  subject_tenant_id: string | null;
  budget: {
    claim_id: string | null;
    used_aud_cents: number;
    remaining_aud_cents: number;
    budget_aud_cents: number;
    status: 'free_tier' | 'over_quota';
  } | null;
  generative_status:
    | 'fresh'
    | 'cached'
    | 'no_claim'
    | 'over_quota'
    | 'budget_billable'
    | 'no_evidence'
    | 'disabled';
}

export function useWatchInsights(scope = 'watch') {
  return useQuery({
    queryKey: ['watch-insights', scope],
    queryFn: () =>
      apiFetch<WatchInsightsResponse>(`/v1/insights?scope=${encodeURIComponent(scope)}`),
    refetchInterval: 60_000,
  });
}
