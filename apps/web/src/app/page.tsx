'use client';
/**
 * Dashboard home — the landing page for an authenticated consultant.
 *
 * Renders inside AppShell (so the page itself only owns the content area —
 * no header, no nav). Shows: a commanding Fraunces display hero with a
 * right-side chain-integrity forensic panel, quick-action cards with visual
 * weight, and a styled empty-state when no data exists yet.
 */
import Link from 'next/link';
import {
  ArrowRight,
  Building2,
  FolderOpen,
  Sparkles,
  Workflow,
  Users,
  ShieldCheck,
  CheckCircle2,
} from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { ForensicChip } from '@/components/forensic-chip';
import { EmptyState } from '@/components/empty-state';
import { StartClaimButton } from '@/components/start-claim-button';
import { useWhoami } from '@/hooks/use-whoami';

export default function DashboardPage() {
  return (
    <AppShell>
      <DashboardContent />
    </AppShell>
  );
}

interface QuickAction {
  href: string;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  stat?: string;
  statLabel?: string;
}

const QUICK_ACTIONS: QuickAction[] = [
  {
    href: '/projects',
    label: 'Projects',
    description: 'R&D project register',
    icon: FolderOpen,
  },
  {
    href: '/pipeline',
    label: 'Pipeline',
    description: 'Claims in progress',
    icon: Workflow,
  },
  {
    href: '/subject-tenants',
    label: 'Client firms',
    description: 'Subject claimant firms you advise',
    icon: Building2,
  },
  {
    href: '/suggestions',
    label: 'Suggestions',
    description: 'Agent-generated narrative & evidence cues',
    icon: Sparkles,
  },
];

// Cream-on-cream ledger-grid SVG background pattern
// Fine horizontal rules on warm paper — evokes an accountant's ruled pad
function LedgerBackground() {
  return (
    <svg
      aria-hidden="true"
      className="absolute inset-0 w-full h-full pointer-events-none select-none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ opacity: 0.045 }}
    >
      <defs>
        <pattern id="ledger-grid" x="0" y="0" width="1" height="28" patternUnits="userSpaceOnUse">
          <line x1="0" y1="27.5" x2="100%" y2="27.5" stroke="#5C7A6B" strokeWidth="0.75" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#ledger-grid)" />
    </svg>
  );
}

// Static demo chain-integrity data — will be replaced by live data once
// the audit-chain summary endpoint ships (TODO: wire to GET /v1/audit/summary).
const CHAIN_EVENTS = [
  {
    hash: 'a3f8c1d2e9b0472f',
    capturedAt: new Date(Date.now() - 1000 * 60 * 14),
    version: 'v12',
    state: 'verified' as const,
    label: 'Evidence uploaded',
  },
  {
    hash: 'c7e2b549da1f8304',
    capturedAt: new Date(Date.now() - 1000 * 60 * 47),
    version: 'v11',
    state: 'verified' as const,
    label: 'Narrative revised',
  },
  {
    hash: '91d04a3bc6f2e817',
    capturedAt: new Date(Date.now() - 1000 * 60 * 120),
    version: 'v10',
    state: 'verified' as const,
    label: 'Claim stage advanced',
  },
];

function ChainIntegrityPanel() {
  return (
    <div className="rounded border border-[hsl(var(--brand-hairline))] bg-card/80 p-5 space-y-4 min-w-0">
      {/* Panel heading */}
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          Chain integrity
        </p>
        <span className="inline-flex items-center gap-1 rounded-full bg-[hsl(var(--brand-accent-subtle))] border border-[hsl(var(--brand-accent))] px-2 py-0.5 font-mono text-[10px] text-[hsl(var(--brand-accent-strong))]">
          <CheckCircle2 className="h-2.5 w-2.5" />
          All verified
        </span>
      </div>

      {/* Event rows */}
      <div className="space-y-3">
        {CHAIN_EVENTS.map((event) => (
          <div key={event.hash} className="space-y-1">
            <p className="text-xs text-muted-foreground">{event.label}</p>
            <ForensicChip
              hash={event.hash}
              capturedAt={event.capturedAt}
              version={event.version}
              state={event.state}
              size="sm"
            />
          </div>
        ))}
      </div>

      <p className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/60 pt-1 border-t border-[hsl(var(--brand-hairline))]">
        TR 2021/5 &middot; Hash-chain verified
      </p>
    </div>
  );
}

function DashboardContent() {
  const { data } = useWhoami();
  if (!data) return null;

  const activeTenant = data.availableTenants.find((t) => t.tenantId === data.user.tenantId);
  const firstName = data.user.email.split('@')[0]?.split('.')[0] ?? 'there';
  const formattedFirstName = firstName.charAt(0).toUpperCase() + firstName.slice(1);

  // Determine time of day for greeting variant
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <div className="space-y-12">
      {/* ── Hero ── */}
      <section className="relative overflow-hidden rounded border border-[hsl(var(--brand-hairline))] bg-card px-8 py-10">
        <LedgerBackground />
        <div className="relative flex flex-col lg:flex-row lg:items-start gap-8">
          {/* Left: display heading */}
          <div className="flex-1 min-w-0 space-y-4">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              {activeTenant?.name ?? 'Dashboard'}
            </p>
            <h1 className="font-display text-5xl tracking-tight leading-[1.1]">
              {greeting},{' '}
              <span className="italic font-semibold text-[hsl(var(--brand-accent))]">
                {formattedFirstName}.
              </span>
            </h1>
            <p className="text-base text-muted-foreground max-w-lg leading-relaxed">
              Start a new claim or pick up where you left off. Every artefact you produce here is
              hash-chained and audit-traceable.
            </p>

            {/* Primary CTA — drops the user straight into the wizard */}
            <div className="pt-1">
              <StartClaimButton size="lg" />
            </div>

            {/* Tenant stat bar */}
            <div className="flex flex-wrap gap-x-8 gap-y-3 pt-2 border-t border-[hsl(var(--brand-hairline))]">
              <HeroStat label="Active firm" value={activeTenant?.name ?? '—'} />
              <HeroStat
                label="Your role"
                value={
                  activeTenant
                    ? activeTenant.role.charAt(0).toUpperCase() + activeTenant.role.slice(1)
                    : '—'
                }
              />
              <HeroStat label="Tenants" value={String(data.availableTenants.length)} mono />
            </div>
          </div>

          {/* Right: chain-integrity panel */}
          <div className="w-full lg:w-72 shrink-0">
            <ChainIntegrityPanel />
          </div>
        </div>
      </section>

      {/* ── Quick actions ── */}
      <section>
        <SectionHeading kicker="Workspace" title="Where would you like to go?" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {QUICK_ACTIONS.map((action) => (
            <QuickActionCard key={action.href} action={action} />
          ))}
        </div>
      </section>

      {/* ── Admin row, only for admins ── */}
      {data.user.role === 'admin' && (
        <section>
          <SectionHeading kicker="Administration" title="Firm settings" />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <QuickActionCard
              action={{
                href: '/users',
                label: 'Firm members',
                description: 'Invite and manage consultants',
                icon: Users,
              }}
            />
            <QuickActionCard
              action={{
                href: '/admin/brand-config',
                label: 'Brand',
                description: 'White-label colours, logo, document themes',
                icon: ShieldCheck,
              }}
            />
            <QuickActionCard
              action={{
                href: '/admin/apportionment',
                label: 'Apportionment rules',
                description: 'Salary and overhead allocation defaults',
                icon: Workflow,
              }}
            />
          </div>
        </section>
      )}

      {/* ── Empty state hint ── */}
      <EmptyState
        icon="ledger"
        title="Your firm is empty"
        description="No projects, claims, evidence or audit events yet. Create your first project to populate the dashboard, or invite team members to start contributing."
        action={{ label: 'Open Projects', href: '/projects' }}
      />
    </div>
  );
}

function HeroStat({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground mb-0.5">
        {label}
      </p>
      <p className={mono ? 'font-mono text-sm tabular-nums' : 'font-display text-lg font-medium'}>
        {value}
      </p>
    </div>
  );
}

function SectionHeading({ kicker, title }: { kicker: string; title: string }) {
  return (
    <header className="mb-5">
      <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground mb-1">
        {kicker}
      </p>
      <h2 className="font-display text-3xl font-medium">{title}</h2>
    </header>
  );
}

function QuickActionCard({ action }: { action: QuickAction }) {
  const Icon = action.icon;
  return (
    <Link
      href={action.href}
      className="group flex flex-col gap-4 p-5 rounded border border-border bg-card
        shadow-[0_1px_0_rgba(36,9,9,0.04),0_4px_12px_-4px_rgba(36,9,9,0.06)]
        hover:translate-y-[-2px] hover:shadow-[0_2px_0_rgba(36,9,9,0.04),0_8px_20px_-4px_rgba(36,9,9,0.10)]
        hover:border-primary/30
        transition-[transform,box-shadow,border-color] duration-150 ease-out"
    >
      {/* Icon + arrow row */}
      <div className="flex items-start justify-between">
        <div className="rounded bg-primary/10 p-2.5 text-primary group-hover:bg-primary/20 transition-colors">
          <Icon className="h-4 w-4" />
        </div>
        <ArrowRight className="h-4 w-4 text-muted-foreground/30 group-hover:text-primary group-hover:translate-x-0.5 transition-[color,transform] duration-150 mt-1" />
      </div>

      {/* Label + description */}
      <div className="space-y-1">
        <p className="font-display text-lg font-medium text-foreground group-hover:text-primary transition-colors leading-tight">
          {action.label}
        </p>
        <p className="text-xs text-muted-foreground leading-relaxed">{action.description}</p>
      </div>
    </Link>
  );
}
