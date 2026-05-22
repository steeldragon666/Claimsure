'use client';

import { useState } from 'react';
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
  rule,
  ruleStrong,
} from './tokens';
import { Check, Diamond, MonoLabel, StatusPill } from './atoms';

interface WizardStep {
  k: string;
  q: string;
  done: boolean;
  active?: boolean;
}

const STEPS: WizardStep[] = [
  { k: 'PROFILE', q: 'What does the business do?', done: true },
  { k: 'HYPOTHESES', q: 'What did you set out to learn?', done: true },
  { k: 'ACTIVITIES', q: 'Which work is Core? Which is Supporting?', done: true },
  {
    k: 'APPORTIONMENT',
    q: 'How does the ledger map to the activities?',
    done: false,
    active: true,
  },
  { k: 'EVIDENCE', q: 'Where did the work happen, and what proves it?', done: false },
  { k: 'REVIEW', q: 'Anything to flag before sign-off?', done: false },
];

export function WizardView() {
  const [step, setStep] = useState(3);

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 28 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-end',
          marginBottom: 22,
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <MonoLabel size={10} color={amber}>
              VANT-7 · FY26
            </MonoLabel>
            <span style={{ width: 24, height: 1, background: ruleStrong }} />
            <MonoLabel size={10} color={bone3}>
              VANTAGE INDUSTRIES
            </MonoLabel>
            <StatusPill kind="review" />
          </div>
          <h1
            style={{
              fontFamily: fSerif,
              fontWeight: 300,
              fontSize: 38,
              lineHeight: 1,
              letterSpacing: '-0.025em',
              color: bone,
              margin: '14px 0 0',
            }}
          >
            Hi-temp alloy phase-stability program
          </h1>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            style={{
              padding: '9px 14px',
              background: 'transparent',
              color: bone2,
              border: `1px solid ${ruleStrong}`,
              borderRadius: 3,
              cursor: 'pointer',
              fontFamily: fMono,
              fontSize: 11,
              letterSpacing: '0.16em',
            }}
          >
            Export draft
          </button>
          <button
            style={{
              padding: '9px 14px',
              background: amber,
              color: ink,
              border: 'none',
              borderRadius: 3,
              fontFamily: fMono,
              fontSize: 11,
              letterSpacing: '0.16em',
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            Sign &amp; seal
          </button>
        </div>
      </div>

      {/* Step rail */}
      <div
        style={{
          background: ink2,
          border: `1px solid ${ruleStrong}`,
          borderRadius: 4,
          padding: '18px 22px',
          marginBottom: 18,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
          <MonoLabel size={10} color={bone3}>
            WIZARD · STEP {String(step + 1).padStart(2, '0')} / 06
          </MonoLabel>
          <MonoLabel size={10} color={bone3}>
            {STEPS.filter((s) => s.done).length} OF 6 COMPLETE
          </MonoLabel>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {STEPS.map((s, i) => (
            <div
              key={s.k}
              style={{
                flex: 1,
                height: 3,
                borderRadius: 2,
                background: s.done ? amber : i === step ? amberSoft : rule,
              }}
            />
          ))}
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(6, 1fr)',
            marginTop: 12,
            gap: 12,
          }}
        >
          {STEPS.map((s, i) => (
            <button
              key={s.k}
              onClick={() => setStep(i)}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
                textAlign: 'left',
              }}
            >
              <div
                style={{
                  fontFamily: fMono,
                  fontSize: 10,
                  letterSpacing: '0.16em',
                  color: i === step ? amber : s.done ? bone2 : bone4,
                }}
              >
                {String(i + 1).padStart(2, '0')} · {s.k}
              </div>
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 14 }}>
        <ApportionmentStep />
        <EvidenceStreamPanel />
      </div>
    </div>
  );
}

interface LedgerLine {
  date: string;
  vendor: string;
  amt: string;
  cat: string;
  assigned: string | null;
  suggestion?: string;
}

const LEDGER: LedgerLine[] = [
  {
    date: '14 OCT',
    vendor: 'PAYROLL · CORE TEAM',
    amt: '$48,200',
    cat: 'WAGES',
    assigned: 'CORE · Vantage-7',
  },
  {
    date: '22 OCT',
    vendor: 'BLUESCOPE LABS',
    amt: '$11,750',
    cat: 'CONTRACTOR',
    assigned: 'SUPPORT · External lab',
  },
  {
    date: '03 NOV',
    vendor: 'CSIRO · TEST SUITE',
    amt: '$ 6,400',
    cat: 'CONTRACTOR',
    assigned: 'SUPPORT · External lab',
  },
  {
    date: '12 NOV',
    vendor: 'PAYROLL · CORE TEAM',
    amt: '$48,200',
    cat: 'WAGES',
    assigned: 'CORE · Vantage-7',
  },
  {
    date: '28 NOV',
    vendor: 'AGILENT · METROLOGY',
    amt: '$ 9,150',
    cat: 'OVERHEAD',
    assigned: 'SUPPORT · Compute',
  },
  {
    date: '04 DEC',
    vendor: 'PAYROLL · CORE TEAM',
    amt: '$48,200',
    cat: 'WAGES',
    assigned: null,
    suggestion: 'CORE · Vantage-7',
  },
  {
    date: '15 DEC',
    vendor: 'AWS · COMPUTE',
    amt: '$ 4,820',
    cat: 'OVERHEAD',
    assigned: 'SUPPORT · Compute',
  },
];

const ROLLUPS: Array<[string, string, number]> = [
  ['CORE · Vantage-7 synthesis', '$144,600', 60],
  ['SUPPORT · External lab work', '$ 18,150', 24],
  ['SUPPORT · Compute & metrology', '$ 13,970', 16],
];

function ApportionmentStep() {
  return (
    <div style={{ background: ink2, border: `1px solid ${ruleStrong}`, borderRadius: 4 }}>
      <div style={{ padding: '18px 22px', borderBottom: `1px solid ${rule}` }}>
        <MonoLabel size={11}>STEP 04 · APPORTIONMENT</MonoLabel>
        <div
          style={{
            fontFamily: fSerif,
            fontWeight: 400,
            fontSize: 24,
            lineHeight: 1.25,
            letterSpacing: '-0.01em',
            color: bone,
            margin: '10px 0 0',
          }}
        >
          How does the ledger map to the activities?
        </div>
        <div style={{ fontFamily: fSans, fontSize: 13.5, color: bone3, marginTop: 8 }}>
          ClaimSure has matched 6 of 7 lines automatically. Review and confirm the last one.
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '70px 1fr 100px 220px',
          padding: '10px 20px',
          borderBottom: `1px solid ${rule}`,
          gap: 20,
          fontFamily: fMono,
          fontSize: 10,
          color: bone3,
          letterSpacing: '0.16em',
        }}
      >
        <span>DATE</span>
        <span>VENDOR</span>
        <span style={{ textAlign: 'right' }}>AMOUNT</span>
        <span>ACTIVITY</span>
      </div>

      {LEDGER.map((l, i) => (
        <div
          key={`${l.date}-${l.vendor}`}
          style={{
            display: 'grid',
            gridTemplateColumns: '70px 1fr 100px 220px',
            padding: '12px 20px',
            alignItems: 'center',
            gap: 20,
            borderBottom: i < LEDGER.length - 1 ? `1px solid ${rule}` : 'none',
            background: l.suggestion ? 'rgba(225,162,58,0.05)' : 'transparent',
          }}
        >
          <span
            style={{
              fontFamily: fMono,
              fontSize: 11,
              color: bone3,
              letterSpacing: '0.06em',
            }}
          >
            {l.date}
          </span>
          <span style={{ fontFamily: fSans, fontSize: 13, color: bone }}>{l.vendor}</span>
          <span
            style={{
              fontFamily: fMono,
              fontSize: 12,
              color: amber,
              textAlign: 'right',
            }}
          >
            {l.amt}
          </span>
          {l.suggestion ? (
            <div
              style={{
                padding: '5px 10px',
                border: `1px dashed ${amber}`,
                borderRadius: 3,
                fontFamily: fMono,
                fontSize: 10,
                color: amber,
                letterSpacing: '0.1em',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                justifyContent: 'space-between',
              }}
            >
              <span>SUGGEST: {l.suggestion}</span>
              <Check size={12} />
            </div>
          ) : (
            <span
              style={{
                fontFamily: fMono,
                fontSize: 10.5,
                color: bone2,
                letterSpacing: '0.1em',
              }}
            >
              {l.assigned}
            </span>
          )}
        </div>
      ))}

      <div
        style={{
          padding: '18px 22px',
          borderTop: `1px solid ${ruleStrong}`,
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 16,
        }}
      >
        {ROLLUPS.map(([k, v, pct]) => (
          <div key={k}>
            <div
              style={{
                fontFamily: fMono,
                fontSize: 10,
                color: amber,
                letterSpacing: '0.14em',
              }}
            >
              {k}
            </div>
            <div
              style={{
                fontFamily: fSerif,
                fontSize: 26,
                color: bone,
                marginTop: 6,
                letterSpacing: '-0.02em',
                fontWeight: 300,
              }}
            >
              {v}
            </div>
            <div
              style={{
                marginTop: 8,
                height: 3,
                background: rule,
                borderRadius: 2,
                overflow: 'hidden',
              }}
            >
              <div style={{ width: `${pct}%`, height: '100%', background: amber }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface EvidenceItem {
  kind: string;
  name: string;
  when: string;
  block: string;
  size: string;
}

const EVIDENCE: EvidenceItem[] = [
  {
    kind: 'PHOTO',
    name: 'whiteboard_n7.jpg',
    when: '14:23:07',
    block: '#00184_2A',
    size: '4.2 MB',
  },
  {
    kind: 'VOICE',
    name: 'standup_0:34.m4a',
    when: '14:25:21',
    block: '#00184_2B',
    size: '518 KB',
  },
  {
    kind: 'LAB BOOK',
    name: 'lab_book_p47.jpg',
    when: '14:31:09',
    block: '#00184_2C',
    size: '3.1 MB',
  },
  {
    kind: 'CALC',
    name: 'calc_n7.png',
    when: '14:38:44',
    block: '#00184_2D',
    size: '208 KB',
  },
  {
    kind: 'PHOTO',
    name: 'plate_post_cycle.jpg',
    when: '15:14:02',
    block: '#00184_2E',
    size: '5.8 MB',
  },
];

function EvidenceStreamPanel() {
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
            Evidence stream
          </span>
        </div>
        <MonoLabel size={9} color={bone3}>
          47 ARTIFACTS
        </MonoLabel>
      </div>
      {EVIDENCE.map((it, i) => (
        <div
          key={it.block}
          style={{
            padding: '12px 18px',
            borderBottom: i < EVIDENCE.length - 1 ? `1px solid ${rule}` : 'none',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              marginBottom: 4,
            }}
          >
            <Diamond size={5} />
            <MonoLabel size={9} color={amber}>
              {it.kind}
            </MonoLabel>
            <span
              style={{
                marginLeft: 'auto',
                fontFamily: fMono,
                fontSize: 9,
                color: bone4,
                letterSpacing: '0.14em',
              }}
            >
              {it.when}
            </span>
          </div>
          <div
            style={{
              fontFamily: fMono,
              fontSize: 11.5,
              color: bone,
              marginLeft: 13,
            }}
          >
            {it.name}
          </div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              marginLeft: 13,
              marginTop: 4,
            }}
          >
            <span
              style={{
                fontFamily: fMono,
                fontSize: 9.5,
                color: amber,
                letterSpacing: '0.06em',
              }}
            >
              {it.block}
            </span>
            <span style={{ fontFamily: fMono, fontSize: 9.5, color: bone4 }}>{it.size}</span>
          </div>
        </div>
      ))}
      <div
        style={{
          padding: '12px 18px',
          borderTop: `1px solid ${rule}`,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          justifyContent: 'center',
          fontFamily: fMono,
          fontSize: 10,
          color: amber,
          letterSpacing: '0.18em',
          cursor: 'pointer',
        }}
      >
        + REQUEST EVIDENCE FROM CLAIMANT
      </div>
    </div>
  );
}
