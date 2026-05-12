import { z } from 'zod';

export const WorkflowStepNumber = z.number().int().min(1).max(5);
export type WorkflowStepNumber = z.infer<typeof WorkflowStepNumber>;

export const WorkflowStepEntry = z.object({
  agreed_at: z.string(),
  agreed_by: z.string().uuid(),
});
export type WorkflowStepEntry = z.infer<typeof WorkflowStepEntry>;

export const WorkflowState = z.object({
  initialized_at: z.string(),
  steps: z.object({
    '1': WorkflowStepEntry.nullable(),
    '2': WorkflowStepEntry.nullable(),
    '3': WorkflowStepEntry.nullable(),
    '4': WorkflowStepEntry.nullable(),
    '5': WorkflowStepEntry.nullable(),
  }),
});
export type WorkflowState = z.infer<typeof WorkflowState>;
