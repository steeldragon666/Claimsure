import type { SimilaritySqlExecutor } from './scorer.js';

/**
 * Historical rejection corpus entry from regulatory_event rows where
 * classification_kind IN ('aat_decision','art_decision') and severity
 * indicates rejection.
 */
export interface HistoricalRejection {
  event_id: string;
  title: string;
  content: string;
  classification_kind: string;
  published_at: string;
}

/**
 * Load historical rejection corpus for similarity comparison.
 *
 * Queries regulatory_event for AAT/ART decisions with high or medium
 * severity — these represent past rejections that current activities
 * might resemble, triggering a DISR pattern-match warning.
 *
 * Note: regulatory_event is a global table (no RLS), so the tenantId
 * parameter is reserved for future tenant-scoped filtering if needed.
 *
 * @param _tenantId - Reserved for future tenant-scoped filtering
 * @param executor  - DI seam for the SQL client (tests inject a stub)
 */
export async function loadHistoricalRejections(
  _tenantId: string,
  executor: SimilaritySqlExecutor,
): Promise<HistoricalRejection[]> {
  void _tenantId;
  const rows = await executor<HistoricalRejection>`
    SELECT id AS event_id, raw_title AS title, raw_content AS content,
           classification_kind, published_at::text
    FROM regulatory_event
    WHERE classification_kind IN ('aat_decision', 'art_decision')
      AND classification_severity IN ('high', 'medium')
    ORDER BY published_at DESC
  `;
  return rows as HistoricalRejection[];
}
