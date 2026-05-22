'use client';

import { amber, bone, bone3, fMono, fSans, fSerif, ink } from './tokens';
import { Diamond, MonoLabel } from './atoms';

export function FinancingView() {
  return (
    <div
      style={{
        padding: 56,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        gap: 18,
      }}
    >
      <Diamond size={14} />
      <MonoLabel size={11} color={bone3}>
        FINANCING · BETA · FY26/27
      </MonoLabel>
      <h2
        style={{
          fontFamily: fSerif,
          fontWeight: 300,
          fontSize: 56,
          lineHeight: 1.05,
          letterSpacing: '-0.025em',
          color: bone,
          margin: 0,
          maxWidth: 640,
        }}
      >
        Claim financing arrives <em style={{ color: amber, fontStyle: 'italic' }}>July 1.</em>
      </h2>
      <p
        style={{
          fontFamily: fSans,
          fontSize: 17,
          lineHeight: 1.55,
          color: bone3,
          maxWidth: 560,
          margin: 0,
        }}
      >
        One-click financing against sealed rebates. Origination margin to the consultancy.
        Foundation cohort gets first access.
      </p>
      <button
        style={{
          marginTop: 12,
          padding: '12px 24px',
          background: amber,
          color: ink,
          border: 'none',
          borderRadius: 3,
          fontFamily: fMono,
          fontSize: 12,
          letterSpacing: '0.18em',
          cursor: 'pointer',
          fontWeight: 600,
        }}
      >
        Join the waitlist →
      </button>
    </div>
  );
}
