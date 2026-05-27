'use client';

/**
 * Wizard Step 1 — Engagement Letter panel.
 *
 * Renders the current engagement state for a claim, plus the relevant
 * CTA for that state. There are six variants — see `EngagementStatus`
 * in `use-claim-engagement.ts` — and each carries different
 * affordances:
 *
 *   - pending_send → Send CTA
 *   - sent         → sent timestamp + Resend link + awaiting badge
 *   - signed       → signed metadata + Countersign CTA
 *   - countersigned→ both timestamps + signed-PDF download
 *   - declined     → declined timestamp + reason + Send-new CTA
 *   - expired      → expired timestamp + Send-new CTA
 *
 * The panel also drives the "Engagement required" gate that disables
 * downstream wizard steps until the claim reaches `signed` or
 * `countersigned`. The gate logic itself lives in wizard-view.tsx; this
 * component just exposes the boolean via `<EngagementPanel>`'s parent.
 *
 * Design language mirrors dashboard-view.tsx — ink2 card, ruleStrong
 * border, 4px radius, mono labels for header rows, serif for the title
 * accent. No Tailwind, all inline tokens.
 */

import type { ReactNode } from 'react';
import {
  amber,
  amberSoft,
  bone,
  bone2,
  bone3,
  bone4,
  fMono,
  fSans,
  fSerif,
  ink,
  ink2,
  ink3,
  rule,
  ruleStrong,
  rust,
  sage,
} from './tokens';
import { Diamond, MonoLabel } from './atoms';
import {
  useClaimEngagement,
  type ClaimEngagementResponse,
  type EngagementStatus,
} from '@/lib/hooks/use-claim-engagement';
import { useSendEngagement } from '@/lib/hooks/use-send-engagement';
import { useCountersignEngagement } from '@/lib/hooks/use-countersign-engagement';

interface EngagementPanelProps {
  claimId: string;
  claimantName: string;
  /** Claim-period label rendered alongside the claimant name, e.g. "FY26". */
  fiscalYearLabel?: string;
}

/**
 * Returns whether the engagement is in a state that unblocks the rest
 * of the wizard. Mirrors the wizard-view.tsx gate condition.
 */
export function isEngagementUnblocked(status: EngagementStatus | undefined): boolean {
  return status === 'signed' || status === 'countersigned';
}

export function EngagementPanel({ claimId, claimantName, fiscalYearLabel }: EngagementPanelProps) {
  const { data, isLoading, error } = useClaimEngagement(claimId);

  if (isLoading) {
    return <EngagementPanelSkeleton />;
  }

  if (error) {
    return (
      <PanelShell statusBadge={null}>
        <div
          style={{
            padding: '18px 22px',
            color: rust,
            fontFamily: fSans,
            fontSize: 13,
          }}
        >
          Couldn&rsquo;t load engagement status. Please refresh.
        </div>
      </PanelShell>
    );
  }

  const view: ClaimEngagementResponse = data ?? { status: 'pending_send', engagement: null };

  return (
    <PanelShell statusBadge={<EngagementStatusPill status={view.status} />}>
      <div style={{ padding: '18px 22px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 10,
            marginBottom: 6,
          }}
        >
          <span
            style={{
              fontFamily: fSerif,
              fontSize: 22,
              fontWeight: 400,
              color: bone,
              letterSpacing: '-0.01em',
            }}
          >
            {claimantName}
          </span>
          {fiscalYearLabel && (
            <MonoLabel size={10} color={bone3} tracking="0.18em">
              {fiscalYearLabel}
            </MonoLabel>
          )}
          <span style={{ marginLeft: 4, fontFamily: fSans, fontSize: 13, color: bone3 }}>
            Engagement Letter
          </span>
        </div>

        <EngagementBody claimId={claimId} view={view} />
      </div>
    </PanelShell>
  );
}

/** ----- Variants ------------------------------------------------------- */

function EngagementBody({ claimId, view }: { claimId: string; view: ClaimEngagementResponse }) {
  switch (view.status) {
    case 'pending_send':
      return <PendingSendVariant claimId={claimId} />;
    case 'sent':
      return <SentVariant claimId={claimId} view={view} />;
    case 'signed':
      return <SignedVariant claimId={claimId} view={view} />;
    case 'countersigned':
      return <CountersignedVariant view={view} />;
    case 'declined':
      return <DeclinedVariant claimId={claimId} view={view} />;
    case 'expired':
      return <ExpiredVariant claimId={claimId} view={view} />;
  }
}

function PendingSendVariant({ claimId }: { claimId: string }) {
  const send = useSendEngagement(claimId);
  return (
    <>
      <p style={{ fontFamily: fSans, fontSize: 13.5, color: bone3, margin: '0 0 18px' }}>
        Send the engagement letter to start the claim. The claimant signs first; you countersign
        once they&rsquo;ve completed it.
      </p>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <PrimaryButton onClick={() => send.mutate()} disabled={send.isPending}>
          {send.isPending ? 'Sending…' : 'Send engagement letter'}
        </PrimaryButton>
        {send.isError && <ErrorText>Send failed. Try again.</ErrorText>}
      </div>
    </>
  );
}

function SentVariant({ claimId, view }: { claimId: string; view: ClaimEngagementResponse }) {
  const send = useSendEngagement(claimId);
  return (
    <>
      <FactGrid>
        <Fact label="SENT" value={formatTimestamp(view.engagement?.sentToClaimantAt)} />
        <Fact
          label="EXPIRES"
          value={view.engagement?.expiresAt ? formatTimestamp(view.engagement.expiresAt) : '—'}
        />
      </FactGrid>
      <AwaitingStrip label="Awaiting claimant signature" tone="amber" />
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginTop: 14 }}>
        <LinkButton onClick={() => send.mutate()} disabled={send.isPending}>
          {send.isPending ? 'Resending…' : 'Resend letter'}
        </LinkButton>
        {send.isError && <ErrorText>Resend failed.</ErrorText>}
      </div>
    </>
  );
}

function SignedVariant({ claimId, view }: { claimId: string; view: ClaimEngagementResponse }) {
  const countersign = useCountersignEngagement(claimId);
  const engagementId = view.engagement?.id;
  return (
    <>
      <FactGrid>
        <Fact label="SENT" value={formatTimestamp(view.engagement?.sentToClaimantAt)} />
        <Fact label="SIGNED" value={formatTimestamp(view.engagement?.signedByClaimantAt)} />
        <Fact label="SIGNER" value={view.engagement?.signedByClaimantName ?? '—'} />
      </FactGrid>
      <AwaitingStrip label="Awaiting countersign" tone="amber">
        <PrimaryButton
          onClick={() => {
            if (engagementId) {
              countersign.mutate(engagementId);
            }
          }}
          disabled={!engagementId || countersign.isPending}
        >
          {countersign.isPending ? 'Countersigning…' : 'Countersign as consultant'}
        </PrimaryButton>
      </AwaitingStrip>
      {countersign.isError && (
        <div style={{ marginTop: 10 }}>
          <ErrorText>Countersign failed. Try again.</ErrorText>
        </div>
      )}
    </>
  );
}

function CountersignedVariant({ view }: { view: ClaimEngagementResponse }) {
  return (
    <>
      <FactGrid>
        <Fact label="SENT" value={formatTimestamp(view.engagement?.sentToClaimantAt)} />
        <Fact label="SIGNED" value={formatTimestamp(view.engagement?.signedByClaimantAt)} />
        <Fact label="SIGNER" value={view.engagement?.signedByClaimantName ?? '—'} />
        <Fact label="COUNTERSIGNED" value={formatTimestamp(view.engagement?.countersignedAt)} />
        {view.engagement?.countersignedByUserName && (
          <Fact label="COUNTERSIGNED BY" value={view.engagement.countersignedByUserName} />
        )}
      </FactGrid>
      <div
        style={{
          marginTop: 16,
          padding: '12px 14px',
          background: 'rgba(122,150,133,0.10)',
          border: `1px solid ${sage}`,
          borderRadius: 3,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Diamond size={7} color={sage} />
          <MonoLabel size={10} color={sage}>
            ENGAGEMENT COMPLETE
          </MonoLabel>
        </div>
        {view.engagement?.pdfEvidenceId ? (
          <a
            href={`/v1/evidence/${view.engagement.pdfEvidenceId}/download`}
            style={{
              fontFamily: fMono,
              fontSize: 10.5,
              letterSpacing: '0.16em',
              color: amber,
              textDecoration: 'none',
              padding: '6px 12px',
              border: `1px solid ${amber}`,
              borderRadius: 3,
            }}
          >
            DOWNLOAD SIGNED PDF
          </a>
        ) : (
          <MonoLabel size={9.5} color={bone4}>
            PDF GENERATING…
          </MonoLabel>
        )}
      </div>
    </>
  );
}

function DeclinedVariant({ claimId, view }: { claimId: string; view: ClaimEngagementResponse }) {
  const send = useSendEngagement(claimId);
  return (
    <>
      <FactGrid>
        <Fact label="SENT" value={formatTimestamp(view.engagement?.sentToClaimantAt)} />
        <Fact label="DECLINED" value={formatTimestamp(view.engagement?.declinedAt)} />
      </FactGrid>
      {view.engagement?.declinedReason && (
        <div
          style={{
            marginTop: 14,
            padding: '12px 14px',
            background: 'rgba(196,106,72,0.10)',
            border: `1px solid ${rust}`,
            borderRadius: 3,
          }}
        >
          <MonoLabel size={9.5} color={rust} tracking="0.16em">
            REASON
          </MonoLabel>
          <div style={{ marginTop: 6, fontFamily: fSans, fontSize: 13, color: bone2 }}>
            {view.engagement.declinedReason}
          </div>
        </div>
      )}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 14 }}>
        <PrimaryButton onClick={() => send.mutate()} disabled={send.isPending}>
          {send.isPending ? 'Sending…' : 'Send a new engagement letter'}
        </PrimaryButton>
        {send.isError && <ErrorText>Send failed.</ErrorText>}
      </div>
    </>
  );
}

function ExpiredVariant({ claimId, view }: { claimId: string; view: ClaimEngagementResponse }) {
  const send = useSendEngagement(claimId);
  return (
    <>
      <FactGrid>
        <Fact label="SENT" value={formatTimestamp(view.engagement?.sentToClaimantAt)} />
        <Fact label="EXPIRED" value={formatTimestamp(view.engagement?.expiresAt)} />
      </FactGrid>
      <div
        style={{
          marginTop: 14,
          padding: '10px 14px',
          background: ink3,
          border: `1px solid ${ruleStrong}`,
          borderRadius: 3,
          fontFamily: fSans,
          fontSize: 13,
          color: bone3,
        }}
      >
        The signing link expired before the claimant completed it. Send a new letter to restart the
        engagement.
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 14 }}>
        <PrimaryButton onClick={() => send.mutate()} disabled={send.isPending}>
          {send.isPending ? 'Sending…' : 'Send a new engagement letter'}
        </PrimaryButton>
        {send.isError && <ErrorText>Send failed.</ErrorText>}
      </div>
    </>
  );
}

/** ----- Shared sub-components ----------------------------------------- */

function PanelShell({ children, statusBadge }: { children: ReactNode; statusBadge: ReactNode }) {
  return (
    <div
      style={{
        background: ink2,
        border: `1px solid ${ruleStrong}`,
        borderRadius: 4,
        marginBottom: 18,
      }}
    >
      <div
        style={{
          padding: '14px 22px',
          borderBottom: `1px solid ${rule}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Diamond size={7} />
          <MonoLabel size={11} color={amber}>
            STEP 01 · ENGAGEMENT
          </MonoLabel>
        </div>
        {statusBadge}
      </div>
      {children}
    </div>
  );
}

/**
 * Status pill specific to engagement states. The shared `StatusPill`
 * atom uses a different vocabulary (drafting/review/sealed/...) — we
 * keep a sibling component here so we don't pollute that union with
 * engagement-only kinds. Tone choices mirror the atom's palette: amber
 * for in-flight, sage for done, bone for neutral, rust for negative.
 */
function EngagementStatusPill({ status }: { status: EngagementStatus }) {
  const cfg = ENGAGEMENT_PILL[status];
  return (
    <span
      style={{
        padding: '3px 10px',
        border: `1px solid ${cfg.c}`,
        background: cfg.bg,
        color: cfg.c,
        fontFamily: fMono,
        fontSize: 9.5,
        letterSpacing: '0.16em',
        borderRadius: 2,
      }}
    >
      {cfg.t}
    </span>
  );
}

const ENGAGEMENT_PILL: Record<EngagementStatus, { c: string; bg: string; t: string }> = {
  pending_send: { c: bone3, bg: ink3, t: 'PENDING SEND' },
  sent: { c: amber, bg: 'rgba(225,162,58,0.10)', t: 'SENT' },
  signed: { c: amber, bg: 'rgba(225,162,58,0.18)', t: 'SIGNED' },
  countersigned: { c: sage, bg: 'rgba(122,150,133,0.18)', t: 'COUNTERSIGNED' },
  declined: { c: rust, bg: 'rgba(196,106,72,0.15)', t: 'DECLINED' },
  expired: { c: bone4, bg: ink3, t: 'EXPIRED' },
};

function FactGrid({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
        gap: 12,
        marginBottom: 14,
      }}
    >
      {children}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        padding: '10px 12px',
        background: ink3,
        border: `1px solid ${rule}`,
        borderRadius: 3,
      }}
    >
      <MonoLabel size={9} color={bone3} tracking="0.18em">
        {label}
      </MonoLabel>
      <div
        style={{
          marginTop: 6,
          fontFamily: fSans,
          fontSize: 13.5,
          color: bone,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function AwaitingStrip({
  label,
  tone,
  children,
}: {
  label: string;
  tone: 'amber' | 'sage';
  children?: ReactNode;
}) {
  const accent = tone === 'sage' ? sage : amber;
  return (
    <div
      style={{
        padding: '12px 14px',
        background: tone === 'sage' ? 'rgba(122,150,133,0.08)' : 'rgba(225,162,58,0.08)',
        border: `1px dashed ${accent}`,
        borderRadius: 3,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        justifyContent: 'space-between',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Diamond size={6} color={accent} />
        <MonoLabel size={10} color={accent}>
          {label.toUpperCase()}
        </MonoLabel>
      </div>
      {children}
    </div>
  );
}

function PrimaryButton({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '9px 16px',
        background: disabled ? amberSoft : amber,
        color: ink,
        border: 'none',
        borderRadius: 3,
        fontFamily: fMono,
        fontSize: 11,
        letterSpacing: '0.16em',
        fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.7 : 1,
      }}
    >
      {children}
    </button>
  );
}

function LinkButton({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        background: 'transparent',
        border: 'none',
        padding: 0,
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontFamily: fMono,
        fontSize: 11,
        letterSpacing: '0.16em',
        color: amber,
        textDecoration: 'underline',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

function ErrorText({ children }: { children: ReactNode }) {
  return <span style={{ fontFamily: fSans, fontSize: 12, color: rust }}>{children}</span>;
}

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-AU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function EngagementPanelSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading engagement letter"
      style={{
        background: ink2,
        border: `1px solid ${ruleStrong}`,
        borderRadius: 4,
        marginBottom: 18,
      }}
    >
      <div
        style={{
          padding: '14px 22px',
          borderBottom: `1px solid ${rule}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ height: 12, width: 160, background: rule, borderRadius: 2 }} />
        <div style={{ height: 16, width: 80, background: rule, borderRadius: 2 }} />
      </div>
      <div style={{ padding: '18px 22px' }}>
        <div style={{ height: 22, width: 260, background: rule, borderRadius: 2 }} />
        <div
          style={{ marginTop: 14, height: 14, width: '70%', background: rule, borderRadius: 2 }}
        />
        <div style={{ marginTop: 18, height: 38, width: 220, background: rule, borderRadius: 3 }} />
      </div>
    </div>
  );
}
