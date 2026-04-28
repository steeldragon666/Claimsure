import type { ClaimStage } from '@cpa/schemas';
// import { apiFetch } from '@/lib/api'; // TODO(C2/A2): wire when A2 ships

/**
 * Pipeline-scoped fetch helpers.
 *
 * Currently a stub: Swimlane A's A2 task delivers `PATCH /v1/claims/:id/stage`,
 * but C2 ships ahead of A2. Until then, this no-ops and resolves immediately
 * so the kanban view (drag-drop + bulk actions) is exercisable end-to-end
 * against an in-memory `Claim[]`.
 *
 * When A2 lands, swap the body for:
 *   await apiFetch(`/v1/claims/${id}/stage`, {
 *     method: 'PATCH',
 *     body: JSON.stringify({ to_stage: toStage }),
 *   });
 *
 * The signature already matches the eventual API contract (path-shaped id,
 * `to_stage` body field) so the swap is a one-line change. Server-side
 * validation (`validateStageTransition` in F10) is the source of truth —
 * the kanban does a *client-side* equivalent only to give immediate UI
 * feedback. The PATCH will reject mismatches if the client is out-of-date.
 */
export interface PatchClaimStageInput {
  id: string;
  toStage: ClaimStage;
}

export async function patchClaimStage(_input: PatchClaimStageInput): Promise<void> {
  // TODO(C2/A2): wire to PATCH /v1/claims/:id/stage when A2 ships.
  return Promise.resolve();
}
