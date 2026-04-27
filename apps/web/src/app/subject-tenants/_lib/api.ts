import type {
  ClassifiableKind,
  Event as ApiEvent,
  ListEventsFilter,
  SubjectTenant,
  SubjectTenantKind,
} from '@cpa/schemas';
import { apiFetch } from '@/lib/api';

export type { ApiEvent, ClassifiableKind, ListEventsFilter };

export interface SubjectTenantDetail {
  subject_tenant: SubjectTenant;
  event_count: number;
  head_hash: string | null;
}

export interface ChainStatus {
  verified: boolean;
  head_hash: string | null;
  event_count: number;
  first_break_at: number | null;
}

export interface ListEventsOptions {
  subject_tenant_id: string;
  filter?: ListEventsFilter;
  limit?: number;
  cursor?: string;
}

export interface ListEventsResponse {
  events: ApiEvent[];
  next_cursor: string | null;
}

export interface CreateEventInput {
  subject_tenant_id: string;
  raw_text: string;
  captured_at?: string;
}

export interface OverrideEventInput {
  new_kind: ClassifiableKind;
  reason: string;
}

/**
 * Typed fetch helpers for the subject-tenant + event surfaces.
 *
 * These wrap `apiFetch` (the project-wide cookie-aware fetch in
 * `@/lib/api`) so every call sends the cpa_session cookie and surfaces
 * typed errors (UnauthenticatedError, ConflictError, etc).
 *
 * URL prefix is `/v1/...` because `next.config.ts` rewrites `/v1/:path*`
 * to the Fastify API on localhost:3000. Matches the P1 hooks (use-users,
 * use-whoami) — see those for the established pattern.
 */

export async function listSubjectTenants(): Promise<SubjectTenant[]> {
  const body = await apiFetch<{ subject_tenants: SubjectTenant[] }>('/v1/subject-tenants');
  return body.subject_tenants;
}

export interface CreateSubjectTenantInput {
  name: string;
  kind: SubjectTenantKind;
}

export async function createSubjectTenant(input: CreateSubjectTenantInput): Promise<SubjectTenant> {
  const body = await apiFetch<{ subject_tenant: SubjectTenant }>('/v1/subject-tenants', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return body.subject_tenant;
}

export async function getSubjectTenant(id: string): Promise<SubjectTenantDetail> {
  return apiFetch<SubjectTenantDetail>(`/v1/subject-tenants/${id}`);
}

export async function getChainStatus(id: string): Promise<ChainStatus> {
  return apiFetch<ChainStatus>(`/v1/subject-tenants/${id}/chain-status`);
}

export async function listEvents(opts: ListEventsOptions): Promise<ListEventsResponse> {
  const qs = new URLSearchParams();
  qs.set('subject_tenant_id', opts.subject_tenant_id);
  if (opts.filter) qs.set('filter', opts.filter);
  if (opts.limit) qs.set('limit', String(opts.limit));
  if (opts.cursor) qs.set('cursor', opts.cursor);
  return apiFetch<ListEventsResponse>(`/v1/events?${qs.toString()}`);
}

export async function createEvent(input: CreateEventInput): Promise<ApiEvent> {
  const body = await apiFetch<{ event: ApiEvent }>('/v1/events', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return body.event;
}

export async function overrideEvent(id: string, input: OverrideEventInput): Promise<ApiEvent> {
  const body = await apiFetch<{ override_event: ApiEvent }>(`/v1/events/${id}/override`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return body.override_event;
}
