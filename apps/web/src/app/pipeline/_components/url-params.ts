import { CLAIM_STAGES_LITERAL, type ClaimStage } from '@cpa/schemas';

/**
 * Pure URL-param parsers for /pipeline. Extracted from pipeline-filters.tsx
 * so they're unit-testable in isolation and re-usable from page.tsx without
 * pulling in the React component module graph.
 *
 * URL is the source of truth for filter state (matches FilterTabs in
 * subject-tenants/[id]/_components/filter-tabs.tsx — shareable links,
 * back-button friendly).
 *
 *   ?stage=engagement&stage=review   → ClaimStage[] (multi)
 *   ?consultant=<uuid>               → user UUID (single, "" = all)
 *   ?fy=2026                         → fiscal_year (single int)
 *   ?sector=biotech                  → free-text contains match (single)
 *   ?view=kanban|table               → view toggle (default = table)
 */

export type PipelineView = 'kanban' | 'table';

const VIEW_VALUES = new Set<PipelineView>(['kanban', 'table']);

/**
 * Human-readable labels for each `ClaimStage`. Single source of truth for
 * pipeline UI surfaces (filter chips, kanban column headers, table cells)
 * so we don't fork the mapping per component.
 */
export const STAGE_LABELS: Record<ClaimStage, string> = {
  engagement: 'Engagement',
  activity_capture: 'Activity capture',
  narrative_drafting: 'Narrative drafting',
  expenditure_schedule: 'Expenditure schedule',
  review: 'Review',
  submitted: 'Submitted',
  audit_defence: 'Audit defence',
};

export function parseView(raw: string | null): PipelineView {
  return raw && VIEW_VALUES.has(raw as PipelineView) ? (raw as PipelineView) : 'table';
}

/**
 * Parses repeated `?stage=` params, dropping unknown values. Duplicate
 * values are preserved as-is (the filter UI naturally dedupes on toggle,
 * and downstream consumers should treat the array as a set anyway).
 */
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
 * Returns the Australian R&DTI fiscal year for a given date (defaults to now).
 * The AU FY rolls over on 1 July (e.g., FY 2026 = 1 Jul 2025 - 30 Jun 2026,
 * named by the year it ends). Uses local-time getters because the cutoff
 * is a wall-clock concept, not a UTC concept — `getUTCMonth` would misfire
 * for Sydney users in the ~11-hour window where local-July-1 is still
 * UTC-June-30.
 */
export function currentFiscalYear(now: Date = new Date()): number {
  // Months are 0-indexed: 0 = January, 6 = July.
  return now.getMonth() >= 6 ? now.getFullYear() + 1 : now.getFullYear();
}
