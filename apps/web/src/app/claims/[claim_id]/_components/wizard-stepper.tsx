'use client';

import type { WorkflowState } from '@cpa/schemas';

const STEP_LABELS = [
  'Upload Evidence',
  'Review Activities',
  'Attribute Evidence',
  'Narrative & Timeline',
  'Generate Documents',
] as const;

export function WizardStepper({
  state,
  currentStep,
  onJumpTo,
}: {
  state: WorkflowState;
  currentStep: 1 | 2 | 3 | 4 | 5;
  onJumpTo?: (step: 1 | 2 | 3 | 4 | 5) => void;
}) {
  return (
    <ol className="flex items-center justify-between gap-2" data-testid="wizard-stepper">
      {STEP_LABELS.map((label, i) => {
        const stepNum = (i + 1) as 1 | 2 | 3 | 4 | 5;
        const agreed = state.steps[String(stepNum) as '1'] != null;
        const isCurrent = stepNum === currentStep;
        return (
          <li key={stepNum} className="flex flex-1 items-center gap-2">
            <button
              type="button"
              onClick={() => onJumpTo?.(stepNum)}
              className={[
                'flex h-8 w-8 items-center justify-center rounded-full border-2 text-sm font-medium',
                agreed
                  ? 'border-[hsl(var(--brand-green))] bg-[hsl(var(--brand-green))] text-white'
                  : isCurrent
                    ? 'border-[hsl(var(--brand-ink))] bg-[hsl(var(--brand-paper))]'
                    : 'border-[hsl(var(--brand-line))] bg-white text-[hsl(var(--brand-ink-subtle))]',
              ].join(' ')}
              data-testid={`wizard-stepper-${stepNum}`}
              aria-current={isCurrent ? 'step' : undefined}
            >
              {agreed ? '\u2713' : stepNum}
            </button>
            <span className="text-sm">{label}</span>
            {i < 4 ? <span className="flex-1 border-t border-[hsl(var(--brand-line))]" /> : null}
          </li>
        );
      })}
    </ol>
  );
}
