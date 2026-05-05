/**
 * P7 Theme D Task D.13 — AustLII HTML connector for AAT/ART decisions.
 *
 * Scrapes the AustLII recent decisions page, extracts case links,
 * and filters for R&D Tax Incentive relevance using keyword matching.
 */

import { registerConnector } from '../connector-factory.js';
import type {
  ISourceConnector,
  RegulatorySourceRow,
  RawRegulatoryEvent,
} from '../source-connector.js';

class AustliiHtmlConnector implements ISourceConnector {
  async fetch(source: RegulatorySourceRow): Promise<RawRegulatoryEvent[]> {
    const response = await globalThis.fetch(source.source_url, {
      headers: { 'User-Agent': 'CPA-Platform-RIF/1.0' },
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(`AustLII fetch failed: HTTP ${response.status}`);
    }

    const html = await response.text();
    return parseAustliiDecisions(html, source.source_url);
  }
}

/** R&DTI keyword filter -- only decisions mentioning these terms are relevant. */
const RDTI_KEYWORDS = [
  'r&d',
  'research and development',
  'tax incentive',
  'section 355',
  's 355',
  's355',
  'innovation australia',
  'core activity',
  'supporting activity',
  'expenditure notional deduction',
];

/**
 * Parse AustLII decision listing HTML.
 * Extracts linked decisions and filters for R&DTI relevance.
 */
export function parseAustliiDecisions(html: string, baseUrl: string): RawRegulatoryEvent[] {
  const events: RawRegulatoryEvent[] = [];

  // AustLII lists decisions as <li> elements with <a href="...">Title [date]</a>
  // Use [\s\S] for content to handle multi-line HTML formatting.
  const linkRegex = /<li[^>]*>\s*<a\s+href="([^"]*)"[\s\S]*?>([\s\S]*?)<\/a\s*>/gi;
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1]!;
    const rawText = match[2]!.replace(/\s+/g, ' ').trim();
    const titleText = decodeHtmlEntities(rawText);

    // Extract year from title if present (format: [2025] AATA 123)
    const dateMatch = titleText.match(/\[(\d{4})\]/);
    const year = dateMatch ? parseInt(dateMatch[1]!, 10) : new Date().getUTCFullYear();

    // Check R&DTI relevance via keywords in title
    const lowerTitle = titleText.toLowerCase();
    const isRelevant = RDTI_KEYWORDS.some((kw) => lowerTitle.includes(kw));
    if (!isRelevant) continue;

    const fullUrl = href.startsWith('http') ? href : new URL(href, baseUrl).toString();

    events.push({
      external_id: href,
      raw_title: titleText,
      raw_content: titleText, // Full content fetched on classification, not on list scrape
      published_at: new Date(Date.UTC(year, 0, 1)).toISOString(),
      source_url: fullUrl,
    });
  }

  return events;
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

registerConnector('austlii_html', new AustliiHtmlConnector());

export { AustliiHtmlConnector };
