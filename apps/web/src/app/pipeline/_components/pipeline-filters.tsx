'use client';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { CLAIM_STAGES_LITERAL, type ClaimStage } from '@cpa/schemas';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { STAGE_LABELS, type PipelineView } from './url-params';

/**
 * Filter + view-toggle bar for /pipeline.
 *
 * URL is the source of truth (matches the FilterTabs pattern in
 * subject-tenants/[id]/_components/filter-tabs.tsx — shareable links,
 * back-button friendly). The page passes the parsed values down so it
 * can do the data fetch with the same query keys.
 *
 * Pure parsers (parseView/parseStages/parseFiscalYear/currentFiscalYear)
 * live in `./url-params.ts` so they're unit-testable in isolation; the
 * page imports them directly.
 *
 * Stage chips toggle on click; the rest are controlled inputs that debounce
 * (250ms) before writing to the URL — keeps the URL from churning on every
 * keystroke. A useEffect re-syncs local state if the URL changes externally
 * (back button, programmatic mutation by another component).
 */

export interface ConsultantOption {
  id: string;
  label: string;
}

export interface PipelineFiltersProps {
  view: PipelineView;
  stages: ClaimStage[];
  consultantId: string | null;
  fiscalYear: number;
  sector: string;
  consultants: ConsultantOption[];
}

const DEBOUNCE_MS = 250;

/**
 * Tiny debounce hook — returns the input value after `delayMs` of stability.
 * Inlined here rather than added to /hooks because it's only used by this
 * component. If a second consumer appears, promote it.
 */
function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

export function PipelineFilters({
  view,
  stages,
  consultantId,
  fiscalYear,
  sector,
  consultants,
}: PipelineFiltersProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const updateParams = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams.toString());
      mutate(params);
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  // --- Controlled FY input (Issue 2: was uncontrolled, broke back-button) ---
  const [fyInput, setFyInput] = useState<string>(String(fiscalYear));
  // Re-sync local state when URL FY changes externally (back/forward button).
  useEffect(() => {
    setFyInput(String(fiscalYear));
  }, [fiscalYear]);
  const debouncedFy = useDebounced(fyInput, DEBOUNCE_MS);
  useEffect(() => {
    const trimmed = debouncedFy.trim();
    // No-op if the URL already matches (avoids a redundant router.replace
    // when the URL→state sync above just fired). We intentionally read
    // fiscalYear/updateParams without depending on them — this effect should
    // only fire when the *debounced user input* changes; the early-return
    // protects against external FY updates landing here.
    if (trimmed === String(fiscalYear)) return;
    updateParams((params) => {
      if (!trimmed) params.delete('fy');
      else params.set('fy', trimmed);
    });
  }, [debouncedFy, fiscalYear, updateParams]);

  // --- Controlled Sector input (same pattern) ---
  const [sectorInput, setSectorInput] = useState<string>(sector);
  useEffect(() => {
    setSectorInput(sector);
  }, [sector]);
  const debouncedSector = useDebounced(sectorInput, DEBOUNCE_MS);
  useEffect(() => {
    const trimmed = debouncedSector.trim();
    if (trimmed === sector) return;
    updateParams((params) => {
      if (!trimmed) params.delete('sector');
      else params.set('sector', trimmed);
    });
  }, [debouncedSector, sector, updateParams]);

  const onToggleStage = useCallback(
    (stage: ClaimStage) => {
      updateParams((params) => {
        const existing = params.getAll('stage');
        params.delete('stage');
        const next = existing.includes(stage)
          ? existing.filter((s) => s !== stage)
          : [...existing, stage];
        for (const s of next) params.append('stage', s);
      });
    },
    [updateParams],
  );

  const onConsultantChange = useCallback(
    (next: string) => {
      updateParams((params) => {
        if (!next) params.delete('consultant');
        else params.set('consultant', next);
      });
    },
    [updateParams],
  );

  const onViewChange = useCallback(
    (next: PipelineView) => {
      updateParams((params) => {
        // Default = table, so omit it from URL when selected.
        if (next === 'table') params.delete('view');
        else params.set('view', next);
      });
    },
    [updateParams],
  );

  return (
    <div className="space-y-4 rounded-md border p-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">Consultant</span>
            <select
              aria-label="Consultant"
              value={consultantId ?? ''}
              onChange={(e) => onConsultantChange(e.target.value)}
              className="h-10 min-w-[12rem] rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
            >
              <option value="">All consultants</option>
              {consultants.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">Fiscal year</span>
            <Input
              type="number"
              aria-label="Fiscal year"
              inputMode="numeric"
              min={1900}
              max={2200}
              value={fyInput}
              onChange={(e) => setFyInput(e.target.value)}
              className="w-28"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">Sector</span>
            <Input
              type="text"
              aria-label="Sector"
              placeholder="e.g. biotech"
              value={sectorInput}
              onChange={(e) => setSectorInput(e.target.value)}
              className="w-40"
            />
          </label>
        </div>

        <div
          role="tablist"
          aria-label="View"
          className="inline-flex rounded-md border bg-background p-1"
        >
          <Button
            type="button"
            role="tab"
            aria-selected={view === 'table'}
            variant={view === 'table' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => onViewChange('table')}
          >
            Table
          </Button>
          <Button
            type="button"
            role="tab"
            aria-selected={view === 'kanban'}
            variant={view === 'kanban' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => onViewChange('kanban')}
          >
            Kanban
          </Button>
        </div>
      </div>

      <fieldset>
        <legend className="mb-2 text-xs font-medium text-muted-foreground">Stages</legend>
        <div className="flex flex-wrap gap-2">
          {CLAIM_STAGES_LITERAL.map((stage) => {
            const isActive = stages.includes(stage);
            // Toggle-button pattern: aria-pressed gets the right semantics
            // for screen readers without the keyboard mismatch you get from
            // role="checkbox" on a bare <button> (Space toggling, etc.).
            return (
              <button
                key={stage}
                type="button"
                aria-pressed={isActive}
                aria-label={STAGE_LABELS[stage]}
                onClick={() => onToggleStage(stage)}
                className={cn(
                  'inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                  isActive
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-input bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )}
              >
                {STAGE_LABELS[stage]}
              </button>
            );
          })}
        </div>
      </fieldset>
    </div>
  );
}
