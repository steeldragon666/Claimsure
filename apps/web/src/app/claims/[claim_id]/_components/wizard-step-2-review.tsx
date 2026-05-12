'use client';

import { Button } from '@/components/ui/button';
import { PendingNarrativePanel } from '@/app/subject-tenants/[id]/_components/pending-narrative-panel';
import type { CanAdvance } from '../_lib/workflow-client';

/**
 * Wizard Step 2 -- Review Activities.
 *
 * Wraps the existing PendingNarrativePanel component, which shows the
 * AI-proposed R&D activities extracted from uploaded evidence and lets
 * the consultant approve the narrative to auto-create activities and
 * expenditure items.
 *
 * The "Next" button is gated on the parent orchestrator's
 * `canAdvance` signal (i.e. the narrative has been approved and at
 * least one activity exists).
 */
export function WizardStep2ReviewActivities({
  claimId: _claimId,
  subjectTenantId,
  canAdvance,
  onNext,
}: {
  claimId: string;
  subjectTenantId: string;
  canAdvance: CanAdvance;
  onNext: () => void;
}) {
  return (
    <section className="space-y-6" data-testid="wizard-step-2">
      <header className="space-y-1">
        <h2 className="font-display text-xl font-semibold tracking-tight">Review Activities</h2>
        <p className="text-sm text-muted-foreground">
          Review the AI-proposed R&amp;D activities extracted from your evidence. Approve the
          narrative to auto-create activities and expenditure items.
        </p>
      </header>

      <PendingNarrativePanel subjectTenantId={subjectTenantId} />

      <div className="flex items-center justify-end gap-3 border-t border-[hsl(var(--brand-line))] pt-4">
        {!canAdvance.ok && (
          <p className="mr-auto text-sm text-muted-foreground">{canAdvance.reason}</p>
        )}
        <Button onClick={onNext} disabled={!canAdvance.ok}>
          Next: Attribute Evidence &rarr;
        </Button>
      </div>
    </section>
  );
}
