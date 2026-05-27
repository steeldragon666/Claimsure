'use client';

import {
  amber,
  bone,
  bone2,
  bone3,
  bone4,
  fMono,
  fSans,
  fSerif,
  ink,
  ink2,
  rule,
  ruleStrong,
  rust,
} from './tokens';
import { Diamond, MonoLabel, StatusPill, type StatusKind } from './atoms';
import Link from 'next/link';
import { useConsultantRecentChainBlocks } from '@/lib/hooks/use-consultant-recent-chain-blocks';
import { useConsultantSignals } from '@/lib/hooks/use-consultant-signals';
import { useConsultantKpis, type ConsultantKpisResponse } from '@/lib/hooks/use-consultant-kpis';

export function DashboardView() {
  return (
    <div style={{ padding: 28, color: bone, height: '100%', overflow: 'auto' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginBottom: 26,
        }}
      >
        <div>
          <MonoLabel size={10} color={bone3} tracking="0.22em">
            Dashboard · FY26
          </MonoLabel>
          <h1
            style={{
              fontFamily: fSerif,
              fontWeight: 300,
              fontSize: 44,
              lineHeight: 1.0,
              letterSpacing: '-0.025em',
              color: bone,
              margin: '10px 0 0',
            }}
          >
            Good morning, Anna.
          </h1>
          <p
            style={{
              fontFamily: fSans,
              fontSize: 15,
              color: bone3,
              margin: '8px 0 0',
            }}
          >
            Three signals overnight. Two claims need your judgement today.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            style={{
              padding: '10px 18px',
              background: 'transparent',
              color: bone,
              border: `1px solid ${ruleStrong}`,
              borderRadius: 3,
              fontFamily: fMono,
              fontSize: 11,
              letterSpacing: '0.18em',
              cursor: 'pointer',
            }}
          >
            + Import client
          </button>
          <button
            style={{
              padding: '10px 18px',
              background: amber,
              color: ink,
              border: 'none',
              borderRadius: 3,
              fontFamily: fMono,
              fontSize: 11,
              letterSpacing: '0.18em',
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            + New claim
          </button>
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 14,
          marginBottom: 22,
        }}
      >
        <KpiStrip fy="FY26" />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 14 }}>
        <ClaimsPanel />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <WatchPanel />
          <ChainPanel />
        </div>
      </div>
    </div>
  );
}

interface KPIProps {
  k: string;
  big: string;
  suffix?: string;
  sub: string;
  /**
   * Trend string below the divider. When `null` the trend row is omitted
   * entirely — used when the server returns a `null` delta (e.g.
   * `atRiskVsYesterday` until the daily-snapshot job lands) or when the
   * prior FY had no comparable baseline.
   */
  trend: string | null;
  tone?: 'rust' | 'amber';
}

function KPI({ k, big, suffix, sub, trend, tone }: KPIProps) {
  const color = tone === 'rust' ? rust : tone === 'amber' ? amber : bone;
  return (
    <div
      style={{
        padding: '18px 20px',
        background: ink2,
        border: `1px solid ${ruleStrong}`,
        borderRadius: 4,
      }}
    >
      <MonoLabel size={9.5} color={bone3} tracking="0.2em">
        {k}
      </MonoLabel>
      <div
        style={{
          fontFamily: fSerif,
          fontWeight: 300,
          fontSize: 48,
          lineHeight: 1,
          letterSpacing: '-0.025em',
          color,
          marginTop: 14,
          display: 'flex',
          alignItems: 'baseline',
          gap: 4,
        }}
      >
        {big}
        {suffix && <span style={{ fontSize: 28, color: amber }}>{suffix}</span>}
      </div>
      <div style={{ fontFamily: fSans, fontSize: 12, color: bone3, marginTop: 8 }}>{sub}</div>
      {trend !== null && (
        <div
          style={{
            marginTop: 10,
            paddingTop: 8,
            borderTop: `1px solid ${rule}`,
            fontFamily: fMono,
            fontSize: 9,
            color: bone4,
            letterSpacing: '0.14em',
          }}
        >
          {trend}
        </div>
      )}
    </div>
  );
}

/**
 * Skeleton with the same vertical footprint as the loaded KPI card — label
 * row, big number (48px), sub row, divider + trend — so populating the
 * strip causes no visible layout shift on first paint.
 */
function KPISkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading KPI"
      style={{
        padding: '18px 20px',
        background: ink2,
        border: `1px solid ${ruleStrong}`,
        borderRadius: 4,
      }}
    >
      <div style={{ height: 12, width: 110, background: rule, borderRadius: 2 }} />
      <div
        style={{
          marginTop: 14,
          height: 48,
          width: 90,
          background: rule,
          borderRadius: 2,
        }}
      />
      <div style={{ marginTop: 8, height: 14, width: 140, background: rule, borderRadius: 2 }} />
      <div
        style={{
          marginTop: 10,
          paddingTop: 8,
          borderTop: `1px solid ${rule}`,
        }}
      >
        <div style={{ height: 10, width: 120, background: rule, borderRadius: 2 }} />
      </div>
    </div>
  );
}

function formatActiveClaimsTrend(delta: number | null): string | null {
  if (delta === null) return null;
  if (delta === 0) return 'no change vs last FY';
  const sign = delta > 0 ? '+' : '−';
  return `${sign}${Math.abs(delta)} vs last FY`;
}

function formatEvidenceTrend(pct: number | null): string | null {
  if (pct === null) return null;
  if (pct === 0) return 'flat YoY';
  const arrow = pct > 0 ? '↑' : '↓';
  return `${arrow} ${Math.abs(pct)}%`;
}

function formatAtRiskTrend(delta: number | null): string | null {
  if (delta === null) return null;
  if (delta === 0) return 'no change since yesterday';
  const sign = delta > 0 ? '+' : '−';
  return `${sign}${Math.abs(delta)} since yesterday`;
}

function formatCoverageTrend(pts: number | null): string | null {
  if (pts === null) return null;
  if (pts === 0) return 'flat YoY';
  const sign = pts > 0 ? '+' : '−';
  return `${sign}${Math.abs(pts)}pts YoY`;
}

function formatBig(n: number): string {
  return n.toLocaleString('en-AU');
}

function KpiStrip({ fy }: { fy: string }) {
  const { data, isLoading } = useConsultantKpis({ fy });

  if (isLoading || !data) {
    return (
      <>
        <KPISkeleton />
        <KPISkeleton />
        <KPISkeleton />
        <KPISkeleton />
      </>
    );
  }

  const k: ConsultantKpisResponse = data;
  return (
    <>
      <KPI
        k="ACTIVE CLAIMS"
        big={formatBig(k.activeClaims)}
        sub="this FY"
        trend={formatActiveClaimsTrend(k.deltas.activeClaimsVsLastFy)}
      />
      <KPI
        k="EVIDENCE INDEXED"
        big={formatBig(k.evidenceIndexed)}
        sub="artifacts this FY"
        trend={formatEvidenceTrend(k.deltas.evidenceIndexedPctYoY)}
      />
      <KPI
        k="AT-RISK"
        big={formatBig(k.atRisk)}
        sub="needs your judgement"
        tone="rust"
        trend={formatAtRiskTrend(k.deltas.atRiskVsYesterday)}
      />
      <KPI
        k="CHAIN COVERAGE"
        big={formatBig(k.chainCoveragePct)}
        suffix="%"
        sub={`of ${fy} claims`}
        tone="amber"
        trend={formatCoverageTrend(k.deltas.chainCoveragePtsYoY)}
      />
    </>
  );
}

interface Claim {
  id: string;
  client: string;
  stage: string;
  status: StatusKind;
  value: string;
  evidence: number;
  gap: boolean;
}

const CLAIMS: Claim[] = [
  {
    id: 'VANT-7',
    client: 'Vantage Industries',
    stage: 'STAGE 04 · APPORTION',
    status: 'review',
    value: '$2.42M',
    evidence: 47,
    gap: false,
  },
  {
    id: 'BORE-2',
    client: 'Borealis Bio',
    stage: 'STAGE 03 · ASSEMBLE',
    status: 'drafting',
    value: '$1.18M',
    evidence: 28,
    gap: true,
  },
  {
    id: 'LYRA-1',
    client: 'Lyra Compute',
    stage: 'STAGE 02 · STAMP',
    status: 'drafting',
    value: '$ 840K',
    evidence: 19,
    gap: false,
  },
  {
    id: 'GQHC-1',
    client: 'GQHC Materials',
    stage: 'STAGE 06 · SEAL',
    status: 'sealed',
    value: '$3.16M',
    evidence: 92,
    gap: false,
  },
  {
    id: 'OREN-1',
    client: 'Oren Robotics',
    stage: 'STAGE 04 · APPORTION',
    status: 'flagged',
    value: '$ 610K',
    evidence: 22,
    gap: true,
  },
  {
    id: 'ARI-3',
    client: 'Aristocrat (sub-entity)',
    stage: 'STAGE 06 · SEAL',
    status: 'chain-lock',
    value: '$5.04M',
    evidence: 142,
    gap: false,
  },
];

function ClaimsPanel() {
  return (
    <div
      style={{
        background: ink2,
        border: `1px solid ${ruleStrong}`,
        borderRadius: 4,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '16px 20px',
          borderBottom: `1px solid ${rule}`,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Diamond size={8} />
          <span style={{ fontFamily: fSerif, fontSize: 18, color: bone, fontWeight: 500 }}>
            Active claims
          </span>
          <MonoLabel size={10} color={bone3}>
            · FY26 BOOK
          </MonoLabel>
        </div>
        <div
          style={{
            display: 'flex',
            gap: 8,
            fontFamily: fMono,
            fontSize: 10.5,
            color: bone3,
            letterSpacing: '0.14em',
          }}
        >
          <span style={{ color: bone }}>ALL</span>
          <span>·</span>
          <span>DRAFTING</span>
          <span>·</span>
          <span>REVIEW</span>
          <span>·</span>
          <span>SEALED</span>
        </div>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '90px 1fr 200px 130px 80px 110px',
          padding: '10px 20px',
          borderBottom: `1px solid ${rule}`,
          fontFamily: fMono,
          fontSize: 10,
          color: bone3,
          letterSpacing: '0.16em',
        }}
      >
        <span>ID</span>
        <span>CLIENT</span>
        <span>STAGE</span>
        <span>STATUS</span>
        <span style={{ textAlign: 'right' }}>EVID</span>
        <span style={{ textAlign: 'right' }}>VALUE</span>
      </div>
      {CLAIMS.map((c, i) => (
        <div
          key={c.id}
          style={{
            display: 'grid',
            gridTemplateColumns: '90px 1fr 200px 130px 80px 110px',
            padding: '14px 20px',
            borderBottom: i < CLAIMS.length - 1 ? `1px solid ${rule}` : 'none',
            alignItems: 'center',
            cursor: 'pointer',
            background: i === 0 ? 'rgba(225,162,58,0.04)' : 'transparent',
          }}
        >
          <span
            style={{
              fontFamily: fMono,
              fontSize: 12,
              color: amber,
              letterSpacing: '0.06em',
            }}
          >
            {c.id}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: fSans, fontSize: 14, color: bone, fontWeight: 500 }}>
              {c.client}
            </span>
            {c.gap && (
              <span
                title="Evidence gap"
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: rust,
                  boxShadow: `0 0 8px ${rust}`,
                }}
              />
            )}
          </div>
          <span
            style={{
              fontFamily: fMono,
              fontSize: 11,
              color: bone3,
              letterSpacing: '0.12em',
            }}
          >
            {c.stage}
          </span>
          <span>
            <StatusPill kind={c.status} />
          </span>
          <span
            style={{
              fontFamily: fMono,
              fontSize: 12,
              color: bone2,
              textAlign: 'right',
            }}
          >
            {c.evidence}
          </span>
          <span
            style={{
              fontFamily: fMono,
              fontSize: 13,
              color: bone,
              textAlign: 'right',
              letterSpacing: '0.04em',
            }}
          >
            {c.value}
          </span>
        </div>
      ))}
    </div>
  );
}

function WatchPanel() {
  const { data } = useConsultantSignals({ window: '24h' });
  const signals = data?.signals ?? [];

  return (
    <div
      style={{
        background: ink2,
        border: `1px solid ${ruleStrong}`,
        borderRadius: 4,
      }}
    >
      <div
        style={{
          padding: '14px 18px',
          borderBottom: `1px solid ${rule}`,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Diamond size={7} />
          <span style={{ fontFamily: fSerif, fontSize: 16, color: bone, fontWeight: 500 }}>
            Watch
          </span>
        </div>
        <MonoLabel size={9} color={bone3}>
          {`TODAY · ${signals.length} SIGNAL${signals.length !== 1 ? 'S' : ''}`}
        </MonoLabel>
      </div>
      {signals.length === 0 && (
        <div
          style={{
            padding: '24px 18px',
            fontFamily: fSans,
            fontSize: 13,
            color: bone3,
            textAlign: 'center',
          }}
        >
          Watch is quiet — no new signals in the last 24h
        </div>
      )}
      {signals.map((s, i) => (
        <Link
          key={s.code}
          href={`/consultant/watch?signal=${encodeURIComponent(s.code)}`}
          style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
        >
          <div
            style={{
              padding: '14px 18px',
              borderBottom: i < signals.length - 1 ? `1px solid ${rule}` : 'none',
              background: s.exposure >= 3 ? 'rgba(225,162,58,0.04)' : 'transparent',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                marginBottom: 8,
              }}
            >
              <MonoLabel size={10}>{s.src}</MonoLabel>
              <span
                style={{
                  fontFamily: fMono,
                  fontSize: 9.5,
                  color: bone4,
                  letterSpacing: '0.14em',
                }}
              >
                {s.when}
              </span>
            </div>
            <div
              style={{
                fontFamily: fMono,
                fontSize: 9.5,
                color: bone4,
                letterSpacing: '0.14em',
                marginBottom: 4,
              }}
            >
              {s.tag} · <span style={{ color: bone3 }}>{s.code}</span>
            </div>
            <div style={{ fontFamily: fSans, fontSize: 13.5, color: bone, lineHeight: 1.4 }}>
              {s.title}
            </div>
            {s.exposure > 0 && (
              <div
                style={{
                  marginTop: 10,
                  padding: '4px 8px',
                  border: `1px solid ${s.exposure >= 3 ? amber : ruleStrong}`,
                  background: s.exposure >= 3 ? 'rgba(225,162,58,0.08)' : 'transparent',
                  fontFamily: fMono,
                  fontSize: 10,
                  color: s.exposure >= 3 ? amber : bone2,
                  letterSpacing: '0.12em',
                  display: 'inline-block',
                }}
              >
                {s.exposure} CLAIM{s.exposure > 1 ? 'S' : ''} EXPOSED
              </div>
            )}
          </div>
        </Link>
      ))}
    </div>
  );
}

/**
 * Format an ISO-8601 timestamp as a local HH:MM string for the chain
 * panel's right-aligned "when" column. Returns the raw input on parse
 * failure (defensive — keeps the layout intact rather than rendering
 * "Invalid Date" or "NaN:NaN" if the API ever returns garbage).
 */
function formatChainWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Format the chain head height as a thousands-separated count.
 * Mirrors the mocked "3,247" aesthetic without hardcoding the value.
 */
function formatHeight(h: number): string {
  return h.toLocaleString('en-US');
}

function ChainPanel() {
  const { data, isLoading } = useConsultantRecentChainBlocks({ limit: 4 });
  const blocks = data?.blocks ?? [];
  const height = data?.height ?? 0;

  return (
    <div style={{ background: ink2, border: `1px solid ${ruleStrong}`, borderRadius: 4 }}>
      <div
        style={{
          padding: '14px 18px',
          borderBottom: `1px solid ${rule}`,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Diamond size={7} />
          <span style={{ fontFamily: fSerif, fontSize: 16, color: bone, fontWeight: 500 }}>
            Recent chain blocks
          </span>
        </div>
        <MonoLabel size={9} color={bone3}>
          HEIGHT · {formatHeight(height)}
        </MonoLabel>
      </div>
      {isLoading && (
        <div
          style={{
            padding: '24px 18px',
            textAlign: 'center',
            fontFamily: fMono,
            fontSize: 11,
            color: bone3,
            letterSpacing: '0.14em',
          }}
        >
          Loading…
        </div>
      )}
      {!isLoading && blocks.length === 0 && (
        <div
          style={{
            padding: '24px 18px',
            textAlign: 'center',
            fontFamily: fSans,
            fontSize: 13,
            color: bone3,
          }}
        >
          Chain quiet — no blocks today
        </div>
      )}
      {!isLoading &&
        blocks.map((b, i) => (
          <Link
            key={b.id + b.when}
            href={`/consultant/chain?block=${encodeURIComponent(b.id)}`}
            style={{
              display: 'grid',
              gridTemplateColumns: '110px 1fr 70px',
              padding: '12px 18px',
              alignItems: 'center',
              gap: 12,
              borderBottom: i < blocks.length - 1 ? `1px solid ${rule}` : 'none',
              textDecoration: 'none',
              color: 'inherit',
              cursor: 'pointer',
            }}
          >
            <span
              style={{
                fontFamily: fMono,
                fontSize: 11.5,
                color: amber,
                letterSpacing: '0.08em',
              }}
            >
              #{b.id}
            </span>
            <div>
              <div
                style={{
                  fontFamily: fMono,
                  fontSize: 10,
                  color: bone3,
                  letterSpacing: '0.16em',
                }}
              >
                {b.kind}
              </div>
              <div
                style={{
                  fontFamily: fMono,
                  fontSize: 10.5,
                  color: bone,
                  letterSpacing: '0.04em',
                  marginTop: 2,
                }}
              >
                {b.claim}
              </div>
            </div>
            <span
              style={{
                fontFamily: fMono,
                fontSize: 10.5,
                color: bone3,
                textAlign: 'right',
              }}
            >
              {formatChainWhen(b.when)}
            </span>
          </Link>
        ))}
    </div>
  );
}
