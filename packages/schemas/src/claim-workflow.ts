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
});
export type WorkflowState = z.infer<typeof WorkflowState>;
