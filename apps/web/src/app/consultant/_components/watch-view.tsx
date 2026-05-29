'use client';

/**
 * Watch — realtime regulatory news, announcements, facts, processing status
 * and insights for the consultant workspace.
 *
 * Reproduces the standalone /intelligence experience inside the System A
 * (dark/amber broadcast) theme. All data comes from existing read-only
 * endpoints (no new API surface):
 *   - /v1/insights              → "top facts" insight strip
 *   - /v1/intelligence/sources  → scrape pipeline / processing status
 *   - /v1/intelligence/events   → recent news + per-item facts
 *
 * Each section polls (45-60s) so the page feels realtime without SSE.
 */

import { useEffect, useState } from 'react';
import {
  amber,
  bone,
  bone2,
  bone3,
  bone4,
  fMono,
  fSans,
  fSerif,
  ink2,
  ink3,
  rule,
  ruleStrong,
  rust,
  sage,
} from './tokens';
import { MonoLabel } from './atoms';
import {
  useIntelligenceEvents,
  useIntelligenceSources,
  useWatchInsights,
  type RegulatoryEvent,
  type RegulatorySource,
} from '@/lib/hooks/use-intelligence';

const PAGE_SIZE = 25;

const SEVERITY_OPTIONS = ['all', 'high', 'medium', 'low', 'informational'] as const;

const SEVERITY_COLOR: Record<string, string> = {
  high: rust,
  medium: amber,
  low: sage,
  informational: bone3,
};
const SEVERITY_LABEL: Record<string, string> = {
  high: 'HIGH',
  medium: 'MED',
  low: 'LOW',
  informational: 'INFO',
};

const KIND_OPTIONS = [
  'all',
  'tax_alert',
  'pcg',
  'public_ruling',
  'disr_program_change',
  'form_change',
  'aat_decision',
  'art_decision',
  'isa_finding',
  'industry_guidance',
  'asx_disclosure',
  'other',
] as const;
const KIND_LABEL: Record<string, string> = {
  tax_alert: 'TAX ALERT',
  pcg: 'PCG',
  public_ruling: 'PUBLIC RULING',
  disr_program_change: 'PROGRAM CHANGE',
  form_change: 'FORM CHANGE',
  aat_decision: 'AAT DECISION',
  art_decision: 'ART DECISION',
  isa_finding: 'ISA FINDING',
  industry_guidance: 'GUIDANCE',
  asx_disclosure: 'ASX DISCLOSURE',
  other: 'UPDATE',
};

/** Source poll-status → System A status colour. */
function sourceColor(s: RegulatorySource): string {
  if (!s.enabled) return bone4;
  if (s.stale) return amber;
  switch (s.last_polled_status) {
    case 'success':
      return sage;
    case 'rate_limited':
      return amber;
    case 'parse_error':
    case 'network_error':
      return rust;
    default:
      return bone3;
  }
}

function timeAEST(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-AU', {
      timeZone: 'Australia/Sydney',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return '—';
  }
}

export function WatchView() {
  return (
    <div style={{ padding: 28, height: '100%', overflow: 'auto' }}>
      <div style={{ marginBottom: 24 }}>
        <MonoLabel size={10} color={bone3}>
          WATCH · REGULATORY INTELLIGENCE
        </MonoLabel>
        <h1
          style={{
            fontFamily: fSerif,
            fontWeight: 300,
            fontSize: 40,
            lineHeight: 1.05,
            letterSpacing: '-0.025em',
            color: bone,
            margin: '10px 0 0',
          }}
        >
          Realtime news &amp; <em style={{ color: amber, fontStyle: 'italic' }}>insights</em> from
          ATO, AusIndustry, AAT &amp; the courts.
        </h1>
      </div>

      <InsightsStrip />
      <ProcessingPanel />
      <NewsFeed />
    </div>
  );
}

/* ---------------------------------------------------------------- Insights */

function InsightsStrip() {
  const { data, isPending } = useWatchInsights('watch');
  const insights = data?.insights ?? [];
  const [featured, setFeatured] = useState(0);

  // Rotate the featured insight every 12s — the "revolving feed" feel.
  useEffect(() => {
    if (insights.length === 0) return;
    const id = setInterval(() => setFeatured((i) => (i + 1) % insights.length), 12_000);
    return () => clearInterval(id);
  }, [insights.length]);

  if (isPending) {
    return (
      <PanelShell label="TOP FACTS">
        <span style={{ fontFamily: fMono, fontSize: 11, color: bone3 }}>Generating insights…</span>
      </PanelShell>
    );
  }
  if (insights.length === 0) return null;

  const f = insights[featured] ?? insights[0]!;
  const status = data?.generative_status ?? 'disabled';
  const budget = data?.budget ?? null;

  return (
    <div
      style={{
        background: ink2,
        border: `1px solid ${ruleStrong}`,
        borderRadius: 4,
        marginBottom: 20,
        overflow: 'hidden',
      }}
    >
      <div style={{ padding: '16px 20px', borderBottom: `1px solid ${rule}` }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <MonoLabel size={10} color={bone3}>
            TOP FACTS · INSIGHTS
          </MonoLabel>
          <span style={{ fontFamily: fMono, fontSize: 9.5, color: bone4, letterSpacing: '0.12em' }}>
            {budget
              ? `${budget.status === 'over_quota' ? 'BILLABLE' : 'FREE TIER'} · A$${(
                  budget.used_aud_cents / 100
                ).toFixed(2)} / A$${(budget.budget_aud_cents / 100).toFixed(0)}`
              : status.toUpperCase().replace('_', ' ')}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginTop: 12 }}>
          <span style={{ fontSize: 22, lineHeight: 1 }} aria-hidden>
            {f.icon}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontFamily: fSerif,
                fontSize: 18,
                color: bone,
                letterSpacing: '-0.01em',
                lineHeight: 1.2,
              }}
            >
              {f.headline}
            </div>
            <p
              style={{
                margin: '6px 0 0',
                fontFamily: fSans,
                fontSize: 12.5,
                color: bone2,
                lineHeight: 1.55,
              }}
            >
              {f.detail}
            </p>
            <div
              style={{
                marginTop: 8,
                fontFamily: fMono,
                fontSize: 9,
                color: bone4,
                letterSpacing: '0.12em',
              }}
            >
              {f.category.toUpperCase()} · {f.source}
            </div>
          </div>
        </div>
      </div>

      {/* Chip rail — click to feature */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 0 }}>
        {insights.map((ins, i) => (
          <button
            key={ins.id}
            type="button"
            onClick={() => setFeatured(i)}
            style={{
              flex: '1 1 0',
              minWidth: 0,
              textAlign: 'left',
              padding: '10px 14px',
              background: i === featured ? 'rgba(225,162,58,0.07)' : 'transparent',
              border: 'none',
              borderRight: i < insights.length - 1 ? `1px solid ${rule}` : 'none',
              cursor: 'pointer',
              display: 'flex',
              gap: 8,
              alignItems: 'flex-start',
            }}
          >
            <span style={{ fontSize: 13 }} aria-hidden>
              {ins.icon}
            </span>
            <span
              style={{
                fontFamily: fSans,
                fontSize: 11,
                color: i === featured ? bone : bone3,
                lineHeight: 1.3,
                overflow: 'hidden',
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
              }}
            >
              {ins.headline}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- Processing */

function ProcessingPanel() {
  const { data, isPending } = useIntelligenceSources();
  const sources = data?.sources ?? [];
  const enabled = sources.filter((s) => s.enabled);
  const stale = enabled.filter((s) => s.stale);
  const lastScan =
    sources
      .map((s) => s.last_polled_at)
      .filter((x): x is string => x != null)
      .sort()
      .at(-1) ?? null;

  return (
    <PanelShell
      label="PIPELINE · PROCESSING"
      right={isPending ? 'POLLING…' : `${enabled.length} SOURCES · LAST SCAN ${timeAEST(lastScan)}`}
    >
      {!isPending && sources.length === 0 && (
        <span style={{ fontFamily: fMono, fontSize: 11, color: bone3 }}>
          No regulatory sources configured yet.
        </span>
      )}

      {stale.length > 0 && (
        <div
          style={{
            marginBottom: 12,
            padding: '8px 12px',
            border: `1px solid ${amber}`,
            background: 'rgba(225,162,58,0.08)',
            borderRadius: 3,
            fontFamily: fMono,
            fontSize: 10.5,
            color: amber,
            letterSpacing: '0.04em',
          }}
        >
          {stale.length} SOURCE{stale.length > 1 ? 'S' : ''} STALE (&gt;7d) —{' '}
          {stale.map((s) => s.source_name).join(', ')}. DAILY SCRAPE MAY BE FAILING.
        </div>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: 8,
        }}
      >
        {sources.map((s) => (
          <div
            key={s.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 12px',
              background: ink3,
              border: `1px solid ${rule}`,
              borderRadius: 3,
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: sourceColor(s),
                boxShadow: `0 0 0 3px ${sourceColor(s)}22`,
                flexShrink: 0,
              }}
            />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{
                  fontFamily: fSans,
                  fontSize: 12,
                  color: s.enabled ? bone : bone4,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {s.source_name}
              </div>
              <div
                style={{ fontFamily: fMono, fontSize: 9, color: bone4, letterSpacing: '0.08em' }}
              >
                {s.enabled
                  ? `${(s.last_polled_status ?? 'never').toUpperCase()} · ${timeAEST(s.last_polled_at)}`
                  : 'DISABLED'}
              </div>
            </div>
          </div>
        ))}
      </div>
    </PanelShell>
  );
}

/* --------------------------------------------------------------- News feed */

function NewsFeed() {
  const [severity, setSeverity] = useState<string>('all');
  const [kind, setKind] = useState<string>('all');
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data, isPending } = useIntelligenceEvents({
    severity,
    kind,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });
  const events = data?.events ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <PanelShell
      label="RECENT NEWS & ANNOUNCEMENTS"
      right={isPending ? 'SCANNING…' : `${total} IN VIEW`}
    >
      {/* Filter bar */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 14 }}>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          {SEVERITY_OPTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setSeverity(s);
                setPage(0);
              }}
              style={{
                padding: '4px 10px',
                fontFamily: fMono,
                fontSize: 9.5,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                cursor: 'pointer',
                borderRadius: 3,
                border: `1px solid ${severity === s ? amber : ruleStrong}`,
                background: severity === s ? 'rgba(225,162,58,0.12)' : 'transparent',
                color: severity === s ? amber : bone3,
              }}
            >
              {s === 'all' ? 'ALL' : (SEVERITY_LABEL[s] ?? s)}
            </button>
          ))}
        </div>
        <select
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setPage(0);
          }}
          style={{
            height: 26,
            padding: '0 8px',
            fontFamily: fMono,
            fontSize: 10,
            letterSpacing: '0.06em',
            background: ink3,
            color: bone2,
            border: `1px solid ${ruleStrong}`,
            borderRadius: 3,
          }}
        >
          {KIND_OPTIONS.map((k) => (
            <option key={k} value={k} style={{ background: ink3 }}>
              {k === 'all' ? 'ALL KINDS' : (KIND_LABEL[k] ?? k)}
            </option>
          ))}
        </select>
      </div>

      {isPending ? (
        <span style={{ fontFamily: fMono, fontSize: 11, color: bone3 }}>Loading events…</span>
      ) : events.length === 0 ? (
        <span style={{ fontFamily: fMono, fontSize: 11, color: bone3 }}>
          No regulatory events match — the watch is quiet, or the scrape hasn&apos;t run yet.
        </span>
      ) : (
        <div style={{ border: `1px solid ${rule}`, borderRadius: 4, overflow: 'hidden' }}>
          {events.map((evt, i) => (
            <NewsRow
              key={evt.id}
              evt={evt}
              first={i === 0}
              open={expanded === evt.id}
              onToggle={() => setExpanded(expanded === evt.id ? null : evt.id)}
            />
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div
          style={{
            marginTop: 14,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span style={{ fontFamily: fMono, fontSize: 10, color: bone4, letterSpacing: '0.08em' }}>
            PAGE {page + 1} / {totalPages}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <PagerButton disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              PREV
            </PagerButton>
            <PagerButton disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>
              NEXT
            </PagerButton>
          </div>
        </div>
      )}
    </PanelShell>
  );
}

function NewsRow({
  evt,
  first,
  open,
  onToggle,
}: {
  evt: RegulatoryEvent;
  first: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const sevColor = evt.classification_severity
    ? (SEVERITY_COLOR[evt.classification_severity] ?? bone3)
    : bone4;
  return (
    <div style={{ borderTop: first ? 'none' : `1px solid ${rule}` }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          width: '100%',
          textAlign: 'left',
          display: 'grid',
          gridTemplateColumns: '92px 1fr 130px 96px',
          alignItems: 'center',
          gap: 12,
          padding: '14px 18px',
          background: open ? 'rgba(225,162,58,0.04)' : 'transparent',
          border: 'none',
          cursor: 'pointer',
        }}
      >
        <span style={{ fontFamily: fMono, fontSize: 10.5, color: bone3, letterSpacing: '0.06em' }}>
          {timeAEST(evt.published_at)}
        </span>
        <span
          style={{
            fontFamily: fSerif,
            fontSize: 16,
            color: bone,
            letterSpacing: '-0.005em',
            lineHeight: 1.25,
          }}
        >
          {evt.raw_title}
        </span>
        <span style={{ fontFamily: fMono, fontSize: 10, color: bone3, letterSpacing: '0.08em' }}>
          {evt.classification_kind
            ? (KIND_LABEL[evt.classification_kind] ?? evt.classification_kind.toUpperCase())
            : evt.source_name}
        </span>
        <span style={{ display: 'flex', justifyContent: 'flex-end' }}>
          {evt.classification_severity ? (
            <span
              style={{
                padding: '3px 9px',
                border: `1px solid ${sevColor}`,
                color: sevColor,
                fontFamily: fMono,
                fontSize: 9.5,
                letterSpacing: '0.1em',
                borderRadius: 3,
              }}
            >
              {SEVERITY_LABEL[evt.classification_severity] ?? evt.classification_severity}
            </span>
          ) : (
            <span style={{ fontFamily: fMono, fontSize: 9.5, color: bone4 }}>UNCLASSIFIED</span>
          )}
        </span>
      </button>

      {open && (
        <div
          style={{
            padding: '0 18px 18px',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div style={{ fontFamily: fMono, fontSize: 9.5, color: bone4, letterSpacing: '0.08em' }}>
            {evt.source_name}
            {evt.classified_at
              ? ` · CLASSIFIED ${timeAEST(evt.classified_at)}`
              : ' · NOT YET CLASSIFIED'}
          </div>
          <p
            style={{
              margin: 0,
              fontFamily: fSans,
              fontSize: 13,
              color: bone2,
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
            }}
          >
            {evt.raw_content.length > 1200 ? `${evt.raw_content.slice(0, 1200)}…` : evt.raw_content}
          </p>
          {evt.source_url && (
            <a
              href={evt.source_url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                fontFamily: fMono,
                fontSize: 10.5,
                color: amber,
                letterSpacing: '0.08em',
                textDecoration: 'none',
              }}
            >
              VIEW SOURCE ↗
            </a>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ shared */

function PanelShell({
  label,
  right,
  children,
}: {
  label: string;
  right?: string;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginBottom: 20 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 10,
        }}
      >
        <MonoLabel size={10} color={bone3}>
          {label}
        </MonoLabel>
        {right && (
          <span style={{ fontFamily: fMono, fontSize: 9.5, color: bone4, letterSpacing: '0.12em' }}>
            {right}
          </span>
        )}
      </div>
      <div
        style={{
          background: ink2,
          border: `1px solid ${ruleStrong}`,
          borderRadius: 4,
          padding: 18,
        }}
      >
        {children}
      </div>
    </section>
  );
}

function PagerButton({
  disabled,
  onClick,
  children,
}: {
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        padding: '5px 12px',
        fontFamily: fMono,
        fontSize: 9.5,
        letterSpacing: '0.1em',
        border: `1px solid ${ruleStrong}`,
        background: 'transparent',
        color: disabled ? bone4 : bone2,
        borderRadius: 3,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}
