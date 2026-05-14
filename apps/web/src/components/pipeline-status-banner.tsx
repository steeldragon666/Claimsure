'use client';
/**
 * PipelineStatusBanner — surfaces what the async agent pipeline is doing
 * for a subject_tenant, so the wizard never feels like a Rubik's cube.
 *
 * Polls `/v1/subject-tenants/:id/pipeline-status` every 4 seconds while
 * a phase is active. Renders a banner with:
 *   - phase heading (display serif)
 *   - "what's happening" description (which agent, what it's doing)
 *   - the model name (transparency)
 *   - a progress bar + ETA
 *   - an expandable "Why this takes time" section explaining the
 *     compliance reason for the phase's existence
 *
 * Drop this above the main content area of any page in the wizard. It
 * shows itself when there's work to do and quietly disappears when idle
 * (unless there's nothing in the subject_tenant yet, in which case it
 * renders the friendly "Ready for evidence" idle copy).
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, ChevronDown, ChevronUp, CheckCircle2, FileText } from 'lucide-react';
import { PHASES, estimateEtaSeconds, formatEta, type PipelinePhase } from '@/lib/pipeline-phases';
import { apiFetch } from '@/lib/api';

interface PipelineStatusResponse {
  phase: PipelinePhase;
  counts: {
    total_evidence_events: number;
    extraction_pending: number;
    extraction_complete: number;
    extraction_failed: number;
    with_activity_proposals: number;
    activity_proposals_total: number;
    invoice_proposals_total: number;
  };
  narrative: {
    last_approval_at: string | null;
  };
  eta_items: number;
  updated_at: string;
}

export function PipelineStatusBanner({ subjectTenantId }: { subjectTenantId: string }) {
  const [showWhy, setShowWhy] = useState(false);

  const query = useQuery({
    queryKey: ['pipeline-status', subjectTenantId] as const,
    queryFn: () =>
      apiFetch<PipelineStatusResponse>(`/v1/subject-tenants/${subjectTenantId}/pipeline-status`),
    // Re-poll every 4s while there's active work; back off to 30s when idle.
    refetchInterval: (q) => {
      const phase = q.state.data?.phase;
      if (!phase) return 5_000;
      if (phase === 'extracting') return 4_000;
      if (phase === 'extraction_complete' || phase === 'narrative_pending') return 8_000;
      return 30_000; // idle / narrative_approved
    },
  });

  if (query.isPending) {
    return (
      <div className="rounded-md border border-dashed border-border p-4 bg-muted/20 flex items-center gap-3 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>Connecting to the analysis pipeline...</span>
      </div>
    );
  }

  // Soft-fail rather than block the page if the endpoint errors. The banner
  // is a supplementary surface — it should never prevent the wizard from
  // loading.
  if (query.isError || !query.data) return null;

  const { phase, counts, eta_items } = query.data;
  const descriptor = PHASES[phase];

  // Don't render anything for fully-idle, no-evidence-yet pages. Other
  // surfaces (upload area) handle the call-to-action.
  if (phase === 'idle' && counts.total_evidence_events === 0) return null;

  const etaSeconds = estimateEtaSeconds(phase, eta_items);
  const progressPct =
    counts.total_evidence_events > 0
      ? Math.round(
          ((counts.total_evidence_events - counts.extraction_pending) /
            counts.total_evidence_events) *
            100,
        )
      : 0;

  const isActive = phase === 'extracting';
  const isDone = phase === 'narrative_approved' || phase === 'extraction_complete';

  return (
    <div
      className="rounded-md border border-border bg-background overflow-hidden"
      data-testid="pipeline-status-banner"
    >
      <div className="p-5 space-y-3">
        <div className="flex items-start gap-3">
          <PhaseIcon phase={phase} />
          <div className="flex-1 min-w-0">
            <h3 className="font-display text-lg font-semibold tracking-tight text-foreground">
              {descriptor.label}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground leading-relaxed">
              {descriptor.description}
            </p>
            {descriptor.model !== 'n/a' && (
              <p className="mt-2 font-mono text-[11px] uppercase tracking-widest text-muted-foreground/70">
                Model: {descriptor.model}
              </p>
            )}
          </div>
        </div>

        {/* Progress bar — only when actively extracting */}
        {isActive && counts.total_evidence_events > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between font-mono text-xs text-muted-foreground">
              <span>
                {counts.total_evidence_events - counts.extraction_pending} of{' '}
                {counts.total_evidence_events} complete
              </span>
              {etaSeconds != null && <span>ETA {formatEta(etaSeconds)}</span>}
            </div>
            <div className="h-1.5 bg-muted/40 rounded-sm overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-500 ease-out"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>
        )}

        {/* Counts summary — show when done extracting */}
        {isDone && counts.total_evidence_events > 0 && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-2 border-t border-border">
            <Stat label="Evidence items" value={counts.total_evidence_events} />
            <Stat label="Activity proposals" value={counts.activity_proposals_total} />
            <Stat label="Invoice proposals" value={counts.invoice_proposals_total} />
            <Stat
              label="Failed extractions"
              value={counts.extraction_failed}
              tone={counts.extraction_failed > 0 ? 'warn' : 'ok'}
            />
          </div>
        )}

        {/* "Why this takes time" expandable */}
        {descriptor.whyThisTakesTime && (
          <button
            type="button"
            onClick={() => setShowWhy(!showWhy)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {showWhy ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
            Why this takes time
          </button>
        )}
        {showWhy && descriptor.whyThisTakesTime && (
          <p className="text-xs text-muted-foreground leading-relaxed pl-5 border-l border-border italic">
            {descriptor.whyThisTakesTime}
          </p>
        )}
      </div>
    </div>
  );
}

function PhaseIcon({ phase }: { phase: PipelinePhase }) {
  switch (phase) {
    case 'extracting':
      return <Loader2 className="h-5 w-5 text-primary animate-spin shrink-0 mt-0.5" />;
    case 'extraction_complete':
    case 'narrative_pending':
      return <FileText className="h-5 w-5 text-primary shrink-0 mt-0.5" />;
    case 'narrative_approved':
      return <CheckCircle2 className="h-5 w-5 text-primary shrink-0 mt-0.5" />;
    default:
      return <FileText className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />;
  }
}

function Stat({
  label,
  value,
  tone = 'ok',
}: {
  label: string;
  value: number;
  tone?: 'ok' | 'warn';
}) {
  return (
    <div>
      <div className="font-mono text-xl font-medium text-foreground">{value}</div>
      <div
        className={`text-[10px] uppercase tracking-widest mt-0.5 ${tone === 'warn' && value > 0 ? 'text-amber-700' : 'text-muted-foreground'}`}
      >
        {label}
      </div>
    </div>
  );
}
