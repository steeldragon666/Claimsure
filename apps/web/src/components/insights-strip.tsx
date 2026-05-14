'use client';
/**
 * InsightsStrip — the "top facts / hyper-intelligent rotating feed" strip
 * that appears near the top of every workflow page (Claimants, Activities,
 * Evidence, Claims, dashboard).
 *
 * Polls `/v1/insights?subject_tenant_id=...&scope=...` and renders 3-5
 * ranked insight cards. Each card carries an icon, headline (display
 * serif), detail (prose), and a small "source" tag so the user can see
 * which computation produced the insight.
 *
 * Auto-rotates the FEATURED insight every 12 seconds — gives the strip
 * the "revolving" feel the user described. Click a card to pin it.
 *
 * The whole strip auto-hides if there are no insights (e.g. when the
 * endpoint errors). Same soft-fail principle as the pipeline status
 * banner: never block the page.
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/api';

interface Insight {
  id: string;
  rank: number;
  category:
    | 'throughput'
    | 'confidence'
    | 'novelty'
    | 'regulation'
    | 'precedent'
    | 'compliance'
    | 'cost'
    | 'tip';
  icon: string;
  headline: string;
  detail: string;
  source: string;
}

interface InsightsResponse {
  insights: Insight[];
  generated_at: string;
  scope: string;
  subject_tenant_id: string | null;
  /**
   * Budget snapshot for the active claim (null when no claim attached or
   * insights weren't generative). Drives the "$X.XX of $50 used" footer
   * and the over-quota banner.
   */
  budget: {
    claim_id: string | null;
    used_aud_cents: number;
    remaining_aud_cents: number;
    budget_aud_cents: number;
    status: 'free_tier' | 'over_quota';
  } | null;
  generative_status:
    | 'fresh'
    | 'cached'
    | 'no_claim'
    | 'over_quota'
    | 'budget_billable'
    | 'no_evidence'
    | 'disabled';
}

export function InsightsStrip({
  scope = 'dashboard',
  subjectTenantId,
}: {
  scope?: string;
  subjectTenantId?: string;
}) {
  const [featuredIndex, setFeaturedIndex] = useState(0);
  const [pinned, setPinned] = useState<string | null>(null);

  const params = new URLSearchParams();
  params.set('scope', scope);
  if (subjectTenantId) params.set('subject_tenant_id', subjectTenantId);

  const query = useQuery({
    queryKey: ['insights', scope, subjectTenantId] as const,
    queryFn: () => apiFetch<InsightsResponse>(`/v1/insights?${params.toString()}`),
    refetchInterval: 60_000,
  });

  const insights = query.data?.insights ?? [];
  const budget = query.data?.budget ?? null;
  const generativeStatus = query.data?.generative_status ?? 'disabled';

  // Auto-rotate the featured card every 12 sec unless the user has pinned one.
  useEffect(() => {
    if (insights.length === 0 || pinned) return;
    const handle = setInterval(() => {
      setFeaturedIndex((i) => (i + 1) % insights.length);
    }, 12_000);
    return () => clearInterval(handle);
  }, [insights.length, pinned]);

  if (query.isPending) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-2 px-3">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>Generating insights…</span>
      </div>
    );
  }

  if (query.isError || insights.length === 0) return null;

  const pinnedInsight = pinned ? insights.find((i) => i.id === pinned) : null;
  const featured = pinnedInsight ?? insights[featuredIndex] ?? insights[0]!;

  return (
    <section
      aria-label="Top facts"
      className="rounded-md border border-border bg-background/60 overflow-hidden"
      data-testid="insights-strip"
    >
      {/* Featured panel — rotates */}
      <div className="p-4 border-b border-border bg-muted/20">
        <div className="flex items-start gap-3">
          <span className="text-xl shrink-0" aria-hidden>
            {featured.icon}
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="font-display text-sm font-semibold tracking-tight leading-snug">
                {featured.headline}
              </h3>
              <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/80 shrink-0">
                {featured.category}
              </span>
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed">
              {featured.detail}
            </p>
            <p className="mt-2 font-mono text-[10px] text-muted-foreground/60">
              source: {featured.source}
            </p>
          </div>
        </div>
      </div>

      {/* Budget banner — only when generative is active. Two states:
          billable (over A$50) and free-tier-progress. Cached + disabled +
          no_claim states emit no banner so the strip stays quiet for
          tenant-wide / first-run views. */}
      {budget && (generativeStatus === 'fresh' || generativeStatus === 'budget_billable') && (
        <BudgetFooter
          usedCents={budget.used_aud_cents}
          remainingCents={budget.remaining_aud_cents}
          budgetCents={budget.budget_aud_cents}
          overQuota={budget.status === 'over_quota'}
        />
      )}

      {/* Strip of all insights — click to pin */}
      <ul className="flex items-stretch gap-0 divide-x divide-border">
        {insights.map((insight, i) => {
          const isFeatured = pinnedInsight ? insight.id === pinnedInsight.id : i === featuredIndex;
          return (
            <li key={insight.id} className="flex-1 min-w-0">
              <button
                type="button"
                onClick={() => {
                  if (pinned === insight.id) {
                    setPinned(null);
                    setFeaturedIndex(i);
                  } else {
                    setPinned(insight.id);
                  }
                }}
                className={[
                  'w-full text-left px-3 py-2.5 transition-colors',
                  'flex items-start gap-2',
                  isFeatured
                    ? 'bg-primary/5 text-foreground'
                    : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
                ].join(' ')}
                title={pinned === insight.id ? 'Click to unpin' : 'Click to pin'}
              >
                <span className="text-sm shrink-0 mt-0.5" aria-hidden>
                  {insight.icon}
                </span>
                <span className="text-xs leading-snug min-w-0 line-clamp-2">
                  {insight.headline}
                </span>
                {pinned === insight.id && (
                  <ChevronRight className="h-3 w-3 shrink-0 mt-1 text-primary" />
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Footer strip that surfaces the per-claim A$50 LLM budget.
 *
 * Two visual states:
 *   - Under quota: progress bar tinted neutral, "$X.YY of $50 budget used"
 *     copy. Bar goes amber at 70%, rose at 90%.
 *   - Over quota: rose banner — "Generative insights are now billable
 *     (cost + 50% markup against your account)". The bar stays at 100%.
 *
 * Conscious choice: we don't show a "stop insights" button here. The
 * user explicitly chose generative + cost+50% over hard-refusal, so the
 * banner is purely informational. If they want to stop, the env var
 * INSIGHTS_GEN_ENABLED=0 disables across the deploy.
 */
function BudgetFooter({
  usedCents,
  remainingCents,
  budgetCents,
  overQuota,
}: {
  usedCents: number;
  remainingCents: number;
  budgetCents: number;
  overQuota: boolean;
}) {
  const usedAud = (usedCents / 100).toFixed(2);
  const budgetAud = (budgetCents / 100).toFixed(2);
  const overCents = Math.max(0, -remainingCents);
  const overAud = (overCents / 100).toFixed(2);
  const pct = budgetCents > 0 ? Math.min(100, Math.round((usedCents / budgetCents) * 100)) : 0;

  const barColor = overQuota
    ? 'bg-rose-500'
    : pct >= 90
      ? 'bg-rose-500'
      : pct >= 70
        ? 'bg-amber-500'
        : 'bg-primary/70';

  return (
    <div
      className={[
        'border-t border-border px-4 py-2 text-[11px]',
        overQuota ? 'bg-rose-50 text-rose-900' : 'bg-muted/30 text-muted-foreground',
      ].join(' ')}
      data-testid="insights-budget-footer"
    >
      <div className="flex items-center gap-3">
        <span className="font-mono uppercase tracking-widest shrink-0">
          {overQuota ? 'over quota' : 'free tier'}
        </span>
        <div className="flex-1 h-1.5 rounded-full bg-border/70 overflow-hidden">
          <div
            className={['h-full transition-all', barColor].join(' ')}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="font-mono tabular-nums shrink-0">
          A${usedAud} / A${budgetAud}
        </span>
      </div>
      {overQuota && (
        <p className="mt-1 leading-relaxed">
          Generative insights are now billable to your consultant account at cost + 50% markup (A$
          {overAud} over the per-claim envelope so far). Continuous insight polling implies the
          system is being tested — disable in deploy env to halt.
        </p>
      )}
    </div>
  );
}
