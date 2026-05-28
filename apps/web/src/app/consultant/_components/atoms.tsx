'use client';

import type { CSSProperties, ReactNode } from 'react';
import { amber, bone2, fMono, ink3, rust, sage } from './tokens';

interface DiamondProps {
  size?: number;
  filled?: boolean;
  color?: string;
  style?: CSSProperties;
}

export function Diamond({ size = 8, filled = true, color = amber, style }: DiamondProps) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        background: filled ? color : 'transparent',
        border: `1px solid ${color}`,
        transform: 'rotate(45deg)',
        flexShrink: 0,
        ...style,
      }}
    />
  );
}

interface MonoLabelProps {
  children: ReactNode;
  color?: string;
  size?: number;
  tracking?: string;
  style?: CSSProperties;
}

export function MonoLabel({
  children,
  color = amber,
  size = 11,
  tracking = '0.2em',
  style,
}: MonoLabelProps) {
  return (
    <span
      style={{
        fontFamily: fMono,
        fontSize: size,
        letterSpacing: tracking,
        color,
        textTransform: 'uppercase',
        ...style,
      }}
    >
      {children}
    </span>
  );
}

interface CheckProps {
  color?: string;
  size?: number;
}

export function Check({ color = amber, size = 14 }: CheckProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 18 18"
      fill="none"
      stroke={color}
      strokeWidth="2"
      style={{ display: 'inline-block', verticalAlign: 'middle' }}
    >
      <polyline points="3 9 7 13 15 4" />
    </svg>
  );
}

export type StatusKind =
  | 'drafting'
  | 'approved'
  | 'review'
  | 'sealed'
  | 'chain-lock'
  | 'financing'
  | 'flagged';

const STATUS_MAP: Record<StatusKind, { c: string; bg: string; t: string }> = {
  drafting: { c: bone2, bg: ink3, t: 'DRAFTING' },
  approved: { c: sage, bg: 'rgba(122,150,133,0.12)', t: 'APPROVED' },
  review: { c: amber, bg: 'rgba(225,162,58,0.1)', t: 'UNDER REVIEW' },
  sealed: { c: amber, bg: 'rgba(225,162,58,0.18)', t: 'SEALED' },
  'chain-lock': { c: sage, bg: 'rgba(122,150,133,0.18)', t: 'CHAIN-LOCKED' },
  financing: { c: sage, bg: 'rgba(122,150,133,0.18)', t: 'FINANCING' },
  flagged: { c: rust, bg: 'rgba(196,106,72,0.15)', t: 'FLAGGED' },
};

export function StatusPill({ kind }: { kind: StatusKind }) {
  const cfg = STATUS_MAP[kind];
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
      }}
    >
      {cfg.t}
    </span>
  );
}

export type NavIconKind = 'grid' | 'folder' | 'wand' | 'lock' | 'chain' | 'eye' | 'coin' | 'cog';

export function NavIcon({ kind }: { kind: NavIconKind }) {
  const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 } as const;
  switch (kind) {
    case 'grid':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" {...p}>
          <rect x="2" y="2" width="5" height="5" />
          <rect x="9" y="2" width="5" height="5" />
          <rect x="2" y="9" width="5" height="5" />
          <rect x="9" y="9" width="5" height="5" />
        </svg>
      );
    case 'folder':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" {...p}>
          <path d="M2 4 h4 l2 2 h6 v7 H2 z" />
        </svg>
      );
    case 'wand':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" {...p}>
          <line x1="3" y1="13" x2="12" y2="4" />
          <line x1="11" y1="3" x2="13" y2="5" />
          <line x1="13" y1="1" x2="13" y2="3" />
          <line x1="14" y1="2" x2="12" y2="2" />
        </svg>
      );
    case 'lock':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" {...p}>
          <rect x="3" y="7" width="10" height="7" />
          <path d="M5 7 V5 a3 3 0 0 1 6 0 V7" />
        </svg>
      );
    case 'chain':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" {...p}>
          <rect x="2" y="6" width="6" height="4" />
          <rect x="8" y="6" width="6" height="4" />
        </svg>
      );
    case 'eye':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" {...p}>
          <path d="M1 8 C 4 3, 12 3, 15 8 C 12 13, 4 13, 1 8 z" />
          <circle cx="8" cy="8" r="2" />
        </svg>
      );
    case 'coin':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" {...p}>
          <circle cx="8" cy="8" r="6" />
          <path d="M6 6 h3 a1.5 1.5 0 0 1 0 3 H6 z M6 9 h3.5 a1.5 1.5 0 0 1 0 3 H6" />
        </svg>
      );
    case 'cog':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" {...p}>
          <circle cx="8" cy="8" r="2.5" />
          <path d="M8 1 v2 M8 13 v2 M1 8 h2 M13 8 h2 M3 3 l1.5 1.5 M11.5 11.5 l1.5 1.5 M3 13 l1.5 -1.5 M11.5 4.5 l1.5 -1.5" />
        </svg>
      );
  }
}
