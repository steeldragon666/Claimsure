interface Rule {
  id: string;
  label: string;
  earned: number;
  max: number;
}

interface Props {
  rules: Rule[];
  primaryColor?: string;
}

/**
 * Per-rule breakdown table (T-C13).
 *
 * Renders each scoring rule as a row with the label, an inline progress
 * bar (earned/max), and the numeric score. Color-coded:
 *   - Full marks (earned === max): emerald
 *   - Partial credit: blue (firm primary or fallback)
 *   - Zero: slate
 *
 * Server-component compatible — no state, pure presentation.
 */
export function ScoreRuleBreakdown({ rules, primaryColor }: Props) {
  const partialColor = primaryColor ?? '#2563eb';

  return (
    <ul className="divide-y divide-slate-200">
      {rules.map((rule) => {
        const pct = rule.max > 0 ? Math.max(0, Math.min(1, rule.earned / rule.max)) : 0;
        const isFull = rule.earned === rule.max;
        const isZero = rule.earned === 0;
        const barColor = isFull ? '#059669' : isZero ? '#94a3b8' : partialColor;
        return (
          <li key={rule.id} className="flex items-center gap-4 py-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm font-medium text-slate-900">{rule.label}</span>
                <span className="shrink-0 text-xs text-slate-500">
                  {rule.earned} / {rule.max} pts
                </span>
              </div>
              <div className="mt-2 h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${pct * 100}%`,
                    background: barColor,
                  }}
                />
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
