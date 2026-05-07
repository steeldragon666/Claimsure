import { apiFetch } from '@/lib/api';

/**
 * P9 Phase 3 — Financier portal API client.
 *
 * Typed wrappers around the federation read endpoints. All data is
 * fetched via the standard session cookie; RLS policies in the database
 * automatically scope results to claims shared via federation_share.
 */

// ---------- Types ----------

export interface FederationShare {
  id: string;
  subject_tenant_id: string;
  subject_tenant_name: string;
  source_tenant_id: string;
  source_tenant_name: string;
  granted_at: string;
  expires_at: string | null;
}

export interface FederatedClaim {
  id: string;
  subject_tenant_id: string;
  subject_tenant_name: string;
  project_id: string;
  project_name: string;
  fiscal_year: number;
  stage: string;
}

export interface FederatedActivity {
  id: string;
  code: string;
  title: string;
  description: string | null;
}

export interface FederatedNarrative {
  id: string;
  section_kind: string;
  content: string;
  version: number;
  content_hash: string;
  created_at: string;
}

export interface FederatedClaimDetail {
  claim: FederatedClaim;
  activities: FederatedActivity[];
  narratives: FederatedNarrative[];
}

// ---------- API functions ----------

export function fetchShares(): Promise<FederationShare[]> {
  return apiFetch<FederationShare[]>('/v1/federation/shares');
}

export function fetchSharedClaims(shareId: string): Promise<FederatedClaim[]> {
  return apiFetch<FederatedClaim[]>(`/v1/federation/shares/${shareId}/claims`);
}

export function fetchClaimDetail(shareId: string, claimId: string): Promise<FederatedClaimDetail> {
  return apiFetch<FederatedClaimDetail>(`/v1/federation/shares/${shareId}/claims/${claimId}`);
}
