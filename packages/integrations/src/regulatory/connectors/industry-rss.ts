/**
 * P7 Theme D Task D.13 — Industry RSS feed connector.
 *
 * Handles RSS feeds from industry sources (RSM AU, Big-4 firms, etc.).
 * Reuses the same RSS parsing logic as the ATO RSS connector since the
 * format is standard RSS 2.0.
 *
 * Configured via RIF_INDUSTRY_RSS_FEEDS env var for additional feed URLs,
 * but the primary source_url comes from the regulatory_source row.
 */

import { registerConnector } from '../connector-factory.js';
import type {
  ISourceConnector,
  RegulatorySourceRow,
  RawRegulatoryEvent,
} from '../source-connector.js';
import { parseRssItems } from './ato-rss.js';

class IndustryRssConnector implements ISourceConnector {
  async fetch(source: RegulatorySourceRow): Promise<RawRegulatoryEvent[]> {
    const response = await globalThis.fetch(source.source_url, {
      headers: { 'User-Agent': 'CPA-Platform-RIF/1.0' },
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(`Industry RSS fetch failed: HTTP ${response.status}`);
    }

    const xml = await response.text();
    return parseRssItems(xml, source.source_url);
  }
}

registerConnector('industry_rss', new IndustryRssConnector());

export { IndustryRssConnector };
