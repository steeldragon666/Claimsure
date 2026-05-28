'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ConflictError } from '@/lib/api';
import {
  agreeStep,
  financeClaim,
  getWorkflow,
  initializeWorkflow,
  reopenStep,
  sealClaim,
  type FinanceResult,
  type SealResult,
  type WorkflowResponse,
  type WorkflowState,
  type WorkflowStepKey,
} from '@/app/consultant/_components/claims-api';

/**
 * Fetches the per-step workflow state + the live `canAdvance` gates for a
 * claim (GET /v1/claims/:id/workflow). This is the per-step gating signal:
 * the wizard renders step N's Approve action enabled iff
 * `derived.canAdvance['N'].ok`, and unlocks step N+1 only once
 * `workflow_state.steps['N']` is non-null (agreed).
 *
 * A 400 not_a_wizard_claim (claim has NULL workflow_state — a legacy
 * tabbed claim) is surfaced as `notInitialized: true` rather than an
 * error, so the UI can offer a "Prepare claim" action.
 */
export interface UseClaimWorkflowResult {
  data: WorkflowResponse | undefined;
  isLoading: boolean;
  error: Error | null;
  /** True when the claim exists but has no workflow_state (400). */
  notInitialized: boolean;
}

const NOT_INITIALIZED = Symbol('not_initialized');

export function useClaimWorkflow(claimId: string | null | undefined): UseClaimWorkflowResult {
  const query = useQuery<WorkflowResponse | typeof NOT_INITIALIZED>({
    queryKey: ['claim-workflow', claimId],
    enabled: Boolean(claimId),
    queryFn: async () => {
      try {
        return await getWorkflow(claimId as string);
      } catch (err) {
        // 400 not_a_wizard_claim → claim has no workflow_state yet. Treat
        // as a soft "needs preparing" state, not a hard error.
        if (err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 400) {
          return NOT_INITIALIZED;
        }
        throw err;
      }
    },
  });

  const notInitialized = query.data === NOT_INITIALIZED;
  return {
    data: notInitialized ? undefined : (query.data as WorkflowResponse | undefined),
    isLoading: query.isLoading,
    error: query.error,
    notInitialized,
  };
}

/**
 * "Prepare claim" for a claim that has no workflow_state yet (legacy
 * claims). Most claims are born wizard-ready, but this covers the case
 * where the workflow hasn't been initialized. A 409 (already initialized)
 * is swallowed and treated as success — the desired end state is reached
 * either way. Invalidates the workflow query so the wizard renders.
 */
export function useInitializeWorkflow(claimId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation<WorkflowState | null, Error, void>({
    mutationFn: async () => {
      if (!claimId) throw new Error('claimId required to prepare the claim.');
      try {
        return await initializeWorkflow(claimId);
      } catch (err) {
        if (err instanceof ConflictError) return null; // already initialized — fine
        throw err;
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['claim-workflow', claimId] });
    },
  });
}

/**
 * Approve (agree) a single wizard step. Per the spec there is NO
 * "approve all" — judgement is per-step, and the next step unlocks only
 * after the prior is approved. Invalidates the workflow query so the
 * fresh canAdvance gates + agreed timestamps drive the next render.
 *
 * A 409 cannot_advance bubbles up as ConflictError carrying the route's
 * reason string (e.g. "2 proposed activities still pending"), which the
 * wizard shows inline.
 */
export function useAgreeStep(claimId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation<WorkflowState, Error, WorkflowStepKey>({
    mutationFn: (step: WorkflowStepKey) => {
      if (!claimId) throw new Error('claimId required to approve a step.');
      return agreeStep(claimId, step);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['claim-workflow', claimId] });
    },
  });
}

/**
 * Reopen (un-approve) a single wizard step. Used when the consultant wants
 * to revisit a previously-approved step. No cascade server-side.
 */
export function useReopenStep(claimId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation<WorkflowState, Error, WorkflowStepKey>({
    mutationFn: (step: WorkflowStepKey) => {
      if (!claimId) throw new Error('claimId required to reopen a step.');
      return reopenStep(claimId, step);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['claim-workflow', claimId] });
    },
  });
}

/**
 * Seal the claim onto the evidence chain (POST /v1/claims/:id/seal). The
 * terminal Review step gates the affordance: enabled only once all six
 * wizard steps are approved. On success the workflow query is invalidated
 * so any state derived from it refreshes, and the SealResult (block_id +
 * sealed_at) is returned to the view to render the sealed state.
 *
 * Error handling is left to the view:
 *   - ConflictError (409 not_approved) → inline "approve all steps first".
 *   - NotFoundError (404)              → endpoint not deployed yet; the view
 *                                        shows an honest "not available yet".
 * Both bubble up as the mutation error — neither crashes the wizard.
 */
export function useSealClaim(claimId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation<SealResult, Error, void>({
    mutationFn: () => {
      if (!claimId) throw new Error('claimId required to seal the claim.');
      return sealClaim(claimId);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['claim-workflow', claimId] });
      void qc.invalidateQueries({ queryKey: ['client-claims'] });
    },
  });
}

/**
 * Submit a sealed claim's refund to financing (POST /v1/claims/:id/finance).
 * Enabled only once the claim is sealed. Returns the FinanceResult
 * (financing.status + requested_at) so the view can render the
 * "financing requested" state.
 *
 * Error handling mirrors useSealClaim:
 *   - ConflictError (409 not_sealed) → inline "seal the claim first".
 *   - NotFoundError (404)            → endpoint not deployed yet.
 */
export function useFinanceClaim(claimId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation<FinanceResult, Error, void>({
    mutationFn: () => {
      if (!claimId) throw new Error('claimId required to finance the claim.');
      return financeClaim(claimId);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['client-claims'] });
    },
  });
}

// Re-export the workflow types for view consumers that only import from
// the hook module.
export type { FinanceResult, SealResult, WorkflowResponse, WorkflowState, WorkflowStepKey };
