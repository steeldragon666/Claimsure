'use client';

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
  ink,
  ink2,
  rule,
  ruleStrong,
} from './tokens';
import { Diamond } from './atoms';

export interface ConsultantUser {
  name: string;
  initials: string;
  firm: string;
}

export function TopBar({ user }: { user: ConsultantUser }) {
  // 200ms tick — matches the design's live-feeling timestamp without
  // burning a render every frame.
  const [t, setT] = useState<Date | null>(null);
  useEffect(() => {
    setT(new Date());
    const id = setInterval(() => setT(new Date()), 200);
    return () => clearInterval(id);
  }, []);

  const hh = String(t?.getHours() ?? 0).padStart(2, '0');
  const mm = String(t?.getMinutes() ?? 0).padStart(2, '0');
  const ss = String(t?.getSeconds() ?? 0).padStart(2, '0');

  return (
    <div
      style={{
        height: 56,
        display: 'flex',
        alignItems: 'center',
        borderBottom: `1px solid ${rule}`,
        background: ink,
        padding: '0 20px',
        gap: 20,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, width: 220 }}>
        <Diamond size={10} style={{ boxShadow: '0 0 12px rgba(225,162,58,0.5)' }} />
        <span
          style={{
            fontFamily: fSerif,
            fontWeight: 600,
            fontSize: 18,
            color: bone,
            letterSpacing: '-0.01em',
          }}
        >
          ClaimSure
        </span>
      </div>

      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 14 }}>
        <div
          style={{
            flex: 1,
            maxWidth: 540,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '8px 14px',
            background: ink2,
            border: `1px solid ${ruleStrong}`,
            borderRadius: 4,
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            stroke={bone3}
            strokeWidth="1.4"
          >
            <circle cx="6" cy="6" r="5" />
            <line x1="10" y1="10" x2="13" y2="13" />
          </svg>
          <span style={{ fontFamily: fSans, fontSize: 13, color: bone4 }}>
            Search claims, evidence, blocks…
          </span>
          <span
            style={{
              marginLeft: 'auto',
              fontFamily: fMono,
              fontSize: 10,
              color: bone4,
              letterSpacing: '0.16em',
            }}
          >
            ⌘K
          </span>
        </div>
      </div>

      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 10,
          padding: '6px 12px',
          border: `1px solid ${ruleStrong}`,
          borderRadius: 999,
          color: bone2,
          fontFamily: fMono,
          fontSize: 10.5,
          letterSpacing: '0.08em',
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: amber,
            boxShadow: '0 0 0 3px rgba(225,162,58,0.18)',
          }}
        />
        <span suppressHydrationWarning>
          LIVE · {hh}:{mm}:{ss} AEST
        </span>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '6px 10px 6px 12px',
          borderRadius: 4,
        }}
      >
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: '50%',
            background: 'linear-gradient(135deg, #c46a48, #e1a23a)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: fMono,
            fontSize: 12,
            color: ink,
            fontWeight: 600,
            letterSpacing: '0.05em',
          }}
        >
          {user.initials}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontFamily: fSans, fontSize: 12.5, color: bone, fontWeight: 500 }}>
            {user.name}
          </span>
          <span
            style={{
              fontFamily: fMono,
              fontSize: 9.5,
              color: bone3,
              letterSpacing: '0.14em',
            }}
          >
            {user.firm}
          </span>
        </div>
      </div>
    </div>
  );
}
