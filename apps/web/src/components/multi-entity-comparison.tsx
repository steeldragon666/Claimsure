'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * P7 Theme C Task C.4 — Multi-entity comparison panel.
 *
 * Heatmap-style grid showing pairwise similarity scores between
 * activities in the same project. Yellow ⚠ on similarity ≥ 0.75.
 *
 * Graceful empty state: when the multi_entity_similarity_score table
 * doesn't exist (pre-p7d), shows "No similarity scans yet — install
 * Theme D to enable" message.
 */

interface ComparisonActivity {
  id: string;
  title: string;
  code: string;
  kind: string;
}

interface SimilarityScore {
  activity_a_id: string;
  activity_b_id: string;
  score: number;
}

export interface ComparisonResponse {
  activities: ComparisonActivity[];
  scores: SimilarityScore[];
  similarity_available: boolean;
}

/** Threshold for flagging high similarity (yellow warning). */
export const SIMILARITY_THRESHOLD = 0.75;

/** Map a 0-1 score to a bg colour class. */
export function scoreColorClass(score: number | null): string {
  if (score === null) return 'bg-muted';
  if (score >= SIMILARITY_THRESHOLD) return 'bg-amber-100';
  if (score >= 0.5) return 'bg-yellow-50';
  return 'bg-green-50';
}

async function fetchComparison(activityId: string): Promise<ComparisonResponse> {
  return apiFetch<ComparisonResponse>(`/v1/multi-entity-comparison/${activityId}`);
}

function getScore(scores: SimilarityScore[], aId: string, bId: string): number | null {
  if (aId === bId) return null; // self-comparison
  const found = scores.find(
    (s) =>
      (s.activity_a_id === aId && s.activity_b_id === bId) ||
      (s.activity_a_id === bId && s.activity_b_id === aId),
  );
  return found?.score ?? null;
}

export function MultiEntityComparison({ activityId }: { activityId: string }) {
  const { data, isPending, error } = useQuery({
    queryKey: ['multi-entity-comparison', activityId],
    queryFn: () => fetchComparison(activityId),
  });

  if (isPending) {
    return (
      <div className="text-sm text-muted-foreground" data-testid="comparison-loading">
        Loading comparison…
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-sm text-red-600" data-testid="comparison-error">
        Failed to load comparison: {error instanceof Error ? error.message : 'Unknown error'}
      </div>
    );
  }

  if (!data) return null;

  // Empty state when p7d hasn't landed yet
  if (!data.similarity_available) {
    return (
      <div
        className="rounded border border-dashed border-border p-4 text-center text-sm text-muted-foreground"
        data-testid="comparison-not-available"
      >
        No similarity scans yet — install Theme D to enable multi-entity comparison.
      </div>
    );
  }

  // If we have no activities or only one, there's nothing to compare
  if (data.activities.length < 2) {
    return (
      <div className="text-sm text-muted-foreground" data-testid="comparison-insufficient">
        Need at least 2 activities in this project for comparison.
      </div>
    );
  }

  return (
    <div data-testid="comparison-grid">
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr>
              <th className="p-1 text-left font-medium text-muted-foreground">Activity</th>
              {data.activities.map((a) => (
                <th key={a.id} className="p-1 text-center font-mono font-medium">
                  {a.code}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.activities.map((rowActivity) => (
              <tr key={rowActivity.id}>
                <td className="p-1 font-mono text-muted-foreground">{rowActivity.code}</td>
                {data.activities.map((colActivity) => {
                  const score = getScore(data.scores, rowActivity.id, colActivity.id);
                  const isSelf = rowActivity.id === colActivity.id;
                  return (
                    <td
                      key={colActivity.id}
                      className={cn(
                        'p-1 text-center border border-border',
                        isSelf ? 'bg-muted' : scoreColorClass(score),
                      )}
                      data-testid={`score-cell-${rowActivity.code}-${colActivity.code}`}
                    >
                      {isSelf ? (
                        '—'
                      ) : score !== null ? (
                        <span className="flex items-center justify-center gap-0.5">
                          {score >= SIMILARITY_THRESHOLD && <span title="High similarity">⚠️</span>}
                          {score.toFixed(2)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">–</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
