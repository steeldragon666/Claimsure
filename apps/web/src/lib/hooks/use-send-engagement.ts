'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

/**
 * Response from `POST /v1/claims/:id/engagement/send` (task 02). The
 * `sendToken` is the opaque token claimants use to access the public
 * sign URL on mobile or the web fallback (tasks 05/06). The consultant
 * UI doesn't navigate to it but we surface it for debug-channel copy.
 */
export interface SendEngagementResponse {
  engagementId: string;
  sendToken: string;
  expiresAt: string;
}

/**
 * Mutation for the "Send engagement letter" CTA (and the "Resend" /
 * "Send a new engagement letter" variants — same endpoint, the server
 * UPSERTs the engagement_letter row). Invalidates `claim-engagement` so
 * the panel refetches and re-renders into the `sent` variant.
 */
export function useSendEngagement(claimId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => {
      if (!claimId) {
        throw new Error('claimId required to send engagement letter');
      }
      return apiFetch<SendEngagementResponse>(`/v1/claims/${claimId}/engagement/send`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['claim-engagement', claimId] });
    },
  });
}
