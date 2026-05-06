'use client';

import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Circle, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { getFormCompleteness } from '../_lib/api';

interface Props {
  subject: string;
  fy: string;
}

const DIMENSIONS = [
  { key: 'knowledge_search', label: 'Knowledge Search Records' },
  { key: 'beneficial_ownership', label: 'Beneficial Ownership' },
  { key: 'forecast', label: 'R&D Expenditure Forecast' },
  { key: 'facilities', label: 'R&D Facilities' },
  { key: 'narratives', label: 'Activity Narratives' },
] as const;

type DimensionKey = (typeof DIMENSIONS)[number]['key'];

export function FormCompletenessGauge({ subject, fy }: Props) {
  const { data, isPending, error } = useQuery({
    queryKey: ['compliance', 'form-completeness', subject, fy],
    queryFn: () => getFormCompleteness(subject, fy),
  });

  if (isPending) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-sm text-muted-foreground">Loading form completeness…</p>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-sm text-red-700">
            Failed to load completeness: {error instanceof Error ? error.message : 'Unknown error'}
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!data) return null;

  const completedCount = DIMENSIONS.filter((d) => data.checks[d.key]?.complete).length;
  const pct = Math.round((completedCount / DIMENSIONS.length) * 100);

  const barColor = pct === 100 ? 'bg-green-700' : pct >= 40 ? 'bg-amber-600' : 'bg-red-700';

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="font-display text-lg font-semibold">Form Readiness</CardTitle>
          {data.complete && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-green-50 px-3 py-1 text-xs font-medium text-green-700">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Ready to Submit
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-sm">
            <span>
              {completedCount} of {DIMENSIONS.length} dimensions complete
            </span>
            <span className="font-mono text-xs tabular-nums">{pct}%</span>
          </div>
          <div className="h-2.5 w-full rounded-full bg-muted">
            <div
              className={cn('h-2.5 rounded-full transition-all', barColor)}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>

        <div className="space-y-2">
          {DIMENSIONS.map((dim) => {
            const check = data.checks[dim.key];
            const isComplete = check?.complete ?? false;
            return (
              <div key={dim.key} className="flex items-center gap-2 text-sm">
                {isComplete ? (
                  <CheckCircle2 className="h-4 w-4 text-green-700 shrink-0" />
                ) : (
                  <Circle className="h-4 w-4 text-muted-foreground shrink-0" />
                )}
                <span className={cn(isComplete ? 'text-green-700' : 'text-muted-foreground')}>
                  {dim.label}
                </span>
                {!isComplete && <StatusHint dimensionKey={dim.key} checks={data.checks} />}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function StatusHint({
  dimensionKey,
  checks,
}: {
  dimensionKey: string;
  checks: NonNullable<
    ReturnType<typeof getFormCompleteness> extends Promise<infer T> ? T : never
  >['checks'];
}) {
  const check = checks[dimensionKey as DimensionKey];
  if (!check) return null;

  let hint = '';
  if (dimensionKey === 'knowledge_search' && 'missing_activity_ids' in check) {
    const missing = check.missing_activity_ids.length;
    hint = `${missing} activit${missing === 1 ? 'y' : 'ies'} missing records`;
  } else if (dimensionKey === 'beneficial_ownership' && 'count' in check) {
    hint = check.count === 0 ? 'No owners declared' : `${check.count} owner(s) — review needed`;
  } else if (dimensionKey === 'forecast' && 'missing_offsets' in check) {
    hint = `Missing year offset${check.missing_offsets.length > 1 ? 's' : ''}: ${check.missing_offsets.join(', ')}`;
  } else if (dimensionKey === 'facilities' && 'count' in check) {
    hint = check.count === 0 ? 'No facilities registered' : '';
  } else if (dimensionKey === 'narratives' && 'warnings' in check) {
    hint = `${check.warnings.length} narrative${check.warnings.length === 1 ? '' : 's'} outside thresholds`;
  }

  if (!hint) return null;

  return (
    <span className="inline-flex items-center gap-1 text-xs text-amber-700">
      <AlertTriangle className="h-3 w-3" />
      {hint}
    </span>
  );
}
