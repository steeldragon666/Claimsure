'use client';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

/** Mirror of the server response shape for GET /v1/consultant/kpis. */
export interface ConsultantKpisResponse {
  activeClaims: number;
  evidenceIndexed: number;
  atRisk: number;
  /** 0-100, integer. */
  chainCoveragePct: number;
  deltas: {
    /** activeClaims(fy) - activeClaims(fy-1). null only if server suppresses. */
    activeClaimsVsLastFy: number | null;
    /** Rounded integer percent change vs last FY. null if prior FY had 0. */
    evidenceIndexedPctYoY: number | null;
    /** Requires daily snapshot job; currently always null server-side. */
    atRiskVsYesterday: number | null;
    /** Integer percentage-point delta vs last FY. null if no prior data. */
    chainCoveragePtsYoY: number | null;
  };
}

/**
 * Fetches the four KPI numbers + their trend deltas for the consultant
 * dashboard strip. Accepts either `FY26` or the 4-digit fiscal year.
 *
 * Tenant scoping comes from the cpa_session cookie (RLS-enforced
 * server-side) — no tenant id leaks through the URL.
 */
export function useConsultantKpis(params: { fy: string | number }) {
  const search = new URLSearchParams({ fy: String(params.fy) });
  return useQuery({
    queryKey: ['consultant-kpis', params.fy],
    queryFn: () =>
      apiFetch<ConsultantKpisResponse>(`/v1/consultant/kpis?${search.toString()}`),
  });
}
