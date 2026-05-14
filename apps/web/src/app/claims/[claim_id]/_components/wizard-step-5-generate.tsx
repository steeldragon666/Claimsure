'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, FileText, Loader2, Sparkles } from 'lucide-react';
import type { WorkflowStepEntry } from '@cpa/schemas';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api';
import type { CanAdvance } from '../_lib/workflow-client';
import { StaleStepBanner } from './stale-step-banner';

/**
 * Conservative estimate of a single Sonnet drafter call's AUD-cents cost.
 * Based on production averages: 30k input tokens + 25k output tokens at
 * the FY25/26 Sonnet-4-5 rates × 1.55 USD->AUD = ~72c. We round up to
 * 100c for the pre-flight estimate so the projected spend on the warning
 * banner is honest-with-headroom rather than rosy.
 */
const DRAFTER_ESTIMATED_AUD_CENTS = 100;

/**
 * WizardStep5 — Generate AusIndustry Application.
 *
 * Wires the application-drafter pipeline (commit 1a12c2c) into the wizard:
 *   - POST /v1/claims/:id/generate-application  enqueues the Sonnet job
 *   - GET  /v1/claims/:id/application-draft     polls the result
 *
 * The drafter call takes 60-120 seconds (Sonnet writes ~25K words across
 * the 13 portal fields × N activities + the cross-cutting registers). We
 * poll every 5s while the draft is "pending"; on completion the panel
 * swaps to a structured preview of the produced ApplicationDraft.
 */

interface ApplicationDraftResponse {
  status: 'pending' | 'drafting' | 'complete' | 'failed';
  draft?: ApplicationDraftShape | null;
  message?: string;
}

interface ClaimBudgetResponse {
  claim_id: string;
  used_aud_cents: number;
  remaining_aud_cents: number;
  budget_aud_cents: number;
  status: 'free_tier' | 'over_quota';
  call_count: number;
  billable_aud_cents: number;
  free_tier_aud_cents: number;
  agents: Array<{
    agent_name: string;
    call_count: number;
    total_aud_cents: number;
    last_called_at: string | null;
  }>;
}

interface ApplicationDraftShape {
  applicant: { name: string; abn: string | null; anzsic_division_class: string };
  income_year: string;
  project: { name: string; description: string };
  core_activities: Array<{
    activity_id: string;
    field_1_activity_name: string;
    field_2_describe: string;
    field_6_hypothesis: string;
    estimated_expenditure_aud_ex_gst: number;
    hypothesis_ids: string[];
  }>;
  supporting_activities: Array<{
    activity_id: string;
    field_name: string;
    field_description: string;
  }>;
  hypothesis_register: Array<{ id: string; hypothesis_text: string; validation_outcome: string }>;
  failure_register: Array<{ id: string; approach_attempted: string }>;
  new_knowledge_register: Array<{ id: string; contribution: string }>;
  submission_summary: string;
}

export function WizardStep5GenerateDocuments({
  claimId,
  subjectTenantId: _subjectTenantId,
  stepEntry,
  canAdvance,
}: {
  claimId: string;
  subjectTenantId: string;
  stepEntry: WorkflowStepEntry | null;
  canAdvance: CanAdvance;
}) {
  const qc = useQueryClient();

  const draftQuery = useQuery({
    queryKey: ['application-draft', claimId] as const,
    queryFn: () => apiFetch<ApplicationDraftResponse>(`/v1/claims/${claimId}/application-draft`),
    refetchInterval: (q) => {
      const status = q.state.data?.status;
      if (status === 'complete' || status === 'failed') return false;
      // While pending/drafting, poll every 5 sec so the user sees progress.
      return 5_000;
    },
  });

  // Pull the live budget so we can surface a pre-flight warning. Refetch
  // on success of the generate mutation so the projected -> actual swap
  // is immediate.
  const budgetQuery = useQuery({
    queryKey: ['claim-budget', claimId] as const,
    queryFn: () => apiFetch<ClaimBudgetResponse>(`/v1/claims/${claimId}/budget`),
  });

  const generate = useMutation({
    mutationFn: () =>
      apiFetch<{ status: string; job_id: string; message: string }>(
        `/v1/claims/${claimId}/generate-application`,
        { method: 'POST' },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['application-draft', claimId] });
      // Budget will change once the drafter ledgers its row — refetch
      // immediately so the consultant sees the spend land.
      void qc.invalidateQueries({ queryKey: ['claim-budget', claimId] });
    },
  });

  const draft = draftQuery.data?.draft ?? null;
  const status = draftQuery.data?.status ?? 'pending';
  const isDrafting = status === 'drafting' || generate.isPending;

  return (
    <section className="space-y-6" data-testid="wizard-step-5">
      <StaleStepBanner stepEntry={stepEntry} canAdvance={canAdvance} />
      <header className="space-y-1">
        <h2 className="font-display text-xl font-semibold tracking-tight">
          Generate AusIndustry Application
        </h2>
        <p className="text-sm text-muted-foreground">
          Claude Sonnet drafts a portal-ready R&amp;D Tax Incentive registration application from
          your classified evidence: 13 portal fields per core activity, plus the hypothesis /
          failure / new-knowledge registers and the submission summary.
        </p>
      </header>

      {/* Trigger button — only show when no draft exists */}
      {!draft && status !== 'drafting' && (
        <div className="rounded-md border border-border p-5 bg-muted/20 space-y-3">
          <div className="flex items-start gap-3">
            <Sparkles className="h-5 w-5 text-primary shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-medium">Ready to draft your application</p>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                Triggers the Sonnet drafter against every classified event for this claim&apos;s
                fiscal year. Typically takes 60–120 seconds. You can navigate away — the draft will
                be ready when you return.
              </p>
            </div>
          </div>
          {budgetQuery.data && <BudgetPanel budget={budgetQuery.data} />}
          <Button
            type="button"
            onClick={() => generate.mutate()}
            disabled={generate.isPending}
            data-testid="generate-application-button"
          >
            {generate.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                Enqueueing…
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4 mr-1.5" />
                Generate application
              </>
            )}
          </Button>
          {generate.isError && (
            <p className="text-xs text-destructive">
              {generate.error instanceof Error ? generate.error.message : 'Generation failed'}
            </p>
          )}
        </div>
      )}

      {/* Drafting in progress */}
      {isDrafting && !draft && (
        <div className="rounded-md border border-border p-5 bg-primary/5">
          <div className="flex items-start gap-3">
            <Loader2 className="h-5 w-5 text-primary shrink-0 mt-0.5 animate-spin" />
            <div className="flex-1">
              <p className="text-sm font-medium">Drafting your application…</p>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                Claude Sonnet is reading your classified evidence and writing all 13 AusIndustry
                portal fields per activity. This page polls every 5 seconds. ETA 60–120 seconds.
              </p>
              <p className="mt-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground/70">
                Model: claude-sonnet-4-5 · expected output ~25,000 words
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Draft preview when complete */}
      {draft && <DraftPreview draft={draft} />}
    </section>
  );
}

function DraftPreview({ draft }: { draft: ApplicationDraftShape }) {
  const totalCore = draft.core_activities.length;
  const totalSupporting = draft.supporting_activities.length;
  const totalH = draft.hypothesis_register.length;
  const totalF = draft.failure_register.length;
  const totalNK = draft.new_knowledge_register.length;
  const totalExpenditure = draft.core_activities.reduce(
    (sum, a) => sum + (a.estimated_expenditure_aud_ex_gst ?? 0),
    0,
  );

  return (
    <article className="space-y-5">
      <div className="rounded-md border border-emerald-200 bg-emerald-50 p-4 flex items-start gap-3">
        <CheckCircle2 className="h-5 w-5 text-emerald-700 shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-medium text-emerald-900">Application draft complete</p>
          <p className="text-xs text-emerald-800/80 mt-1">
            {totalCore} core + {totalSupporting} supporting activities · {totalH} hypotheses ·{' '}
            {totalF} documented failures · {totalNK} new-knowledge entries · A$
            {totalExpenditure.toLocaleString()} total expenditure ex-GST
          </p>
        </div>
      </div>

      {/* Submission summary */}
      <section className="rounded-md border border-border bg-background p-5">
        <h3 className="font-display text-lg font-semibold tracking-tight mb-3">
          Submission summary
        </h3>
        <p className="text-sm leading-relaxed text-foreground/90 whitespace-pre-wrap">
          {draft.submission_summary}
        </p>
      </section>

      {/* Core activities — collapsed preview, click to expand */}
      <section className="space-y-3">
        <h3 className="font-display text-lg font-semibold tracking-tight">Core activities</h3>
        {draft.core_activities.map((a) => (
          <details
            key={a.activity_id}
            className="rounded-md border border-border bg-background overflow-hidden group"
          >
            <summary className="cursor-pointer px-5 py-3 flex items-center justify-between gap-3 hover:bg-muted/30">
              <div className="flex items-center gap-3 min-w-0">
                <FileText className="h-4 w-4 text-primary shrink-0" />
                <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground shrink-0">
                  {a.activity_id}
                </span>
                <span className="font-display text-sm font-medium truncate">
                  {a.field_1_activity_name}
                </span>
              </div>
              <span className="text-xs text-muted-foreground shrink-0">
                A${(a.estimated_expenditure_aud_ex_gst ?? 0).toLocaleString()} ·{' '}
                {a.hypothesis_ids.join(', ')}
              </span>
            </summary>
            <div className="px-5 pb-5 space-y-4 text-sm leading-relaxed">
              <Field label="FIELD 2 — Describe the core R&D activity" value={a.field_2_describe} />
              <Field label="FIELD 6 — Hypothesis" value={a.field_6_hypothesis} />
            </div>
          </details>
        ))}
      </section>

      {/* Hypothesis register */}
      <section className="rounded-md border border-border bg-background p-5">
        <h3 className="font-display text-lg font-semibold tracking-tight mb-3">
          Hypothesis register
        </h3>
        <ul className="space-y-2">
          {draft.hypothesis_register.map((h) => (
            <li key={h.id} className="flex items-start gap-3">
              <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground shrink-0 w-8">
                {h.id}
              </span>
              <span className="text-xs leading-relaxed flex-1">{h.hypothesis_text}</span>
              <span
                className={
                  'font-mono text-[10px] uppercase tracking-widest shrink-0 ' +
                  (h.validation_outcome === 'validated'
                    ? 'text-emerald-700'
                    : h.validation_outcome === 'failed'
                      ? 'text-rose-700'
                      : 'text-muted-foreground')
                }
              >
                {h.validation_outcome}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </article>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground mb-1.5">
        {label}
      </p>
      <p className="text-xs leading-relaxed text-foreground/90 whitespace-pre-wrap">{value}</p>
    </div>
  );
}

/**
 * Pre-flight budget panel — shows the consultant where this claim sits
 * against the A$50 free-tier envelope BEFORE they trigger the ~A$0.78
 * drafter call. Three states:
 *
 *   - free-tier with headroom: neutral, just informational
 *   - free-tier near threshold (>=80% used or call would cross it):
 *     amber warning, copy explains the post-call projection
 *   - already over_quota: rose warning, copy explains cost+50% markup
 *
 * We do NOT disable the button per user direction ("don't refuse, just
 * bill"). The consultant always has agency; we just make sure they see
 * the cost.
 */
function BudgetPanel({ budget }: { budget: ClaimBudgetResponse }) {
  const usedAud = (budget.used_aud_cents / 100).toFixed(2);
  const budgetAud = (budget.budget_aud_cents / 100).toFixed(2);
  const projectedAfter = budget.used_aud_cents + DRAFTER_ESTIMATED_AUD_CENTS;
  const projectedAfterAud = (projectedAfter / 100).toFixed(2);
  const wouldGoOver = projectedAfter > budget.budget_aud_cents;
  const alreadyOver = budget.status === 'over_quota';
  const pct =
    budget.budget_aud_cents > 0
      ? Math.min(100, Math.round((budget.used_aud_cents / budget.budget_aud_cents) * 100))
      : 0;

  // Decide the tone
  const tone: 'neutral' | 'amber' | 'rose' = alreadyOver
    ? 'rose'
    : wouldGoOver || pct >= 80
      ? 'amber'
      : 'neutral';

  const toneClasses: Record<typeof tone, string> = {
    neutral: 'border-border bg-background/60 text-muted-foreground',
    amber: 'border-amber-300 bg-amber-50 text-amber-900',
    rose: 'border-rose-300 bg-rose-50 text-rose-900',
  };
  const barColor: Record<typeof tone, string> = {
    neutral: 'bg-primary/70',
    amber: 'bg-amber-500',
    rose: 'bg-rose-500',
  };

  return (
    <div
      className={`rounded-md border p-3 space-y-2 ${toneClasses[tone]}`}
      data-testid="wizard-step-5-budget-panel"
      data-tone={tone}
    >
      <div className="flex items-center gap-2">
        {tone !== 'neutral' && <AlertTriangle className="h-4 w-4 shrink-0" />}
        <span className="font-mono text-[10px] uppercase tracking-widest shrink-0">
          {alreadyOver ? 'over quota' : 'free tier'}
        </span>
        <div className="flex-1 h-1.5 rounded-full bg-border/60 overflow-hidden">
          <div className={`h-full transition-all ${barColor[tone]}`} style={{ width: `${pct}%` }} />
        </div>
        <span className="font-mono tabular-nums text-[11px] shrink-0">
          A${usedAud} / A${budgetAud}
        </span>
      </div>
      {tone === 'amber' && (
        <p className="text-[11px] leading-relaxed">
          Heads-up: this draft is estimated at ~A${(DRAFTER_ESTIMATED_AUD_CENTS / 100).toFixed(2)}.
          It would land you at A${projectedAfterAud} — {wouldGoOver ? 'over the' : 'close to the'}{' '}
          A$
          {budgetAud} free-tier envelope. Above the envelope, calls are billed to your account at
          cost + 50%.
        </p>
      )}
      {tone === 'rose' && (
        <p className="text-[11px] leading-relaxed">
          This claim is already over the A${budgetAud} free-tier envelope. This draft (~A$
          {(DRAFTER_ESTIMATED_AUD_CENTS / 100).toFixed(2)} base) will be billed to your account at
          cost + 50% — approximately A${((DRAFTER_ESTIMATED_AUD_CENTS * 1.5) / 100).toFixed(2)}.
        </p>
      )}
      {budget.call_count > 0 && (
        <p className="text-[10px] font-mono opacity-70">
          {budget.call_count} call{budget.call_count === 1 ? '' : 's'} ledgered so far
          {budget.agents.length > 0 && (
            <>
              {' · '}
              {budget.agents
                .slice(0, 3)
                .map((a) => `${a.agent_name}: A$${(a.total_aud_cents / 100).toFixed(2)}`)
                .join(' · ')}
            </>
          )}
        </p>
      )}
    </div>
  );
}
