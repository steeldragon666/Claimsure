import type { EvidenceFeedResponse } from '@cpa/schemas';
import { apiFetch } from '@/lib/api';
import { serializeEvidenceParams, type EvidenceUrlParams } from './url-params';

/**
 * GET /v1/evidence — cross-claimant evidence feed.
 *
 * Thin wrapper around `apiFetch` that serialises URL params and returns
 * the typed response. Designed for use with React Query's
 * `useInfiniteQuery` (the `cursor` field feeds `getNextPageParam`).
 */
export async function fetchEvidence(
  params: Partial<EvidenceUrlParams>,
): Promise<EvidenceFeedResponse> {
  const qs = serializeEvidenceParams(params);
  const path = qs ? `/v1/evidence?${qs}` : '/v1/evidence';
  return apiFetch<EvidenceFeedResponse>(path);
}
