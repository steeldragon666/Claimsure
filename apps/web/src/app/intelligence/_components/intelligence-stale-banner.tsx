'use client';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

interface Source {
  id: string;
  name: string;
  stale: boolean;
  last_polled_at: string | null;
  last_polled_status: string | null;
  enabled: boolean;
}

interface SourcesResponse {
  sources: Source[];
}

/**
 * Warning banner shown when any regulatory source hasn't been polled
 * in 7+ days (or has never been polled).
 */
export function IntelligenceStaleBanner() {
  const { data } = useQuery<SourcesResponse>({
    queryKey: ['intelligence-sources'],
    queryFn: () => apiFetch('/v1/intelligence/sources'),
  });

  const staleSources = (data?.sources ?? []).filter((s) => s.enabled && s.stale);

  if (staleSources.length === 0) return null;

  return (
    <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
      <p className="text-sm font-medium text-amber-800">Stale sources detected</p>
      <p className="text-xs text-amber-700 mt-1">
        {staleSources.length} source{staleSources.length > 1 ? 's have' : ' has'} not been polled in
        over 7 days: {staleSources.map((s) => s.name).join(', ')}. The daily scrape may be failing —
        check the source connectors.
      </p>
    </div>
  );
}
