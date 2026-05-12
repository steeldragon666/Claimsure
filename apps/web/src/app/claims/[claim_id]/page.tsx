'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { use } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AppShell } from '@/components/app-shell';
import { TransitionBadge, type TransitionVariant } from '@/components/transition-badge';
import { STAGE_LABELS } from '@/lib/claim-stage';
import { ClaimTabs } from './_components/claim-tabs';
import { EditClaimButton } from './_components/edit-claim-button';
import { SubmitClaimButton } from './_components/submit-claim-button';
import { ClaimWizardPage } from './_components/claim-wizard-page';
import { getClaim } from './_lib/api';
import { parseTab } from './_lib/url-params';
import type { ClaimStage } from '@cpa/schemas';

/**
 * Map claim stage → TransitionBadge variant.
 * Earlier stages = continuation (in progress), review = completion,
 * submitted/audit_defence = completion as final states.
 */
function stageToVariant(stage: ClaimStage): TransitionVariant {
  switch (stage) {
    case 'engagement':
    case 'activity_capture':
    case 'narrative_drafting':
    case 'expenditure_schedule':
      return 'continuation';
    case 'review':
      return 'pivot';
    case 'submitted':
      return 'completion';
    case 'audit_defence':
      return 'abandoned';
    default:
      return 'continuation';
  }
}

/**
 * /claims/[claim_id] — Swimlane C entry point for a single claim.
 *
 * C4 lays down the page shell: header (FY + claimant + stage badge) +
 * five-tab strip (Activities, Evidence, Expenditure, Documents,
 * Timeline). Every tab body is a placeholder pointing at the swimlane
 * task that fills it in (C5 expenditure, C7-C9 documents, A3+ evidence,
 * etc) — the goal here is the navigation + data wiring, not the
 * per-tab content.
 *
 * Following the P1 dynamic-route pattern (subject-tenants/[id]/page.tsx,
 * users/[userId]/page.tsx): `'use client'` + `React.use(params)` so the
 * AuthGuard wraps cleanly without server-side cookie reads. URL state
 * is read via useSearchParams.
 *
 * NOTE: GET /v1/claims/:id doesn't exist yet — that's Swimlane A's A2
 * task. For C4 we stub the data fetch in `./_lib/api.ts` so the page
 * shell renders against placeholder header data; swap-in is one line
 * once A2 ships.
 *
 * Stage advancement controls intentionally NOT inlined here: the bulk
 * Advance/Revert flow lives in the pipeline view (more useful in
 * context, less work here). Once /v1/claims/:id/stage and the
 * single-claim mutation hook stabilise we can revisit and add an
 * inline dropdown if user testing demands it.
 */
export default function ClaimDetailPage({ params }: { params: Promise<{ claim_id: string }> }) {
  const { claim_id } = use(params);
  return (
    <AppShell>
      <Inner claimId={claim_id} />
    </AppShell>
  );
}

function Inner({ claimId }: { claimId: string }) {
  const searchParams = useSearchParams();
  const activeTab = parseTab(searchParams.get('tab'));

  // TODO(A2): replace stub with real `getClaim(claimId)` once GET
  // /v1/claims/:id ships. Query key already matches the eventual cache
  // shape so swapping in is a one-line change.
  const claim = useQuery({
    queryKey: ['claim', claimId] as const,
    queryFn: () => getClaim(claimId),
  });

  if (claim.isPending) {
    return <p className="text-sm text-muted-foreground">Loading claim…</p>;
  }
  if (claim.error || !claim.data) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-destructive">
          Failed to load claim:{' '}
          {claim.error instanceof Error ? claim.error.message : 'Unknown error'}
        </p>
        <Link href="/pipeline" className="mt-4 inline-block text-sm text-primary underline">
          Back to pipeline
        </Link>
      </div>
    );
  }

  const c = claim.data;

  // --- Wizard branch: new 5-step guided flow for wizard-mode claims ---
  if (c.is_wizard_claim) {
    return (
      <div className="space-y-8">
        <div>
          <Link href="/pipeline" className="text-sm text-muted-foreground hover:underline">
            &larr; Pipeline
          </Link>
        </div>
        <ClaimWizardPage claimId={claimId} subjectTenantId={c.subject_tenant_id} claim={c} />
      </div>
    );
  }

  // --- Legacy tabbed view for pre-wizard claims ---
  // TODO(A2): swap subject_tenant_id slice for real claimant name once
  // GET /v1/claims/:id returns the joined subject_tenant payload (or
  // we add a dedicated lookup). The 8-char slice keeps the header
  // distinguishable across rows pre-A2.
  const claimantLabel = `Claim ${c.subject_tenant_id.slice(0, 8)}`;

  return (
    <div className="space-y-8">
      <div>
        <Link href="/pipeline" className="text-sm text-muted-foreground hover:underline">
          ← Pipeline
        </Link>
      </div>

      <header className="space-y-2">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          Claim
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-display text-3xl font-semibold tracking-tight">
            Claim FY{c.fiscal_year}
          </h1>
          <span className="font-mono text-xs text-muted-foreground">{claimantLabel}</span>
          <TransitionBadge variant={stageToVariant(c.stage)} label={STAGE_LABELS[c.stage]} />
          {/* Phase 4B: edit claim controls + R&DTI workflow */}
          <div className="ml-auto flex items-center gap-2">
            <EditClaimButton claim={c} />
            <SubmitClaimButton claimId={claimId} />
          </div>
        </div>
      </header>

      <ClaimTabs claimId={claimId} activeTab={activeTab} />
    </div>
  );
}
