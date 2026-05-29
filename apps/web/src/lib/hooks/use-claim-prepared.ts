'use client';
import { useQuery } from '@tanstack/react-query';
import { getPreparedContent, type PreparedContent } from '@/app/consultant/_components/claims-api';

/**
 * Fetches the per-step AI-prepared content for a claim
 * (GET /v1/claims/:id/prepared). This is the READ surface for the
 * artefacts the "Prepare claim" pipeline authors — the wizard renders the
 * real per-step content above each Approve button instead of the
 * "awaiting AI preparation" placeholder.
 *
 * Pairs with `useClaimWorkflow` (state + canAdvance gates): the workflow
 * query drives the per-step Approve gating, this query supplies the
 * content the consultant is judging. Both are invalidated by the same
 * approve / reopen mutations, so the prepared content refreshes after a
 * pipeline-triggering step agree (e.g. step-1 agree → activity proposals
 * land; step-2 agree → evidence bindings land).
 *
 * A 404 (claim not in this firm) bubbles as the query error. Each step's
 * `prepared` flag is false (with empty arrays) when nothing has been
 * generated yet — the view renders an honest "still preparing" state.
 */
export interface UseClaimPreparedResult {
  data: PreparedContent | undefined;
  isLoading: boolean;
  error: Error | null;
}

export function useClaimPrepared(claimId: string | null | undefined): UseClaimPreparedResult {
  const query = useQuery<PreparedContent>({
    queryKey: ['claim-prepared', claimId],
    enabled: Boolean(claimId),
    queryFn: () => getPreparedContent(claimId as string),
    // Pipeline jobs are async (pg-boss + Sonnet/Haiku) — content arrives
    // seconds after a triggering step agree. Poll while the claim is open
    // so newly-authored content appears without a manual refresh.
    refetchInterval: 15_000,
  });

  return {
    data: query.data,
    isLoading: query.isLoading,
    error: query.error,
  };
}

export type { PreparedContent };
