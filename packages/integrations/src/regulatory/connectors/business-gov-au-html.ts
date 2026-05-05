/**
 * P7 Theme D Task D.13 — business.gov.au HTML connector.
 *
 * Scrapes the business.gov.au news/grants page for R&D Tax Incentive
 * program changes, DISR announcements, and related updates.
 */

import { registerConnector } from '../connector-factory.js';
import type {
  ISourceConnector,
  RegulatorySourceRow,
  RawRegulatoryEvent,
} from '../source-connector.js';

class BusinessGovAuHtmlConnector implements ISourceConnector {
  async fetch(source: RegulatorySourceRow): Promise<RawRegulatoryEvent[]> {
    const response = await globalThis.fetch(source.source_url, {
      headers: { 'User-Agent': 'CPA-Platform-RIF/1.0' },
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(`business.gov.au fetch failed: HTTP ${response.status}`);
    }

    const html = await response.text();
    return parseBusinessGovAuPage(html, source.source_url);
  }
}

/**
 * Parse business.gov.au listing page for news/grant items.
 * The site uses article cards with h3 titles and date metadata.
 */
export function parseBusinessGovAuPage(html: string, baseUrl: string): RawRegulatoryEvent[] {
  const events: RawRegulatoryEvent[] = [];

  // Pattern: <article> blocks with link + title inside, and <time> for dates
  const articleRegex = /<article[^>]*>([\s\S]*?)<\/article>/gi;
  let match: RegExpExecArray | null;

  while ((match = articleRegex.exec(html)) !== null) {
    const articleHtml = match[1]!;

    // Extract link and title
    const linkMatch = articleHtml.match(/<a\s+href="([^"]+)"[^>]*>([^<]+)<\/a>/i);
    if (!linkMatch) continue;

    const href = linkMatch[1]!;
    const title = linkMatch[2]!.trim();

    // Extract date
    const timeMatch = articleHtml.match(/<time[^>]*datetime="([^"]+)"[^>]*>/i);
    const publishedAt = timeMatch
      ? new Date(timeMatch[1]!).toISOString()
      : new Date().toISOString();

    // Extract description/summary if present
    const descMatch = articleHtml.match(/<p[^>]*class="[^"]*summary[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
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

registerConnector('business_gov_au_html', new BusinessGovAuHtmlConnector());

export { BusinessGovAuHtmlConnector };
