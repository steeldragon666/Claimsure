/**
 * P7 Theme D Task D.9 — RIF daily scrape orchestrator.
 *
 * Core orchestration logic for the daily regulatory intelligence feed
 * scrape. For each enabled source whose polling interval has elapsed:
 *   1. Resolve the connector via parser_kind
 *   2. Fetch new events
 *   3. Insert events (idempotent on source_id + external_id)
 *   4. Update source polled status
 *
 * Classification (D.10) and webhook dispatch (D.11) will be wired
 * into this loop once those tasks land.
 *
 * This module lives in `@cpa/integrations/regulatory` so it can be
 * imported from both:
 *   - `apps/api/src/jobs/rif-daily-scrape.ts` (pg-boss cron)
 *   - `tools/scripts/scrape-regulatory.ts` (manual CLI entry point)
 */

import crypto from 'node:crypto';
import { privilegedSql } from '@cpa/db/client';
import { getConnector } from './connector-factory.js';
import { classifyError } from './error-classifier.js';
import type { RegulatorySourceRow, RawRegulatoryEvent } from './source-connector.js';

export interface ScrapeResult {
  sources_processed: number;
  events_inserted: number;
  events_skipped: number;
  errors: { source_id: string; source_name: string; status: string; message: string }[];
}

/**
 * Insert a raw event row, idempotent on (source_id, external_id).
 * Returns the row (existing or newly inserted) with its id and classified_at.
 */
async function insertOrSkipEvent(
  sourceId: string,
  evt: RawRegulatoryEvent,
): Promise<{ id: string; classified_at: string | null }> {
  const rows = await privilegedSql<{ id: string; classified_at: string | null }[]>`
    INSERT INTO regulatory_event (id, source_id, external_id, raw_title, raw_content, published_at, raw_url)
    VALUES (
      ${crypto.randomUUID()}, ${sourceId}, ${evt.external_id},
      ${evt.raw_title}, ${evt.raw_content}, ${evt.published_at},
      ${evt.source_url ?? ''}
    )
    ON CONFLICT (source_id, external_id) DO NOTHING
    RETURNING id, classified_at::text
  `;
  if (rows.length > 0) return rows[0]!;
  // Already existed -- fetch it
  const existing = await privilegedSql<{ id: string; classified_at: string | null }[]>`
    SELECT id, classified_at::text FROM regulatory_event
    WHERE source_id = ${sourceId} AND external_id = ${evt.external_id}
  `;
  return existing[0]!;
}

/**
 * Update a source's polled status and timestamp.
 */
async function updateSourceStatus(sourceId: string, status: string): Promise<void> {
  await privilegedSql`
    UPDATE regulatory_source
    SET last_polled_status = ${status},
        last_polled_at = NOW()
    WHERE id = ${sourceId}
  `;
}

/**
 * Run the daily RIF scrape across all enabled sources.
 *
 * Selects sources where `enabled = true` and whose polling interval
 * has elapsed (or that have never been polled). Processes them
 * sequentially — connector implementations may hit external APIs and
 * we want to avoid overwhelming them.
 */
export async function runDailyScrape(): Promise<ScrapeResult> {
  const sources = await privilegedSql<RegulatorySourceRow[]>`
    SELECT id, source_name, parser_kind, source_url, fetch_interval_hours, enabled, last_polled_at::text
    FROM regulatory_source
    WHERE enabled = true
      AND (last_polled_at IS NULL OR last_polled_at < NOW() - make_interval(hours => fetch_interval_hours))
    ORDER BY last_polled_at ASC NULLS FIRST
  `;

  const result: ScrapeResult = {
    sources_processed: 0,
    events_inserted: 0,
    events_skipped: 0,
    errors: [],
  };

  for (const source of sources) {
    try {
      const connector = getConnector(source);
      const newEvents = await connector.fetch(source);

      for (const evt of newEvents) {
        const row = await insertOrSkipEvent(source.id, evt);
        if (row.classified_at === null) {
          // TODO (D.10): classify via regulatory-classify@1.0.0
          // TODO (D.11): dispatch webhooks if severity warrants
          result.events_inserted++;
        } else {
          result.events_skipped++;
        }
      }

      await updateSourceStatus(source.id, 'success');
      result.sources_processed++;
    } catch (err) {
      const status = classifyError(err);
      await updateSourceStatus(source.id, status);
      result.errors.push({
        source_id: source.id,
        source_name: source.source_name,
        status,
        message: err instanceof Error ? err.message : String(err),
      });
      result.sources_processed++;
    }
  }

  return result;
}
