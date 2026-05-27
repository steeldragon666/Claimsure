'use client';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, NotFoundError } from '@/lib/api';

/**
 * Engagement status surfaced through `claim.engagement_status` (migration
 * 0085). Mirrors the six values in the Wizard Step 1 plan — each maps to a
 * distinct UI state in `<EngagementPanel>`. `pending_send` is the synthetic
 * initial state when no engagement_letter row exists yet for the claim.
 */
export type EngagementStatus =
  | 'pending_send'
  | 'sent'
  | 'signed'
  | 'countersigned'
  | 'declined'
  | 'expired';

/**
 * Shape returned by `GET /v1/claims/:id/engagement` (task 02 endpoint).
 *
 * When no engagement_letter row exists for the claim, the API returns
 * `{ status: 'pending_send', engagement: null }`. Once a row exists the
 * `engagement` object carries the timestamps + signer info needed to drive
 * the panel layout. `pdfEvidenceId` becomes non-null after the
 * `engagement-letter-render-pdf` job completes (task 03).
 */
export interface ClaimEngagementResponse {
  status: EngagementStatus;
  engagement: {
    id: string;
    sentToClaimantAt: string | null;
    signedByClaimantAt: string | null;
    signedByClaimantName: string | null;
    countersignedAt: string | null;
    countersignedByUserName: string | null;
    declinedAt: string | null;
    declinedReason: string | null;
    expiresAt: string | null;
    pdfEvidenceId: string | null;
  } | null;
}

/**
 * Fetches the current engagement-letter state for a claim. The Wizard
 * Step 1 panel reads this to decide which of six variants to render.
 *
 * Returns `pending_send` (with `engagement: null`) on 404 — that's the
 * "no letter sent yet" branch and we want the panel to render the Send
 * CTA rather than an error. All other failures bubble up.
 */
export function useClaimEngagement(claimId: string | null | undefined) {
  return useQuery({
    queryKey: ['claim-engagement', claimId],
    enabled: Boolean(claimId),
    queryFn: async () => {
      try {
        return await apiFetch<ClaimEngagementResponse>(`/v1/claims/${claimId}/engagement`);
      } catch (err) {
        if (err instanceof NotFoundError) {
          return { status: 'pending_send', engagement: null } satisfies ClaimEngagementResponse;
        }
        throw err;
      }
    },
  });
}
