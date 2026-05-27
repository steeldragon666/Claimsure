import { ForensicChip } from '@/components/forensic-chip';
import { AgentChip } from '@/components/agent-chip';
import { TransitionBadge } from '@/components/transition-badge';
import { YearMarker } from '@/components/year-marker';
import { DensityToggle } from '@/components/density-toggle';

/**
 * Design system style guide.
 *
 * Single-page visual reference for the ArchiveOne design system.
 * Renders every signature component with all states/variants,
 * documents color tokens and the type scale, and includes the
 * chain-verify-pulse signature animation in action.
 *
 * Source of truth: docs/design/system.md + docs/design/tokens.json.
 *
 * Why a route page instead of Storybook: a Next.js route deploys with
 * the rest of /web, uses the same fonts + tokens + dev server, and
 * doesn't add a parallel build target. Trade-off: interactive controls
 * (knobs, args) are absent — but for our use case (visual QA + token
 * reference) those aren't worth the ceremony.
 */

const sampleHash = 'a3f2b9c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1';
const sampleTime = '2026-05-06T15:42:10.000Z';

export default function StyleguidePage() {
  return (
    <main className="mx-auto max-w-[1280px] px-6 py-12">
      {/* ---------- Header ---------- */}
      <header className="mb-12 border-b border-[hsl(var(--brand-hairline))] pb-6">
        <h1 className="font-display text-5xl font-semibold tracking-tight text-[hsl(var(--brand-ink))]">
          Design System
        </h1>
        <p className="mt-2 max-w-2xl font-body text-lg text-[hsl(var(--brand-ink-muted))]">
          Living reference for ArchiveOne&apos;s visual primitives. Source of truth lives in{' '}
          <code className="font-mono text-sm">docs/design/system.md</code>; this page renders the
          tokens and components in action.
        </p>
      </header>

      {/* ---------- Color tokens ---------- */}
      <Section title="Color Tokens" subtitle="11 brand colors mapped to semantic CSS variables.">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Swatch token="--brand-base" hex="#FAF8F3" usage="Page background, warm cream" />
          <Swatch token="--brand-ink" hex="#1A1814" usage="Primary text, near-black warm" />
          <Swatch token="--brand-ink-muted" hex="#6B6258" usage="Secondary text, body subtle" />
          <Swatch token="--brand-ink-subtle" hex="#9C9388" usage="Captions, metadata" />
          <Swatch token="--brand-hairline" hex="#E8E2D5" usage="Borders, dividers" />
          <Swatch token="--brand-hairline-strong" hex="#D4CCB8" usage="Strong borders, focused" />
          <Swatch token="--brand-accent" hex="#5C7A6B" usage="Patina green, signature accent" />
          <Swatch token="--brand-accent-strong" hex="#3D5448" usage="Hover/active accent" />
          <Swatch token="--brand-accent-subtle" hex="#D9E2DC" usage="Tinted accent surfaces" />
          <Swatch token="--brand-warning" hex="#B8732B" usage="Terracotta — R&DTI flag" />
          <Swatch token="--brand-error" hex="#9E3838" usage="Clay red — never pure red" />
          <Swatch token="--brand-info" hex="#5A6478" usage="Slate — system messages" />
        </div>
      </Section>

      {/* ---------- Typography ---------- */}
      <Section
        title="Typography"
        subtitle="Fraunces (display) + Inter Tight (body) + JetBrains Mono (forensic)."
      >
        <div className="space-y-3">
          <TypeRow
            scale="display-2xl"
            className="font-display text-[56px] leading-[1.05] font-semibold tracking-[-0.04em]"
          >
            Marketing wordmark — display-2xl
          </TypeRow>
          <TypeRow
            scale="display-xl"
            className="font-display text-[44px] leading-[1.10] font-semibold tracking-[-0.03em]"
          >
            Page-level title — display-xl
          </TypeRow>
          <TypeRow
            scale="display-lg"
            className="font-display text-[32px] leading-[1.15] font-semibold tracking-[-0.02em]"
          >
            Section head — display-lg
          </TypeRow>
          <TypeRow
            scale="display-md"
            className="font-display text-2xl leading-[1.20] font-semibold tracking-[-0.01em]"
          >
            Card head — display-md
          </TypeRow>
          <TypeRow scale="display-sm" className="font-display text-xl leading-[1.25] font-semibold">
            Subsection head — display-sm
          </TypeRow>
          <TypeRow scale="body-lg" className="font-body text-base leading-[1.50]">
            Default body, prose — body-lg. Reads well at the default 16/24 ratio for narrative text.
          </TypeRow>
          <TypeRow scale="body-md" className="font-body text-sm leading-[1.45]">
            Dense UI body, table cells — body-md. Used in consultant cockpit and admin panels.
          </TypeRow>
          <TypeRow scale="body-sm" className="font-body text-xs leading-[1.40] tracking-[0.01em]">
            Captions, metadata, footnotes — body-sm. Slight tracking lift maintains readability at
            small sizes.
          </TypeRow>
          <TypeRow scale="mono-md" className="font-mono text-sm leading-[1.45] tabular-nums">
            a3f2b9c1 · 2026-05-06 15:42 · v3 — mono-md (inline forensic data)
          </TypeRow>
          <TypeRow scale="mono-sm" className="font-mono text-xs leading-[1.40] tabular-nums">
            a3f2b9c1 · 2026-05-06 15:42 · v3 — mono-sm (forensic chips, hash badges)
          </TypeRow>
        </div>
      </Section>

      {/* ---------- ForensicChip ---------- */}
      <Section
        title="ForensicChip"
        subtitle="The most-repeated visual element. Renders inline next to every claim-bearing artefact."
      >
        <SubsectionLabel>Sizes — md (default, inline use) + sm (dense tables)</SubsectionLabel>
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <ForensicChip hash={sampleHash} capturedAt={sampleTime} version="v3" size="md" />
          <ForensicChip hash={sampleHash} capturedAt={sampleTime} version="v3" size="sm" />
        </div>

        <SubsectionLabel>States — default, verifying (animates), verified, broken</SubsectionLabel>
        <div className="flex flex-wrap items-center gap-3">
          <ForensicChip hash={sampleHash} capturedAt={sampleTime} version="v3" state="default" />
          <ForensicChip hash={sampleHash} capturedAt={sampleTime} version="v3" state="verifying" />
          <ForensicChip hash={sampleHash} capturedAt={sampleTime} version="v3" state="verified" />
          <ForensicChip hash={sampleHash} capturedAt={sampleTime} version="v3" state="broken" />
        </div>

        <SubsectionLabel>Without version pin — drops trailing segment</SubsectionLabel>
        <div className="flex flex-wrap items-center gap-3">
          <ForensicChip hash={sampleHash} capturedAt={sampleTime} />
          <ForensicChip hash={sampleHash} capturedAt={sampleTime} state="verified" />
        </div>
      </Section>

      {/* ---------- AgentChip ---------- */}
      <Section
        title="AgentChip"
        subtitle="Distinguishes agent contributions from consultant authorship."
      >
        <div className="flex flex-wrap items-center gap-3">
          <AgentChip agentName="Agent C" versionPin="v1.1.0" />
          <AgentChip
            agentName="Drafter"
            versionPin="draft-narrative@1.1.0"
            modelName="claude-opus-4-7"
            promptModulePath="packages/agents/src/narrative-drafter/prompts/draft-narrative@1.1.0.ts"
          />
          <AgentChip agentName="Classifier" versionPin="classify@1.0.0" />
        </div>
      </Section>

      {/* ---------- TransitionBadge ---------- */}
      <Section
        title="TransitionBadge"
        subtitle="Multi-cycle timeline gutter pill. 4 variants for activity transitions across FYs."
      >
        <div className="flex flex-wrap items-center gap-3">
          <TransitionBadge variant="continuation" label="Continuation" />
          <TransitionBadge
            variant="pivot"
            label="Pivot"
            rationale="Original quantum-tunneling approach proved infeasible — pivoted to thermal management"
          />
          <TransitionBadge variant="completion" label="Completion" />
          <TransitionBadge variant="abandoned" label="Abandoned" />
        </div>
      </Section>

      {/* ---------- YearMarker ---------- */}
      <Section
        title="YearMarker"
        subtitle="Multi-cycle timeline column header. Fraunces display-md."
      >
        <div className="flex flex-wrap items-end gap-8">
          <YearMarker fyLabel="FY24" state="past" />
          <YearMarker fyLabel="FY25" state="current" />
          <YearMarker fyLabel="FY26" state="future" />
        </div>
      </Section>

      {/* ---------- DensityToggle ---------- */}
      <Section
        title="DensityToggle"
        subtitle="Click to swap data-density attribute on the target container. Persists to localStorage."
      >
        <div className="flex items-center gap-4">
          <DensityToggle storageKey="cpa.styleguide.density" targetSelector="main" />
          <span className="font-body text-sm text-[hsl(var(--brand-ink-muted))]">
            ← click to toggle. Inspect the &lt;main&gt; element&apos;s{' '}
            <code className="font-mono text-xs">data-density</code> attribute to confirm.
          </span>
        </div>
      </Section>

      {/* ---------- Chain-verify pulse animation ---------- */}
      <Section
        title="Signature animation"
        subtitle="The chain-verify-pulse keyframe — the only place motion communicates rigor."
      >
        <div className="rounded-lg border border-[hsl(var(--brand-hairline))] bg-[hsl(var(--brand-base))] p-6">
          <p className="mb-4 font-body text-sm text-[hsl(var(--brand-ink-muted))]">
            On hash chain verification (the API call that runs{' '}
            <code className="font-mono">verifyChain()</code>), the chip&apos;s border pulses from
            hairline to patina over 200ms, then resolves with the checkmark icon.{' '}
            <code className="font-mono">prefers-reduced-motion</code> respected globally.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <ForensicChip
              hash={sampleHash}
              capturedAt={sampleTime}
              version="v3"
              state="verifying"
            />
            <span className="font-body text-sm text-[hsl(var(--brand-ink-subtle))]">
              ↑ animated state (200ms cubic-bezier ease-out, then resolves to verified)
            </span>
          </div>
        </div>
      </Section>

      {/* ---------- Footer ---------- */}
      <footer className="mt-16 border-t border-[hsl(var(--brand-hairline))] pt-6">
        <p className="font-body text-sm text-[hsl(var(--brand-ink-subtle))]">
          Source of truth: <code className="font-mono">docs/design/system.md</code> +{' '}
          <code className="font-mono">docs/design/tokens.json</code>. Components in{' '}
          <code className="font-mono">apps/web/src/components/</code>. Last reviewed: 2026-05-06.
        </p>
      </footer>
    </main>
  );
}

// ---------- Layout helpers ----------

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-12">
      <h2 className="font-display text-3xl font-semibold tracking-tight text-[hsl(var(--brand-ink))]">
        {title}
      </h2>
      <p className="mb-6 mt-1 font-body text-sm text-[hsl(var(--brand-ink-muted))]">{subtitle}</p>
      {children}
    </section>
  );
}

function SubsectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-3 font-body text-xs uppercase tracking-wider text-[hsl(var(--brand-ink-subtle))]">
      {children}
    </h3>
  );
}

function Swatch({ token, hex, usage }: { token: string; hex: string; usage: string }) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-[hsl(var(--brand-hairline))] bg-white p-3">
      <div
        className="h-12 w-12 flex-shrink-0 rounded-sm border border-[hsl(var(--brand-hairline))]"
        style={{ background: hex }}
        aria-label={`${token} swatch`}
      />
      <div className="min-w-0 flex-1">
        <div className="font-mono text-xs font-semibold text-[hsl(var(--brand-ink))]">{token}</div>
        <div className="font-mono text-xs text-[hsl(var(--brand-ink-muted))]">{hex}</div>
        <div className="mt-0.5 font-body text-xs leading-tight text-[hsl(var(--brand-ink-subtle))]">
          {usage}
        </div>
      </div>
    </div>
  );
}

function TypeRow({
  scale,
  children,
  className,
}: {
  scale: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className="flex items-baseline gap-6 border-b border-dashed border-[hsl(var(--brand-hairline))] pb-3 last:border-b-0">
      <span className="w-28 flex-shrink-0 font-mono text-xs uppercase tracking-wider text-[hsl(var(--brand-ink-subtle))]">
        {scale}
      </span>
      <span className={className ?? 'font-body text-base'}>{children}</span>
    </div>
  );
}
