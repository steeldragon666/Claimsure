'use client';
/**
 * /activities — Activities tab (top-tab nav).
 *
 * Renders the AI-extracted activity PROPOSALS sitting inside the event
 * chain's `extracted_content.activities` JSONB blobs. Until a consultant
 * approves the wizard's narrative gate, these proposals don't get
 * promoted to real activity rows — but the consultant needs to SEE them
 * before clicking through the approve gate. That visibility is what this
 * page is for.
 *
 * Each card surfaces: name, kind (core/supporting), confidence chip,
 * hypothesis with quantified targets, technical uncertainty, expected
 * outcome, AI rationale, source document filename + excerpt, and a
 * "promote to claim" action (TODO PR #4 — currently visual only).
 */
import { useQuery } from '@tanstack/react-query';
import { Beaker, FileText, TrendingUp, AlertCircle, Loader2 } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { InsightsStrip } from '@/components/insights-strip';
import { apiFetch } from '@/lib/api';

interface ProposedActivity {
  event_id: string;
  event_kind: string;
  subject_tenant_id: string;
  subject_tenant_name: string;
  filename: string | null;
  captured_at: string;
  classification_kind: string | null;
  proposed_name: string;
  proposed_kind: 'core' | 'supporting';
  confidence: number;
  hypothesis_text: string;
  technical_uncertainty: string;
  expected_outcome: string;
  rationale: string;
  source_excerpt: string;
}

interface ProposedActivitiesResponse {
  proposals: ProposedActivity[];
  summary: {
    total: number;
    core: number;
    supporting: number;
    distinct_documents: number;
    high_confidence: number;
    avg_confidence: number;
  };
}

export default function ActivitiesPage() {
  return (
    <AppShell>
      <ActivitiesContent />
    </AppShell>
  );
}

function ActivitiesContent() {
  const query = useQuery({
    queryKey: ['proposed-activities'] as const,
    queryFn: () => apiFetch<ProposedActivitiesResponse>('/v1/proposed-activities'),
    refetchInterval: 8_000,
  });

  if (query.isPending) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        Loading activity proposals...
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <div className="rounded-md border border-dashed border-border p-6 bg-muted/20 text-sm">
        <AlertCircle className="h-5 w-5 text-muted-foreground inline mr-2" />
        Couldn&apos;t load activity proposals.{' '}
        <span className="text-muted-foreground">
          {query.error instanceof Error ? query.error.message : 'Unknown error'}
        </span>
      </div>
    );
  }

  const { proposals, summary } = query.data;

  return (
    <div className="space-y-8 max-w-5xl mx-auto py-8">
      <header className="space-y-3">
        <div className="flex items-center gap-3">
          <Beaker className="h-6 w-6 text-primary" />
          <h1 className="font-display text-3xl font-semibold tracking-tight">Activities</h1>
        </div>
        <p className="text-muted-foreground text-sm leading-relaxed max-w-3xl">
          AI-extracted R&amp;D activity proposals from your uploaded evidence. Each proposal carries
          a hypothesis with quantified targets, technical-uncertainty justification (§355-25(1)(a)),
          and a source citation. Approve via the wizard&apos;s narrative gate to promote these into
          a registered activity register.
        </p>
      </header>

      <InsightsStrip scope="activities" />

      {summary.total > 0 && (
        <section
          className="grid grid-cols-2 md:grid-cols-5 gap-3 border-y border-border py-4"
          aria-label="Top facts"
        >
          <Stat label="Proposals" value={summary.total} accent />
          <Stat label="Core (§355-25)" value={summary.core} />
          <Stat label="Supporting (§355-30)" value={summary.supporting} />
          <Stat label="High confidence" value={summary.high_confidence} sub="≥0.80" />
          <Stat
            label="Avg confidence"
            value={summary.avg_confidence.toFixed(2)}
            sub={`across ${summary.distinct_documents} docs`}
          />
        </section>
      )}

      {proposals.length === 0 && (
        <div className="rounded-md border border-dashed border-border p-8 bg-muted/20 text-center">
          <FileText className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          <p className="font-medium mb-1">No activity proposals yet</p>
          <p className="text-sm text-muted-foreground max-w-md mx-auto">
            Upload evidence on the wizard&apos;s step 1, then come back here. Each document gets
            analyzed by Claude Haiku — proposed activities appear here as soon as extraction
            finishes (typically 3-5 seconds per document).
          </p>
        </div>
      )}

      {proposals.length > 0 && (
        <div className="space-y-4">
          {proposals.map((p, i) => (
            <ProposalCard key={`${p.event_id}-${i}`} proposal={p} />
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  accent = false,
}: {
  label: string;
  value: number | string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div>
      <div
        className={`font-mono text-2xl font-medium ${accent ? 'text-primary' : 'text-foreground'}`}
      >
        {value}
      </div>
      <div className="text-[10px] uppercase tracking-widest mt-0.5 text-muted-foreground">
        {label}
      </div>
      {sub && <div className="text-[10px] text-muted-foreground/70 mt-0.5">{sub}</div>}
    </div>
  );
}

function ProposalCard({ proposal: p }: { proposal: ProposedActivity }) {
  const isCore = p.proposed_kind === 'core';
  const confidenceClass =
    p.confidence >= 0.85
      ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
      : p.confidence >= 0.7
        ? 'text-amber-700 bg-amber-50 border-amber-200'
        : 'text-rose-700 bg-rose-50 border-rose-200';

  return (
    <article className="rounded-md border border-border bg-background overflow-hidden">
      <div className="p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <h3 className="font-display text-lg font-semibold tracking-tight leading-snug">
              {p.proposed_name}
            </h3>
            <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground mt-1.5">
              {p.subject_tenant_name} · {p.filename ?? p.event_kind}
            </p>
          </div>
          <div className="flex flex-col items-end gap-1.5 shrink-0">
            <span
              className={`text-[10px] font-mono uppercase tracking-widest px-2 py-0.5 rounded-sm border ${
                isCore
                  ? 'text-primary bg-primary/5 border-primary/30'
                  : 'text-muted-foreground bg-muted/40 border-border'
              }`}
            >
              {isCore ? 'CORE · §355-25' : 'SUPPORTING · §355-30'}
            </span>
            <span
              className={`text-[10px] font-mono uppercase tracking-widest px-2 py-0.5 rounded-sm border ${confidenceClass}`}
            >
              {(p.confidence * 100).toFixed(0)}% conf
            </span>
          </div>
        </div>

        <div className="space-y-1.5">
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/80">
            Hypothesis (§355-25(1)(a))
          </p>
          <p className="text-sm leading-relaxed text-foreground/90">{p.hypothesis_text}</p>
        </div>

        <div className="grid md:grid-cols-2 gap-4 pt-2 border-t border-border">
          <div className="space-y-1.5">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/80">
              Technical uncertainty
            </p>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {p.technical_uncertainty}
            </p>
          </div>
          <div className="space-y-1.5">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/80">
              Expected outcome
            </p>
            <p className="text-sm leading-relaxed text-muted-foreground">{p.expected_outcome}</p>
          </div>
        </div>

        <details className="group">
          <summary className="text-xs text-muted-foreground hover:text-foreground cursor-pointer flex items-center gap-1.5">
            <TrendingUp className="h-3.5 w-3.5" />
            AI rationale &amp; source excerpt
          </summary>
          <div className="mt-3 space-y-3 pl-5 border-l border-border">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/80 mb-1">
                Why this proposal
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground italic">{p.rationale}</p>
            </div>
            <div>
              <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/80 mb-1">
                Source excerpt
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground font-mono bg-muted/30 rounded-sm p-2">
                &ldquo;{p.source_excerpt}&rdquo;
              </p>
            </div>
          </div>
        </details>
      </div>
    </article>
  );
}
