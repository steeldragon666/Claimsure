'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

/**
 * Response from `POST /v1/engagement/:id/countersign` (task 02). The
 * `countersignedAt` is server-stamped; we don't echo it back to the
 * panel because the subsequent `claim-engagement` refetch already
 * carries it on the engagement row.
 */
export interface CountersignEngagementResponse {
  countersignedAt: string;
}

/**
 * Mutation for the "Countersign" CTA, visible only in the `signed`
 * variant. The endpoint requires a session and tenant scoping via RLS —
 * the cookie carries both. Invalidates `claim-engagement` so the panel
 * flips to the `countersigned` variant on success.
 *
 * Takes `claimId` so we can invalidate the right query key; the actual
 * request targets the engagement id (passed at mutate time) because the
 * countersign endpoint is keyed off the engagement row, not the claim.
 */
export function useCountersignEngagement(claimId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (engagementId: string) =>
      apiFetch<CountersignEngagementResponse>(`/v1/engagement/${engagementId}/countersign`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['claim-engagement', claimId] });
    },
  });
}
