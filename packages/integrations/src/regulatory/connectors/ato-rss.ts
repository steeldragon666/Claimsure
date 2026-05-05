/**
 * P7 Theme D Task D.13 — ATO RSS feed connector.
 *
 * Fetches the ATO's public RSS feed (e.g. tax alerts, taxpayer alerts)
 * and extracts items as regulatory events. Uses native fetch + basic
 * XML parsing (regex-based -- no XML library dependency).
 */

import { registerConnector } from '../connector-factory.js';
import type {
  ISourceConnector,
  RegulatorySourceRow,
  RawRegulatoryEvent,
} from '../source-connector.js';

class AtoRssConnector implements ISourceConnector {
  async fetch(source: RegulatorySourceRow): Promise<RawRegulatoryEvent[]> {
    const response = await globalThis.fetch(source.source_url, {
      headers: { 'User-Agent': 'CPA-Platform-RIF/1.0' },
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(`ATO RSS fetch failed: HTTP ${response.status}`);
    }

    const xml = await response.text();
    return parseRssItems(xml, source.source_url);
  }
}

/**
 * Parse RSS 2.0 XML into RawRegulatoryEvent[].
 * Uses regex extraction -- sufficient for well-formed RSS feeds.
 */
export function parseRssItems(xml: string, sourceUrl: string): RawRegulatoryEvent[] {
  const events: RawRegulatoryEvent[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1]!;
    const title = extractTag(itemXml, 'title');
    const description = extractTag(itemXml, 'description');
    const link = extractTag(itemXml, 'link');
    const pubDate = extractTag(itemXml, 'pubDate');
    const guid = extractTag(itemXml, 'guid') || link;

    if (!title || !guid) continue;

    events.push({
      external_id: guid,
      raw_title: decodeHtmlEntities(title),
      raw_content: decodeHtmlEntities(stripHtml(description || '')),
      published_at: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
      source_url: link || sourceUrl,
    });
  }

  return events;
}

function extractTag(xml: string, tag: string): string | null {
  // Handle CDATA sections
  const cdataRegex = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, 'i');
  const cdataMatch = xml.match(cdataRegex);
  if (cdataMatch) return cdataMatch[1]!.trim();

  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1]!.trim() : null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

registerConnector('rss', new AtoRssConnector());

export { AtoRssConnector };
