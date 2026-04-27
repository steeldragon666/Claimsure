import type { Event as ApiEvent } from '@cpa/schemas';
import { cn } from '@/lib/utils';

/**
 * Colored pill for an event's effective kind.
 *
 * Color groups (consistent with design doc §5.3):
 *   - blue: HYPOTHESIS, DESIGN, UNCERTAINTY (planning/exploration)
 *   - green: EXPERIMENT, OBSERVATION, ITERATION, NEW_KNOWLEDGE (R&D activity)
 *   - amber: TIME_LOG, ASSOCIATE_FLAG, EXPENDITURE_NOTE, SUPPORTING (financial/admin)
 *   - red: INELIGIBLE
 *   - violet: OVERRIDE (consultant decision)
 *   - slate: any unrecognised kind (defensive)
 *
 * Tailwind needs the literal class names at build time, so we use a static
 * map rather than computing class strings.
 */
const KIND_STYLES: Record<ApiEvent['kind'], string> = {
  HYPOTHESIS: 'bg-blue-50 text-blue-700 border-blue-200',
  DESIGN: 'bg-blue-50 text-blue-700 border-blue-200',
  UNCERTAINTY: 'bg-blue-50 text-blue-700 border-blue-200',
  EXPERIMENT: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  OBSERVATION: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  ITERATION: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  NEW_KNOWLEDGE: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  TIME_LOG: 'bg-amber-50 text-amber-700 border-amber-200',
  ASSOCIATE_FLAG: 'bg-amber-50 text-amber-700 border-amber-200',
  EXPENDITURE_NOTE: 'bg-amber-50 text-amber-700 border-amber-200',
  SUPPORTING: 'bg-amber-50 text-amber-700 border-amber-200',
  INELIGIBLE: 'bg-red-50 text-red-700 border-red-200',
  OVERRIDE: 'bg-violet-50 text-violet-700 border-violet-200',
};

export function KindChip({ kind }: { kind: ApiEvent['kind'] }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
        KIND_STYLES[kind] ?? 'bg-slate-100 text-slate-700 border-slate-200',
      )}
    >
      {kind}
    </span>
  );
}
