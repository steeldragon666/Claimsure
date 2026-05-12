/**
 * Typed fetchers for the claim-wizard workflow routes (Tasks 2.2-2.5).
 *
 * Separate from `workflow-api.ts` (auto-allocation + submit-claim pipeline)
 * — this file covers the 5-step wizard stepper endpoints.
 */

import { apiFetch } from '@/lib/api';
import type { WorkflowState } from '@cpa/schemas';

export type CanAdvance = { ok: true } | { ok: false; reason: string };
export type WorkflowResponse = {
  workflow_state: WorkflowState;
  derived: { canAdvance: Record<'1' | '2' | '3' | '4' | '5', CanAdvance> };
};

export async function getWorkflow(claimId: string): Promise<WorkflowResponse> {
  return apiFetch<WorkflowResponse>(`/v1/claims/${claimId}/workflow`);
}

export async function initializeWorkflow(
  claimId: string,
): Promise<{ workflow_state: WorkflowState }> {
  return apiFetch(`/v1/claims/${claimId}/workflow/initialize`, { method: 'POST' });
}

export async function agreeStep(
  claimId: string,
  step: 1 | 2 | 3 | 4 | 5,
): Promise<{ workflow_state: WorkflowState }> {
  return apiFetch(`/v1/claims/${claimId}/workflow/step/${step}/agree`, { method: 'POST' });
}

export async function reopenStep(
  claimId: string,
  step: 1 | 2 | 3 | 4 | 5,
): Promise<{ workflow_state: WorkflowState }> {
  return apiFetch(`/v1/claims/${claimId}/workflow/step/${step}/reopen`, { method: 'POST' });
}
