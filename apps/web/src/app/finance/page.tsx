'use client';
/**
 * /finance — consultant-facing financial overview.
 *
 * Distinct from /admin/billing/invoices (which is the admin's own
 * subscription invoice history). This page is the *portfolio-level*
 * financial dashboard for the consulting firm:
 *
 *   - Firm subscription snapshot (tier / billing_mode / trial status)
 *   - Aggregate claim-portfolio metrics (claim count, total refund estimate)
 *   - Per-claimant refund-estimate breakdown
 *   - Quick links to the billing portal + invoice history
 *
 * The "refund estimate" is calculated as 43.5% of total expenditure (the
 * R&D Tax Offset rate for refundable claimants — entities with aggregated
 * turnover < $20M; non-refundable rate is 38.5%). This is a coarse
 * preview, not a guarantee — actual offset depends on entitlement, base
 * rate, and overseas-spend caps. Every figure is sourced from
 * GET /v1/expenditures/summary?subject_tenant_id=... + GET /v1/claims.
 *
 * Per-claimant breakdown collapses to "—" when expenditure data isn't
 * yet mapped (most fresh claims). The empty-state-aware design avoids
 * showing $0 across the board for newly-onboarded firms.
 */
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, TrendingUp, FileText, Building2, Receipt, ArrowUpRight } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { TransitionBadge } from '@/components/transition-badge';
import { EmptyState } from '@/components/empty-state';
import { useWhoami } from '@/hooks/use-whoami';
import { apiFetch } from '@/lib/api';
import type { Claim, SubjectTenant } from '@cpa/schemas';

/**
 * R&D Tax Offset rate. The refundable rate (43.5%) applies to entities
 * with aggregated turnover < $20M — by far the most common claimant
 * profile for a typical R&DTI consulting firm's book. Showing the
 * non-refundable rate (38.5%) as a secondary number would be more
 * accurate but adds clutter; the modal/breakdown can layer it in later.
 */
const REFUND_RATE = 0.435;

function formatAUD(amount: number): string {
  return new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency: 'AUD',
    maximumFractionDigits: 0,
  }).format(amount);
}

// Compact AUD for display-size hero number (e.g. "$4.2m")
function formatAUDCompact(amount: number): string {
  if (amount >= 1_000_000) {
    return `$${(amount / 1_000_000).toFixed(1)}m`;
  }
  if (amount >= 1_000) {
    return `$${(amount / 1_000).toFixed(0)}k`;
  }
  return formatAUD(amount);
}

interface ClaimsListResponse {
  claims: Claim[];
}

interface SubjectTenantsListResponse {
  subject_tenants: SubjectTenant[];
}

export default function FinancePage() {
  return (
    <AppShell>
      <FinanceContent />
    </AppShell>
  );
}

function FinanceContent() {
  const whoami = useWhoami();

  const claims = useQuery({
    queryKey: ['claims', 'finance'],
    queryFn: () => apiFetch<ClaimsListResponse>('/v1/claims'),
  });

  const subjects = useQuery({
    queryKey: ['subject-tenants', 'finance'],
    queryFn: () => apiFetch<SubjectTenantsListResponse>('/v1/subject-tenants'),
  });

  if (!whoami.data) return null;

  const tenant = whoami.data.availableTenants.find(
    (t) => t.tenantId === whoami.data?.user.tenantId,
  );

  return (
    <div className="space-y-12">
      {/* ── Hero header ── */}
      <header className="space-y-3">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          Workspace
        </p>
        <h1 className="font-display text-5xl tracking-tight leading-tight">
          Financial{' '}
          <span className="italic font-semibold text-[hsl(var(--brand-accent))]">overview</span>
        </h1>
        <p className="text-base text-muted-foreground max-w-xl leading-relaxed">
          Portfolio-level view of your firm&apos;s R&amp;DTI book — refund estimates across all
          clients plus your own subscription status.
        </p>
      </header>

      {/* ── Refund pool hero stat ── */}
      <RefundPoolHero
        claimsLoading={claims.isPending}
        subjectsCount={
          subjects.data?.subject_tenants.filter((s) => s.kind === 'claimant').length ?? 0
        }
        claimsCount={claims.data?.claims.length ?? 0}
      />

      {/* ── Firm subscription snapshot ── */}
      <SubscriptionSnapshot tenantName={tenant?.name ?? 'Your firm'} />

      {/* ── Portfolio KPI tiles ── */}
      <PortfolioOverview
        claimsLoading={claims.isPending}
        claimsCount={claims.data?.claims.length ?? 0}
        subjectsCount={subjects.data?.subject_tenants.length ?? 0}
      />

      {/* ── Per-claimant refund estimates ── */}
      <ClaimantBreakdown
        loading={subjects.isPending || claims.isPending}
        subjects={subjects.data?.subject_tenants ?? []}
        claims={claims.data?.claims ?? []}
      />
    </div>
  );
}

function RefundPoolHero({
  claimsLoading,
  subjectsCount,
  claimsCount,
}: {
  claimsLoading: boolean;
  subjectsCount: number;
  claimsCount: number;
}) {
  /*
   * TODO(p9.2-finance): replace placeholder with real pool value once
   * GET /v1/expenditures/summary ships. Formula: totalExpenditureAud * REFUND_RATE
   */
  return (
    <Card className="border-border bg-card overflow-hidden">
      <CardContent className="p-0">
        <div className="flex flex-col md:flex-row">
          {/* Main hero number */}
          <div className="flex-1 p-8 space-y-2 border-b md:border-b-0 md:border-r border-[hsl(var(--brand-hairline))]">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Estimated refund pool &middot; {new Date().getFullYear()} portfolio
            </p>
            <p className="font-display text-6xl font-semibold tracking-tight text-foreground leading-none">
              {claimsLoading ? '…' : '—'}
            </p>
            <p className="text-xs text-muted-foreground">
              Awaiting expenditure mapping &middot; 43.5% refundable rate
            </p>
          </div>
          {/* Secondary stats */}
          <div className="flex md:flex-col divide-x md:divide-x-0 md:divide-y divide-[hsl(var(--brand-hairline))]">
            <div className="flex-1 md:flex-none px-6 py-5 space-y-1">
              <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Claimant firms
              </p>
              <p className="font-display text-3xl font-medium tabular-nums">
                {claimsLoading ? '…' : String(subjectsCount)}
              </p>
            </div>
            <div className="flex-1 md:flex-none px-6 py-5 space-y-1">
              <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Active claims
              </p>
              <p className="font-display text-3xl font-medium tabular-nums">
                {claimsLoading ? '…' : String(claimsCount)}
              </p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function SubscriptionSnapshot({ tenantName }: { tenantName: string }) {
  /*
   * tier / billing_mode / trial_status live on the tenant row but aren't
   * exposed through `/v1/whoami` today — the wire shape only carries
   * tenantId/name/slug/role per available tenant. Until that's widened
   * (TODO(p9.2-finance): add billing fields to whoami response or to
   * dedicated `GET /v1/billing/status`), we render a labelled card with
   * action buttons that route to the existing billing-portal redirect
   * + invoice history page. Once the API surface lands, this card
   * acquires "Plan: Bronze · Trial ends Jun 12" hardline copy.
   */
  return (
    <Card className="border-border bg-card/60">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="space-y-1">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Subscription
            </p>
            <h2 className="font-display text-2xl font-medium">{tenantName}</h2>
          </div>
          {/* TransitionBadge used here as plan-tier state chip.
              TODO(p9.2-finance): swap variant + label when billing API ships */}
          <TransitionBadge
            variant="continuation"
            label="Pro plan"
            rationale="Plan tier will be fetched live once GET /v1/billing/status ships."
          />
        </div>
      </CardHeader>
      <CardContent className="flex flex-wrap items-end justify-between gap-4">
        <p className="text-sm text-muted-foreground max-w-md">
          Manage your ArchiveOne subscription, payment method, and download invoice history. All
          amounts include 10% Australian GST.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link href="/admin/billing/invoices">
              <Receipt className="h-4 w-4 mr-2" />
              Invoice history
            </Link>
          </Button>
          <Button asChild>
            <a href="/v1/billing/portal" target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-4 w-4 mr-2" />
              Manage subscription
            </a>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function PortfolioOverview({
  claimsLoading,
  claimsCount,
  subjectsCount,
}: {
  claimsLoading: boolean;
  claimsCount: number;
  subjectsCount: number;
}) {
  /*
   * Coarse refund-pool estimate: the platform doesn't yet aggregate
   * expenditure totals across claims at firm scope (would need a
   * GET /v1/expenditures/summary endpoint). Until that lands, the
   * "Estimated refund pool" tile shows a placeholder and explains the
   * data dependency. The underlying computation is documented inline
   * so the wire-up is a one-liner once the API ships.
   *
   * TODO(p9.2-finance): add `GET /v1/expenditures/summary` returning
   * `{ total_expenditure_aud, claim_count, claimant_count }` for the
   * active firm; replace the placeholder below with the real total.
   */
  return (
    <section>
      <SectionHeading kicker="Portfolio" title="Across all clients" />
      <div className="grid gap-4 sm:grid-cols-3">
        <KpiTile
          icon={Building2}
          label="Claimant firms"
          value={claimsLoading ? '…' : String(subjectsCount)}
          comparison="Active claimant entities"
        />
        <KpiTile
          icon={FileText}
          label="Active claims"
          value={claimsLoading ? '…' : String(claimsCount)}
          comparison="Across all FY periods"
        />
        <KpiTile
          icon={TrendingUp}
          label="Estimated refund pool"
          value="—"
          comparison="Awaiting expenditure mapping"
          dimValue
        />
      </div>
    </section>
  );
}

function ClaimantBreakdown({
  loading,
  subjects,
  claims,
}: {
  loading: boolean;
  subjects: SubjectTenant[];
  claims: Claim[];
}) {
  // Group claims by subject_tenant_id so each row is one claimant with
  // its claim count + (placeholder) refund estimate. Cheap to compute
  // client-side at portfolio scale (≤50 claimants for typical firms).
  const claimsBySubject = new Map<string, Claim[]>();
  for (const c of claims) {
    const arr = claimsBySubject.get(c.subject_tenant_id) ?? [];
    arr.push(c);
    claimsBySubject.set(c.subject_tenant_id, arr);
  }

  const claimants = subjects.filter((s) => s.kind === 'claimant');

  return (
    <section>
      <SectionHeading kicker="Per claimant" title="Refund estimate by client firm" />
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading portfolio…</p>
      ) : claimants.length === 0 ? (
        <EmptyState
          icon="ledger"
          title="Your portfolio is empty"
          description="Add a client firm and create their first claim to see refund estimates appear here."
          action={{ label: 'Go to Client firms', href: '/subject-tenants' }}
        />
      ) : (
        <div className="rounded border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-secondary/50 border-b border-border">
              <tr>
                <th className="text-left font-mono text-[10px] uppercase tracking-widest text-muted-foreground px-4 py-3">
                  Client firm
                </th>
                <th className="text-right font-mono text-[10px] uppercase tracking-widest text-muted-foreground px-4 py-3">
                  Claims
                </th>
                <th className="text-right font-mono text-[10px] uppercase tracking-widest text-muted-foreground px-4 py-3">
                  Refund estimate
                </th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {claimants.map((c) => {
                const claimRows = claimsBySubject.get(c.id) ?? [];
                // Initials circle: first 1-2 chars of firm name
                const initials = c.name
                  .split(' ')
                  .slice(0, 2)
                  .map((w) => w[0])
                  .join('')
                  .toUpperCase();

                return (
                  <tr
                    key={c.id}
                    className="border-b border-border last:border-0 hover:bg-muted/40 transition-colors"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        {/* Initials circle */}
                        <span className="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-full bg-[hsl(var(--brand-accent-subtle))] border border-[hsl(var(--brand-accent))] font-mono text-[10px] font-medium text-[hsl(var(--brand-accent-strong))]">
                          {initials}
                        </span>
                        <Link
                          href={`/subject-tenants/${c.id}`}
                          className="font-medium hover:text-primary transition-colors"
                        >
                          {c.name}
                        </Link>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums font-mono text-sm">
                      {claimRows.length}
                    </td>
                    <td className="px-4 py-3">
                      {/* Progress bar placeholder — will fill when expenditure data lands */}
                      <div className="flex items-center gap-2 justify-end">
                        <div className="w-20 h-1.5 rounded-full bg-[hsl(var(--brand-hairline))] overflow-hidden">
                          <div
                            className="h-full rounded-full bg-[hsl(var(--brand-accent))] opacity-30"
                            style={{ width: '0%' }}
                          />
                        </div>
                        <span className="font-mono text-sm text-muted-foreground tabular-nums">
                          —
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/subject-tenants/${c.id}`}
                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      >
                        View <ArrowUpRight className="h-3 w-3" />
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted-foreground mt-3">
        Refund estimates use the R&amp;D Tax Offset refundable rate (43.5%) on total mapped
        expenditure. Per-claimant amounts populate once expenditure mapping is run.
      </p>
    </section>
  );
}

function SectionHeading({ kicker, title }: { kicker: string; title: string }) {
  return (
    <header className="mb-5">
      <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground mb-1">
        {kicker}
      </p>
      <h2 className="font-display text-2xl font-medium">{title}</h2>
    </header>
  );
}

function KpiTile({
  icon: Icon,
  label,
  value,
  comparison,
  dimValue = false,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  comparison?: string;
  dimValue?: boolean;
}) {
  return (
    <Card className="border-border bg-card">
      <CardContent className="py-6 px-5">
        <div className="flex items-start justify-between gap-2 mb-4">
          <div className="rounded bg-primary/10 p-2 text-primary">
            <Icon className="h-4 w-4" />
          </div>
        </div>
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground mb-1">
          {label}
        </p>
        <p
          className={`font-display text-4xl font-semibold tabular-nums leading-none ${dimValue ? 'text-muted-foreground' : 'text-foreground'}`}
        >
          {value}
        </p>
        {comparison && (
          <p className="text-xs text-muted-foreground mt-2 leading-relaxed">{comparison}</p>
        )}
      </CardContent>
    </Card>
  );
}

// Acknowledge unused REFUND_RATE + formatAUD/formatAUDCompact reference so the future
// expenditure-summary wire-up has a clearly-marked spot to plug into.
// Once GET /v1/expenditures/summary lands, replace the "—" cells with
// `formatAUDCompact(totalExpenditureAud * REFUND_RATE)` for the hero
// and `formatAUD(claimantExpenditureAud * REFUND_RATE)` for the table.
void REFUND_RATE;
void formatAUD;
void formatAUDCompact;
