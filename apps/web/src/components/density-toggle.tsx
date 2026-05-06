'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Design system signature component — DensityToggle.
 *
 * Lets consultants swap between consultant-density (dense, tabular,
 * grid-disciplined) and claimant-density (comfortable, mobile-first,
 * single-column) layouts. The toggle:
 *   1. Updates `data-density` attribute on a target container so CSS
 *      can react via `[data-density="consultant"]` selectors.
 *   2. Persists choice to localStorage under cpa.density key.
 *   3. Reads initial value from localStorage on mount, falling back to
 *      the default (consultant — dense view).
 *
 * See docs/design/system.md §"Density toggle (consultant cockpit)" and
 * §"Spacing" for the two density scales.
 */

export type Density = 'consultant' | 'claimant';

export const DEFAULT_DENSITY: Density = 'consultant';
export const DENSITY_STORAGE_KEY = 'cpa.density';

export interface DensityToggleProps {
  /** localStorage key. Defaults to DENSITY_STORAGE_KEY. */
  storageKey?: string;
  /** CSS selector for the container whose data-density we update. Defaults to 'main'. */
  targetSelector?: string;
  className?: string;
  /** Called whenever density changes (after storage write). */
  onChange?: (density: Density) => void;
}

// ---------- Pure helpers (exported for unit testing) ----------

const VALID_DENSITIES: ReadonlySet<string> = new Set(['consultant', 'claimant']);

export function readDensityFromStorage(
  storage: Storage,
  key: string = DENSITY_STORAGE_KEY,
): Density {
  try {
    const raw = storage.getItem(key);
    if (raw && VALID_DENSITIES.has(raw)) return raw as Density;
    return DEFAULT_DENSITY;
  } catch {
    // Private/incognito or other storage failure — fail safe to default.
    return DEFAULT_DENSITY;
  }
}

export function writeDensityToStorage(
  storage: Storage,
  density: Density,
  key: string = DENSITY_STORAGE_KEY,
): void {
  try {
    storage.setItem(key, density);
  } catch {
    // Quota exceeded or storage disabled — best effort, swallow.
  }
}

// ---------- Component ----------

export function DensityToggle({
  storageKey = DENSITY_STORAGE_KEY,
  targetSelector = 'main',
  className,
  onChange,
}: DensityToggleProps) {
  // Initial state set on mount (after hydration) so SSR remains stable —
  // no localStorage access during render.
  const [density, setDensityState] = React.useState<Density>(DEFAULT_DENSITY);

  // On mount, read persisted density and apply it to the target.
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const initial = readDensityFromStorage(window.localStorage, storageKey);
    setDensityState(initial);
    applyDensityToTarget(targetSelector, initial);
  }, [storageKey, targetSelector]);

  const toggle = React.useCallback(() => {
    setDensityState((prev) => {
      const next: Density = prev === 'consultant' ? 'claimant' : 'consultant';
      if (typeof window !== 'undefined') {
        writeDensityToStorage(window.localStorage, next, storageKey);
        applyDensityToTarget(targetSelector, next);
      }
      onChange?.(next);
      return next;
    });
  }, [storageKey, targetSelector, onChange]);

  const ariaLabel =
    density === 'consultant'
      ? 'Switch to claimant density (comfortable layout)'
      : 'Switch to consultant density (compact layout)';

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={ariaLabel}
      aria-pressed={density === 'consultant'}
      title={ariaLabel}
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-sm',
        'border border-[hsl(var(--brand-hairline))] bg-[hsl(var(--brand-base))] text-[hsl(var(--brand-ink-muted))]',
        'hover:bg-[hsl(var(--brand-hairline))] hover:text-[hsl(var(--brand-ink))]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--brand-accent))] focus-visible:ring-offset-2',
        className,
      )}
      data-density={density}
    >
      {density === 'consultant' ? <DenseIcon /> : <LooseIcon />}
    </button>
  );
}

// ---------- Helpers ----------

function applyDensityToTarget(selector: string, density: Density) {
  if (typeof document === 'undefined') return;
  const target = document.querySelector(selector);
  if (target) {
    target.setAttribute('data-density', density);
  }
}

// ---------- Inline icons ----------

function DenseIcon() {
  // Three horizontal lines, tightly stacked
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <line
        x1="2"
        y1="4"
        x2="12"
        y2="4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <line
        x1="2"
        y1="7"
        x2="12"
        y2="7"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <line
        x1="2"
        y1="10"
        x2="12"
        y2="10"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function LooseIcon() {
  // Two horizontal lines, more spaced
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <line
        x1="2"
        y1="5"
        x2="12"
        y2="5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <line
        x1="2"
        y1="9"
        x2="12"
        y2="9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
