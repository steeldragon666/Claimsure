'use client';

import { cn } from '@/lib/utils';
import { SIMILARITY_THRESHOLD } from './multi-entity-comparison';

/**
 * P7 Theme C Task C.5 — Similarity side-by-side comparison component.
 *
 * Renders two activity narratives side-by-side with a similarity score
 * badge. Highlights high-similarity pairs (>= 0.75) with amber styling.
 * Used as the drilldown view when clicking a cell in the multi-entity
 * comparison heatmap.
 */

export interface ActivitySummary {
  id: string;
  code: string;
  title: string;
  hypothesis?: string;
  experiment?: string;
}

export interface SimilarityPair {
  activity_a: ActivitySummary;
  activity_b: ActivitySummary;
  score: number;
}

export function SimilaritySideBySide({ pair }: { pair: SimilarityPair | null }) {
  if (!pair) {
    return (
      <div className="text-sm text-muted-foreground" data-testid="similarity-empty">
        Select a cell in the comparison grid to view details.
      </div>
    );
  }

  const isHigh = pair.score >= SIMILARITY_THRESHOLD;

  return (
    <div data-testid="similarity-side-by-side" className="space-y-3">
      {/* Score badge */}
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
            isHigh
              ? 'bg-amber-100 text-amber-800 border border-amber-200'
              : 'bg-green-50 text-green-700 border border-green-200',
          )}
          data-testid="similarity-score-badge"
        >
          {isHigh && '⚠️ '}Similarity: {(pair.score * 100).toFixed(0)}%
        </span>
      </div>

      {/* Side-by-side panels */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ActivityPanel activity={pair.activity_a} label="Activity A" />
        <ActivityPanel activity={pair.activity_b} label="Activity B" />
      </div>
    </div>
  );
}

function ActivityPanel({ activity, label }: { activity: ActivitySummary; label: string }) {
  return (
    <div className="rounded border border-border bg-card p-3 space-y-2">
      <div className="flex items-baseline gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="font-mono text-sm font-medium">{activity.code}</span>
      </div>
      <h3 className="text-sm font-medium">{activity.title}</h3>

      {activity.hypothesis && (
        <div>
          <dt className="text-xs text-muted-foreground">Hypothesis</dt>
          <dd className="text-sm mt-0.5 whitespace-pre-wrap">{activity.hypothesis}</dd>
        </div>
      )}

      {activity.experiment && (
        <div>
          <dt className="text-xs text-muted-foreground">Experiment</dt>
          <dd className="text-sm mt-0.5 whitespace-pre-wrap">{activity.experiment}</dd>
        </div>
      )}
    </div>
  );
}
