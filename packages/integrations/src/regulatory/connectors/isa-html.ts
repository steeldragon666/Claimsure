/**
 * P7 Theme D Task D.13 — Innovation and Science Australia (ISA) HTML connector.
 *
 * Scrapes the ISA publications/findings page for reports, reviews,
 * and findings relevant to R&D Tax Incentive policy.
 */

import { registerConnector } from '../connector-factory.js';
import type {
  ISourceConnector,
  RegulatorySourceRow,
  RawRegulatoryEvent,
} from '../source-connector.js';

class IsaHtmlConnector implements ISourceConnector {
  async fetch(source: RegulatorySourceRow): Promise<RawRegulatoryEvent[]> {
    const response = await globalThis.fetch(source.source_url, {
      headers: { 'User-Agent': 'CPA-Platform-RIF/1.0' },
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(`ISA fetch failed: HTTP ${response.status}`);
    }

    const html = await response.text();
    return parseIsaPage(html, source.source_url);
  }
}

/**
 * Parse ISA publications listing page.
 * Similar structure to government publication pages -- divs with headings and dates.
 */
export function parseIsaPage(html: string, baseUrl: string): RawRegulatoryEvent[] {
  const events: RawRegulatoryEvent[] = [];

  // Pattern: listing items with title links and date text.
  // Matches <div class="views-row ...">...</div> blocks greedily enough
  // to capture inner content (link, date, description).
  const itemRegex = /<div[^>]*class="[^"]*views-row[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(html)) !== null) {
    const itemHtml = match[1]!;

    const linkMatch = itemHtml.match(/<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    const href = linkMatch[1]!;
    const title = linkMatch[2]!.replace(/<[^>]+>/g, '').trim();
    if (!title) continue;

    // Extract date from a <time> or <span class="date"> element
    const dateMatch =
      itemHtml.match(/<time[^>]*datetime="([^"]+)"/) ??
      itemHtml.match(/<span[^>]*class="[^"]*date[^"]*"[^>]*>([^<]+)<\/span>/i);
    const publishedAt = dateMatch
      ? new Date(dateMatch[1]!.trim()).toISOString()
      : new Date().toISOString();

    // Extract description
    const descMatch = itemHtml.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const description = descMatch ? descMatch[1]!.replace(/<[^>]+>/g, '').trim() : title;

    const fullUrl = href.startsWith('http') ? href : new URL(href, baseUrl).toString();

    events.push({
      external_id: href,
      raw_title: title,
      raw_content: description,
      published_at: publishedAt,
      source_url: fullUrl,
    });
  }

  return events;
}

registerConnector('isa_html', new IsaHtmlConnector());

export { IsaHtmlConnector };
