/**
 * Persistent state for the claim wizard, stored at `claim.workflow_state`
 * (jsonb, migration 0081). NULL means a legacy claim that uses the
 * pre-wizard tabbed view.
 *
 * `steps['N']` is null until the consultant clicks Agree on step N, at
 * which point it records who agreed and when. Keys are EXACTLY '1'..'5'
 * — `.strict()` rejects unknown step numbers since a stray '6' would
 * indicate the migration or caller is out of sync with the schema.
 *
 * `canAdvance` is NOT stored here; it is a pure function derived live
 * from claim data (Approach 3 — see docs/plans/2026-05-12-claim-wizard-design.md).
 */
import { z } from 'zod';
import { Iso8601, Uuid } from './primitives.js';

export const WorkflowStepNumber = z.number().int().min(1).max(5);
export type WorkflowStepNumber = z.infer<typeof WorkflowStepNumber>;

export const WorkflowStepEntry = z.object({
  agreed_at: Iso8601,
  agreed_by: Uuid,
});
export type WorkflowStepEntry = z.infer<typeof WorkflowStepEntry>;

/**
 * Financing-handoff marker written by `POST /v1/claims/:id/finance`
 * (claim-finalize route). Records that the sealed claim has been handed
 * off to the internal financing rail. No external financier integration —
 * this is a status marker only. `requested_at` is the ISO timestamp of
 * the handoff; `status` is currently always `'requested'` (the union is
 * left open-ended as a single literal so a future "approved"/"disbursed"
 * lifecycle can extend it without a schema break).
 */
export const WorkflowFinancing = z.object({
  status: z.literal('requested'),
  requested_at: Iso8601,
});
export type WorkflowFinancing = z.infer<typeof WorkflowFinancing>;

/**
 * `sealed_at` / `seal_block_id` / `financing` are the claim-finalize
 * markers (claim-finalize route, no migration — they ride on the existing
 * `workflow_state` jsonb). All optional so a wizard claim that has not yet
 * been sealed parses cleanly. `sealed_at` (ISO) + `seal_block_id` (the
 * chain `event.id` of the sealing block) are written together by
 * `POST /v1/claims/:id/seal`; their presence is the "claim is sealed"
 * predicate the finance route gates on.
 */
export const WorkflowState = z.object({
  initialized_at: Iso8601,
  steps: z
    .object({
      '1': WorkflowStepEntry.nullable(),
      '2': WorkflowStepEntry.nullable(),
      '3': WorkflowStepEntry.nullable(),
      '4': WorkflowStepEntry.nullable(),
      '5': WorkflowStepEntry.nullable(),
    })
    .strict(),
  sealed_at: Iso8601.optional(),
  seal_block_id: Uuid.optional(),
  financing: WorkflowFinancing.optional(),
});
export type WorkflowState = z.infer<typeof WorkflowState>;
