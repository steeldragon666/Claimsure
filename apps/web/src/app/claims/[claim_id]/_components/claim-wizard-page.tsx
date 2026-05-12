'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { getWorkflow } from '../_lib/workflow-client';
import type { WorkflowResponse } from '../_lib/workflow-client';
import { WizardStepper } from './wizard-stepper';
import { WizardStep1UploadEvidence } from './wizard-step-1-upload';

type StepNum = 1 | 2 | 3 | 4 | 5;

/**
 * Resolve the lowest unagreed step from the workflow state.
 * Falls back to step 1 if all steps are agreed (shouldn't happen
 * in normal flow since step 5 = final generate).
 */
function lowestUnagreedStep(data: WorkflowResponse): StepNum {
  const steps = data.workflow_state.steps;
  for (let i = 1; i <= 5; i++) {
    if (steps[String(i) as '1'] == null) return i as StepNum;
  }
  return 1;
}

/**
 * Parse `?step=N` from URL search params, validating that N is 1-5.
 * Returns null if absent or invalid so the caller can fall back to
 * the lowest unagreed step.
 */
function parseStepParam(raw: string | null): StepNum | null {
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 5) return n as StepNum;
  return null;
}

/**
 * ClaimWizardPage — orchestrator for the 5-step claim wizard.
 *
 * Reads `?step=N` from the URL to determine the active step. If
 * absent, defaults to the lowest unagreed step (derived from the
 * workflow state). Renders the WizardStepper progress strip and
 * delegates to the active step component.
 *
 * Only Step 1 (Upload Evidence) is implemented; Steps 2-5 render
 * placeholder shells until their respective tasks ship.
 */
export function ClaimWizardPage({
  claimId,
  subjectTenantId,
}: {
  claimId: string;
  subjectTenantId: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const workflow = useQuery({
    queryKey: ['workflow', claimId] as const,
    queryFn: () => getWorkflow(claimId),
  });

  if (workflow.isPending) {
    return <p className="text-sm text-muted-foreground">Loading wizard...</p>;
  }

  if (workflow.error || !workflow.data) {
    return (
      <p className="text-sm text-destructive">
        Failed to load workflow:{' '}
        {workflow.error instanceof Error ? workflow.error.message : 'Unknown error'}
      </p>
    );
  }

  const data = workflow.data;
  const explicitStep = parseStepParam(searchParams.get('step'));
  const currentStep: StepNum = explicitStep ?? lowestUnagreedStep(data);

  const handleJumpTo = (step: StepNum) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('step', String(step));
    router.replace(`?${params.toString()}`);
  };

  const handleNext = () => {
    if (currentStep < 5) {
      handleJumpTo((currentStep + 1) as StepNum);
    }
  };

  return (
    <div className="space-y-8">
      <WizardStepper
        state={data.workflow_state}
        currentStep={currentStep}
        onJumpTo={handleJumpTo}
      />

      {currentStep === 1 && (
        <WizardStep1UploadEvidence
          subjectTenantId={subjectTenantId}
          canAdvance={data.derived.canAdvance['1']}
          onNext={handleNext}
        />
      )}

      {currentStep === 2 && (
        <div className="rounded border border-[hsl(var(--brand-line))] p-8 text-center text-sm text-muted-foreground">
          Step 2 — Review Activities — coming soon
        </div>
      )}

      {currentStep === 3 && (
        <div className="rounded border border-[hsl(var(--brand-line))] p-8 text-center text-sm text-muted-foreground">
          Step 3 — Attribute Evidence — coming soon
        </div>
      )}

      {currentStep === 4 && (
        <div className="rounded border border-[hsl(var(--brand-line))] p-8 text-center text-sm text-muted-foreground">
          Step 4 — Narrative &amp; Timeline — coming soon
        </div>
      )}

      {currentStep === 5 && (
        <div className="rounded border border-[hsl(var(--brand-line))] p-8 text-center text-sm text-muted-foreground">
          Step 5 — Generate Documents — coming soon
        </div>
      )}
    </div>
  );
}
