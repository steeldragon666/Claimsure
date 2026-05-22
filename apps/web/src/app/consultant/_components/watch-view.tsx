'use client';

import { amber, bone, bone2, bone3, bone4, fMono, fSerif, ink2, rule, ruleStrong } from './tokens';
import { MonoLabel } from './atoms';

interface WatchSignal {
  src: string;
  tag: string;
  code: string;
  title: string;
  exposure: number;
  when: string;
}

const SIGNALS: WatchSignal[] = [
  {
    src: 'ATO',
    tag: 'TAXPAYER ALERT',
    code: 'TA 2026/03',
    title: 'Software development eligibility — new evidence standard',
    exposure: 3,
    when: '14:01 AEST',
  },
  {
    src: 'AUSINDUSTRY',
    tag: 'GUIDANCE',
    code: 'GN 26-04',
    title: 'Updated guidance — supporting activities determination',
    exposure: 1,
    when: '09:42 AEST',
  },
  {
    src: 'AAT',
    tag: 'DECISION',
    code: '[2026] AATA 412',
    title: 'Body by Michael — duty-of-care doctrine extended',
    exposure: 2,
    when: '08:15 AEST',
  },
  {
    src: 'FCA',
    tag: 'JUDGMENT',
    code: '[2026] FCA 287',
    title: 'GQHC v. Innovation — apportionment standard',
    exposure: 0,
    when: '07:50 AEST',
  },
  {
    src: 'AUSINDUSTRY',
    tag: 'ANNOUNCEMENT',
    code: '—',
    title: 'Examination targeting — biotech & clean energy uplift',
    exposure: 5,
    when: '06:30 AEST',
  },
];

export function WatchView() {
  return (
    <div style={{ padding: 28, height: '100%', overflow: 'auto' }}>
      <div style={{ marginBottom: 28 }}>
        <MonoLabel size={10} color={bone3}>
          WATCH · DAILY SIGNAL SCAN
        </MonoLabel>
        <h1
          style={{
            fontFamily: fSerif,
            fontWeight: 300,
            fontSize: 44,
            lineHeight: 1,
            letterSpacing: '-0.025em',
            color: bone,
            margin: '10px 0 0',
          }}
        >
          Three signals ranked by <em style={{ color: amber, fontStyle: 'italic' }}>your</em>{' '}
          exposure.
        </h1>
      </div>

      <div style={{ background: ink2, border: `1px solid ${ruleStrong}`, borderRadius: 4 }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '110px 170px 1fr 130px 110px',
            padding: '12px 22px',
            borderBottom: `1px solid ${ruleStrong}`,
            fontFamily: fMono,
            fontSize: 10,
            color: bone3,
            letterSpacing: '0.18em',
          }}
        >
          <span>SOURCE</span>
          <span>REFERENCE</span>
          <span>HEADLINE</span>
          <span>EXPOSURE</span>
          <span>INGESTED</span>
        </div>
        {SIGNALS.map((s, i) => (
          <div
            key={s.code + s.when}
            style={{
              display: 'grid',
              gridTemplateColumns: '110px 170px 1fr 130px 110px',
              padding: '18px 22px',
              alignItems: 'center',
              gap: 14,
              borderBottom: i < SIGNALS.length - 1 ? `1px solid ${rule}` : 'none',
              background: s.exposure >= 3 ? 'rgba(225,162,58,0.04)' : 'transparent',
            }}
          >
            <MonoLabel size={12}>{s.src}</MonoLabel>
            <div>
              <div
                style={{
                  fontFamily: fMono,
                  fontSize: 9.5,
                  color: bone4,
                  letterSpacing: '0.14em',
                }}
              >
                {s.tag}
              </div>
              <div
                style={{
                  fontFamily: fMono,
                  fontSize: 11.5,
                  color: bone2,
                  marginTop: 3,
                }}
              >
                {s.code}
              </div>
            </div>
            <span
              style={{
                fontFamily: fSerif,
                fontSize: 20,
                color: bone,
                letterSpacing: '-0.005em',
              }}
            >
              {s.title}
            </span>
            <div>
              {s.exposure > 0 ? (
                <span
                  style={{
                    padding: '4px 10px',
                    border: `1px solid ${s.exposure >= 3 ? amber : ruleStrong}`,
                    background: s.exposure >= 3 ? 'rgba(225,162,58,0.1)' : 'transparent',
                    fontFamily: fMono,
                    fontSize: 10.5,
                    color: s.exposure >= 3 ? amber : bone2,
                    letterSpacing: '0.1em',
                  }}
                >
                  {s.exposure} CLAIM{s.exposure > 1 ? 'S' : ''}
                </span>
              ) : (
                <span style={{ fontFamily: fMono, fontSize: 11, color: bone4 }}>—</span>
              )}
            </div>
            <span
              style={{
                fontFamily: fMono,
                fontSize: 11,
                color: bone3,
                letterSpacing: '0.08em',
              }}
            >
              {s.when}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
