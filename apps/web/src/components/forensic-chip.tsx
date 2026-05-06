'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Design system signature component — ForensicChip.
 *
 * The most-repeated visual element in the platform: a pill-shaped chip
 * with monospace text rendering hash + timestamp + (optional) version
 * pin inline next to every claim-bearing artefact (events, narrative
 * segments, activities, audit_log rows). See docs/design/system.md
 * §"Forensic-metadata chip" for the full spec.
 *
 * Format: `<hash:8chars> · <YYYY-MM-DD HH:mm UTC> · <version>`
 *   Example: `abcdef12 · 2026-05-06 15:42 · v3`
 *
 * Sizes:
 *   md (default) — text-sm (14px), padding 4/8 — for inline narrative use
 *   sm           — text-xs (12px), padding 2/6 — for dense forensic tables
 *
 * States:
 *   default    — hairline border (off-white surface)
 *   verifying  — patina-pulsing border via `verify-pulse` keyframe
 *   verified   — patina border + checkmark icon
 *   broken     — clay-red border + X icon
 *
 * Accessibility:
 *   - Reads as `Forensic chip: <label>, <state>` to screen readers
 *   - When onClick provided, renders as <button> for keyboard navigation;
 *     otherwise renders as <span>
 *   - Tabular-nums forced on the timestamp+version for column alignment
 *
 * Time stability:
 *   Timestamps render in UTC because forensic provenance must be
 *   timezone-stable across audit reconstruction (the chip is consumed
 *   by ATO reviewers in AEST and Anthropic users in PST; the row's
 *   absolute moment must read identically).
 */

export type ForensicChipState = 'default' | 'verifying' | 'verified' | 'broken';
export type ForensicChipSize = 'md' | 'sm';

export interface ForensicChipProps {
  /** Full hash; will be truncated to 8 chars for display. */
  hash: string;
  /** Captured-at timestamp (Date or ISO string). Renders in UTC. */
  capturedAt: Date | string;
  /** Optional version pin (e.g. "v3"). Null/undefined/"" omits the segment. */
  version?: string | null;
  /** Visual state. Default: 'default'. */
  state?: ForensicChipState;
  /** Size variant. Default: 'md'. */
  size?: ForensicChipSize;
  /** Additional Tailwind classes (merged via tailwind-merge). */
  className?: string;
  /** Override the default screen-reader label. */
  ariaLabel?: string;
  /** Click handler. When provided, renders as <button> for keyboard nav. */
  onClick?: () => void;
}

// ---------- Pure helpers (exported for unit testing) ----------

export function truncateHash(hash: string, length = 8): string {
  if (hash.length <= length) return hash;
  return hash.slice(0, length);
}

export function formatChipTimestamp(ts: Date | string): string {
  const date = typeof ts === 'string' ? new Date(ts) : ts;
  if (Number.isNaN(date.getTime())) {
    throw new Error(`formatChipTimestamp: invalid date input: ${String(ts)}`);
  }
  // YYYY-MM-DD HH:mm in UTC. zero-pad everything for tabular alignment.
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const min = String(date.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

export function formatChipLabel(opts: {
  hash: string;
  capturedAt: Date | string;
  version?: string | null;
}): string {
  const parts = [truncateHash(opts.hash), formatChipTimestamp(opts.capturedAt)];
  if (opts.version) parts.push(opts.version);
  return parts.join(' · ');
}

// ---------- Component ----------

const stateStyles: Record<ForensicChipState, string> = {
  default: 'border-border',
  // animate-verify-pulse keyframe is defined in globals.css (P7 Theme C)
  verifying: 'border-[hsl(var(--brand-accent))] animate-verify-pulse',
  verified: 'border-[hsl(var(--brand-accent))] text-[hsl(var(--brand-accent))]',
  broken: 'border-[hsl(var(--brand-error))] text-[hsl(var(--brand-error))]',
};

const sizeStyles: Record<ForensicChipSize, string> = {
  // mono-md: 14px font, padding 4/8
  md: 'text-sm px-2 py-1',
  // mono-sm: 12px font, padding 2/6
  sm: 'text-xs px-1.5 py-0.5',
};

export function ForensicChip({
  hash,
  capturedAt,
  version = null,
  state = 'default',
  size = 'md',
  className,
  ariaLabel,
  onClick,
}: ForensicChipProps) {
  const label = formatChipLabel({ hash, capturedAt, version });
  const ariaText = ariaLabel ?? `Forensic chip: ${label}${state !== 'default' ? `, ${state}` : ''}`;

  const baseClasses = cn(
    'inline-flex items-center gap-1.5 rounded-full font-mono border bg-secondary tabular-nums',
    sizeStyles[size],
    stateStyles[state],
    onClick &&
      'cursor-pointer hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.4),inset_0_-1px_0_rgba(26,24,20,0.04)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--brand-accent))] focus-visible:ring-offset-2',
    className,
  );

  const icon = state === 'verified' ? <CheckIcon /> : state === 'broken' ? <XIcon /> : null;

  if (onClick) {
    return (
      <button type="button" className={baseClasses} onClick={onClick} aria-label={ariaText}>
        <span aria-hidden="true">{label}</span>
        {icon}
      </button>
    );
  }

  return (
    <span className={baseClasses} aria-label={ariaText}>
      <span aria-hidden="true">{label}</span>
      {icon}
    </span>
  );
}

// ---------- Inline icons (no lucide-react import to keep bundle tight) ----------

function CheckIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 12 12"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M2 6L5 9L10 3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function XIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 12 12"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M3 3L9 9M9 3L3 9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
