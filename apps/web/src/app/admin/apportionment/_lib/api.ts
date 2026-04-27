import type { TimeEntry } from '@cpa/schemas';
import { apiFetch } from '@/lib/api';

/**
 * Apportionment workbench API helpers (B23).
 *
 * Thin wrappers over `apiFetch` (the project-wide cookie-aware fetch)
 * for the four /v1/time-entries endpoints. Mirrors the
 * subject-tenants/_lib/api.ts pattern.
 */

export interface ListTimeEntriesParams {
  subject_tenant_id: string;
  employee_id?: string;
  from?: string;
  to?: string;
  include_flagged?: boolean;
}

export interface ListTimeEntriesResponse {
  time_entries: TimeEntry[];
}

export async function listTimeEntries(params: ListTimeEntriesParams): Promise<TimeEntry[]> {
  const qs = new URLSearchParams();
  qs.set('subject_tenant_id', params.subject_tenant_id);
  if (params.employee_id) qs.set('employee_id', params.employee_id);
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  if (params.include_flagged) qs.set('include_flagged', 'true');
  const body = await apiFetch<ListTimeEntriesResponse>(`/v1/time-entries?${qs.toString()}`);
  return body.time_entries;
}

export async function setApportionment(id: string, apportionment_pct: number): Promise<TimeEntry> {
  const body = await apiFetch<{ time_entry: TimeEntry }>(`/v1/time-entries/${id}/apportionment`, {
    method: 'PATCH',
    body: JSON.stringify({ apportionment_pct }),
  });
  return body.time_entry;
}

export async function clearFlag(id: string): Promise<TimeEntry> {
  const body = await apiFetch<{ time_entry: TimeEntry }>(`/v1/time-entries/${id}/clear-flag`, {
    method: 'POST',
  });
  return body.time_entry;
}
