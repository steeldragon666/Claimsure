/**
 * P7 Theme D Task D.9 — Source connector interface for RIF daily cron.
 *
 * Defines the abstract contract that each regulatory source parser
 * must implement. Concrete connectors (D.13) plug into this interface
 * via the connector-factory registry.
 */

/**
 * Shape of a raw event returned by a source connector before classification.
 */
export interface RawRegulatoryEvent {
  /** External identifier unique within the source (URL, case number, etc.). */
  external_id: string;
  /** Raw title text as scraped from the source page/feed. */
  raw_title: string;
  /** Raw content text (full body, HTML stripped). */
  raw_content: string;
  /** ISO-8601 date string of the source publication. */
  published_at: string;
  /** Optional URL back to the original document. Maps to `raw_url` in DB. */
  source_url?: string;
}

/**
 * A regulatory source row from the DB.
 *
 * Column names match the actual `regulatory_source` table:
 *   - `source_name` (not `name`)
 *   - `source_url` (not `base_url`)
 *   - `last_polled_at` as ISO-8601 text (cast in the SELECT)
 */
export interface RegulatorySourceRow {
  id: string;
  source_name: string;
  parser_kind: string;
  source_url: string;
  fetch_interval_hours: number;
  enabled: boolean;
  last_polled_at: string | null;
}

/**
 * Contract for a source-specific connector.
 *
 * Each parser_kind maps to one concrete ISourceConnector implementation.
 * The connector is responsible for fetching new events from its source
 * and returning them as RawRegulatoryEvent[].
 */
export interface ISourceConnector {
  /**
   * Fetch new events from the source.
   *
   * @param source - The regulatory_source row with source_url and metadata.
   * @returns Array of raw events ready for persistence + classification.
   */
  fetch(source: RegulatorySourceRow): Promise<RawRegulatoryEvent[]>;
}
