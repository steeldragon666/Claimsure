'use client';

import {
  amber,
  bone,
  bone2,
  bone3,
  bone4,
  fMono,
  fSans,
  ink,
  ink2,
  ink3,
  rule,
  ruleStrong,
  sage,
} from './tokens';
import { Diamond, MonoLabel, NavIcon, type NavIconKind } from './atoms';

export type ConsultantView =
  | 'dashboard'
  | 'claims'
  | 'wizard'
  | 'evidence'
  | 'chain'
  | 'watch'
  | 'financing';

interface NavItem {
  k: ConsultantView;
  label: string;
  icon: NavIconKind;
  badge?: string;
  primary?: boolean;
}

const NAV: NavItem[] = [
  { k: 'dashboard', label: 'Dashboard', icon: 'grid' },
  { k: 'claims', label: 'Claims', icon: 'folder', badge: '14' },
  { k: 'wizard', label: 'Active claim', icon: 'wand', primary: true },
  { k: 'evidence', label: 'Evidence vault', icon: 'lock' },
  { k: 'chain', label: 'Chain', icon: 'chain' },
  { k: 'watch', label: 'Watch', icon: 'eye', badge: '3' },
  { k: 'financing', label: 'Financing', icon: 'coin', badge: 'BETA' },
];

interface SidebarProps {
  view: ConsultantView;
  setView: (v: ConsultantView) => void;
}

export function Sidebar({ view, setView }: SidebarProps) {
  return (
    <div
      style={{
        width: 220,
        background: ink,
        borderRight: `1px solid ${rule}`,
        display: 'flex',
        flexDirection: 'column',
        padding: '20px 12px',
        height: '100%',
      }}
    >
      <div style={{ marginBottom: 22, padding: '0 10px' }}>
        <MonoLabel size={9} color={bone4} tracking="0.22em">
          Workspace
        </MonoLabel>
        <div
          style={{
            marginTop: 8,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span style={{ fontFamily: fSans, fontSize: 13, color: bone, fontWeight: 500 }}>
            Pemberton &amp; Cole
          </span>
          <Diamond size={6} />
        </div>
        <div
          style={{
            fontFamily: fMono,
            fontSize: 9.5,
            color: bone3,
            letterSpacing: '0.14em',
            marginTop: 4,
          }}
        >
          14 CLAIMS · FY26
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {NAV.map((item) => {
          const active = view === item.k;
          return (
            <button
              key={item.k}
              onClick={() => setView(item.k)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '10px 12px',
                background: active ? 'rgba(225,162,58,0.10)' : 'transparent',
                border: `1px solid ${active ? 'rgba(225,162,58,0.30)' : 'transparent'}`,
                borderRadius: 3,
                cursor: 'pointer',
                color: active ? amber : bone2,
                fontFamily: fSans,
                fontSize: 13.5,
                fontWeight: 500,
                textAlign: 'left',
                width: '100%',
              }}
            >
              <NavIcon kind={item.icon} />
              <span style={{ flex: 1 }}>{item.label}</span>
              {item.badge && (
                <span
                  style={{
                    fontFamily: fMono,
                    fontSize: 9,
                    letterSpacing: '0.14em',
                    padding: '2px 6px',
                    background: active ? 'rgba(225,162,58,0.2)' : ink3,
                    color: active ? amber : bone3,
                    borderRadius: 2,
                  }}
                >
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Bottom: chain status */}
      <div
        style={{
          marginTop: 'auto',
          padding: '14px',
          background: ink2,
          border: `1px solid ${ruleStrong}`,
          borderRadius: 4,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <Diamond size={6} />
          <MonoLabel size={9} color={amber} tracking="0.18em">
            Chain status
          </MonoLabel>
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontFamily: fMono,
            fontSize: 10,
            color: bone3,
            letterSpacing: '0.08em',
          }}
        >
          <span>BLOCK</span>
          <span style={{ color: bone }}>#00184_3F</span>
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontFamily: fMono,
            fontSize: 10,
            color: bone3,
            letterSpacing: '0.08em',
            marginTop: 4,
          }}
        >
          <span>HEIGHT</span>
          <span style={{ color: bone }}>3,247</span>
        </div>
        <div
          style={{
            marginTop: 10,
            paddingTop: 8,
            borderTop: `1px solid ${rule}`,
            fontFamily: fMono,
            fontSize: 9,
            color: sage,
            letterSpacing: '0.16em',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: sage }} />
          AZ-1 SYDNEY · AZ-2 MELB
        </div>
      </div>
    </div>
  );
}
