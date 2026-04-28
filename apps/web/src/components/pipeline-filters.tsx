'use client';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';
import { CLAIM_STAGES_LITERAL, type ClaimStage } from '@cpa/schemas';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * Filter + view-toggle bar for /pipeline.
 *
 * URL is the source of truth (matches the FilterTabs pattern in
 * subject-tenants/[id]/_components/filter-tabs.tsx — shareable links,
 * back-button friendly). The page passes the parsed values down so it
 * can do the data fetch with the same query keys.
 *
 * Filters supported (all multi-select via repeated query params except
 * fy which is a single int and sector which is a single string):
 *
 *   ?stage=engagement&stage=review   → ClaimStage[] (multi)
 *   ?consultant=<uuid>               → user UUID (single, "" = all)
 *   ?fy=2026                         → fiscal_year (single int)
 *   ?sector=biotech                  → free-text contains match (single)
 *   ?view=kanban|table               → view toggle (default = table)
 *
 * Stage chips toggle on click; the rest are simple inputs/selects. Empty
 * values are scrubbed from the URL so we don't leave dangling
 * `?consultant=` segments behind.
 */

export type PipelineView = 'kanban' | 'table';

const VIEW_VALUES = new Set<PipelineView>(['kanban', 'table']);

export function parseView(raw: string | null): PipelineView {
  return raw && VIEW_VALUES.has(raw as PipelineView) ? (raw as PipelineView) : 'table';
}

export function parseStages(raw: string[] | undefined): ClaimStage[] {
  if (!raw || raw.length === 0) return [];
  const valid = new Set<string>(CLAIM_STAGES_LITERAL);
  return raw.filter((s): s is ClaimStage => valid.has(s));
}

export function parseFiscalYear(raw: string | null, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1900 && n <= 2200 ? n : fallback;
}

/**
 * Australian R&DTI fiscal-year convention: FY2026 = 1 July 2025 - 30 June
 * 2026. The "current" FY at any given date is therefore Jun-incremented.
 */
export function currentFiscalYear(now: Date = new Date()): number {
  const y = now.getUTCFullYear();
  // Jul (month 6, 0-indexed) onwards rolls into the next FY.
  return now.getUTCMonth() >= 6 ? y + 1 : y;
}

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

const STAGE_LABELS: Record<ClaimStage, string> = {
  engagement: 'Engagement',
  activity_capture: 'Activity capture',
  narrative_drafting: 'Narrative drafting',
  expenditure_schedule: 'Expenditure schedule',
  review: 'Review',
  submitted: 'Submitted',
  audit_defence: 'Audit defence',
};

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

  const onFyChange = useCallback(
    (next: string) => {
      updateParams((params) => {
        const trimmed = next.trim();
        if (!trimmed) params.delete('fy');
        else params.set('fy', trimmed);
      });
    },
    [updateParams],
  );

  const onSectorChange = useCallback(
    (next: string) => {
      updateParams((params) => {
        const trimmed = next.trim();
        if (!trimmed) params.delete('sector');
        else params.set('sector', trimmed);
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
              defaultValue={fiscalYear}
              onBlur={(e) => onFyChange(e.target.value)}
              className="w-28"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">Sector</span>
            <Input
              type="text"
              aria-label="Sector"
              placeholder="e.g. biotech"
              defaultValue={sector}
              onBlur={(e) => onSectorChange(e.target.value)}
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
            return (
              <button
                key={stage}
                type="button"
                role="checkbox"
                aria-checked={isActive}
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
