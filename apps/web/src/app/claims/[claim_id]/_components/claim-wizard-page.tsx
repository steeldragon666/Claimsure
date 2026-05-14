'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import type { Claim } from '@cpa/schemas';
import { PipelineStatusBanner } from '@/components/pipeline-status-banner';
import { InsightsStrip } from '@/components/insights-strip';
import { getWorkflow } from '../_lib/workflow-client';
import type { WorkflowResponse } from '../_lib/workflow-client';
import { WizardStepper } from './wizard-stepper';
import { WizardStep1UploadEvidence } from './wizard-step-1-upload';
import { WizardStep2ReviewActivities } from './wizard-step-2-review';
import { WizardStep3AttributeEvidence } from './wizard-step-3-attribute';
import { WizardStep4ReviewNarrative } from './wizard-step-4-narrative';
import { WizardStep5GenerateDocuments } from './wizard-step-5-generate';

type StepNum = 1 | 2 | 3 | 4 | 5;

/**
 * Resolve the lowest unagreed step from the workflow state.
 * Falls back to step 1 if all steps are agreed (shouldn't happen
 * in normal flow since step 5 = final generate).
 */
function lowestUnagreedStep(data: WorkflowResponse): StepNum {
  const steps = data.workflow_state.steps;
  for (let i = 1; i <= 5; i++) {
    const key = String(i) as '1' | '2' | '3' | '4' | '5';
    if (steps[key] == null) return i as StepNum;
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
 * Steps 1-5 are all implemented: Upload Evidence, Review Activities,
 * Attribute Evidence, Narrative & Timeline, and Generate Documents.
 */
export function ClaimWizardPage({
  claimId,
  subjectTenantId,
  claim,
}: {
  claimId: string;
  subjectTenantId: string;
  claim: Claim;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const workflow = useQuery({
    queryKey: ['workflow', claimId] as const,
    queryFn: () => getWorkflow(claimId),
    staleTime: 30_000,
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

      <PipelineStatusBanner subjectTenantId={subjectTenantId} />

      <InsightsStrip scope="wizard" subjectTenantId={subjectTenantId} />

      {currentStep === 1 && (
        <WizardStep1UploadEvidence
          claimId={claimId}
          subjectTenantId={subjectTenantId}
          stepEntry={data.workflow_state.steps['1']}
          canAdvance={
            data.derived.canAdvance['1'] ?? { ok: false, reason: 'Workflow data unavailable' }
          }
          onNext={handleNext}
        />
      )}

      {currentStep === 2 && (
        <WizardStep2ReviewActivities
          claimId={claimId}
          subjectTenantId={subjectTenantId}
          stepEntry={data.workflow_state.steps['2']}
          canAdvance={
            data.derived.canAdvance['2'] ?? { ok: false, reason: 'Workflow data unavailable' }
          }
          onNext={handleNext}
        />
      )}

      {currentStep === 3 && (
        <WizardStep3AttributeEvidence
          claimId={claimId}
          subjectTenantId={subjectTenantId}
          stepEntry={data.workflow_state.steps['3']}
          canAdvance={
            data.derived.canAdvance['3'] ?? { ok: false, reason: 'Workflow data unavailable' }
          }
          onNext={handleNext}
        />
      )}

      {currentStep === 4 && (
        <WizardStep4ReviewNarrative
          claimId={claimId}
          subjectTenantId={subjectTenantId}
          claim={claim}
          stepEntry={data.workflow_state.steps['4']}
          canAdvance={
            data.derived.canAdvance['4'] ?? { ok: false, reason: 'Workflow data unavailable' }
          }
          onNext={handleNext}
        />
      )}

      {currentStep === 5 && (
        <WizardStep5GenerateDocuments
          claimId={claimId}
          subjectTenantId={subjectTenantId}
          stepEntry={data.workflow_state.steps['5']}
          canAdvance={
            data.derived.canAdvance['5'] ?? { ok: false, reason: 'Workflow data unavailable' }
          }
        />
      )}
    </div>
  );
}
