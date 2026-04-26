import type { SubjectTenant, SubjectTenantKind } from '@cpa/schemas';
import { apiFetch } from '@/lib/api';

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

export async function createSubjectTenant(
  input: CreateSubjectTenantInput,
): Promise<SubjectTenant> {
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
