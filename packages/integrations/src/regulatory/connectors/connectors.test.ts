/**
 * P7 Theme D Task D.13 — Fixture-based tests for all source connectors.
 *
 * Tests the pure parsing functions exported by each connector. These are
 * unit tests that do not require network access or a database.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseRssItems } from './ato-rss.js';
import { parseAustliiDecisions } from './austlii-html.js';
import { parseBusinessGovAuPage } from './business-gov-au-html.js';
import { parseIsaPage } from './isa-html.js';

const fixtureDir = resolve(import.meta.dirname ?? '.', '../../../../../tests/fixtures/regulatory');

describe('ATO RSS connector', () => {
  test('parses RSS items from fixture', () => {
    const xml = readFileSync(resolve(fixtureDir, 'ato-rss-sample.xml'), 'utf-8');
    const events = parseRssItems(xml, 'https://www.ato.gov.au');

    assert.equal(events.length, 2);
    assert.equal(
      events[0]!.raw_title,
      'TA 2025/1 - R&D Tax Incentive: Revised expenditure thresholds',
    );
    assert.ok(events[0]!.raw_content.includes('43.5% refundable tax offset'));
    assert.equal(
      events[0]!.external_id,
      'https://www.ato.gov.au/law/view/document?docid=TXA/TA20251/NAT/ATO/00001',
    );
    assert.ok(events[0]!.published_at.startsWith('2025-01-'));
  });

  test('handles CDATA sections', () => {
    const xml = readFileSync(resolve(fixtureDir, 'ato-rss-sample.xml'), 'utf-8');
    const events = parseRssItems(xml, 'https://www.ato.gov.au');
    // First item uses CDATA
    assert.ok(events[0]!.raw_content.length > 0);
    assert.ok(!events[0]!.raw_content.includes('CDATA'));
  });

  test('decodes HTML entities in titles', () => {
    const xml = readFileSync(resolve(fixtureDir, 'ato-rss-sample.xml'), 'utf-8');
    const events = parseRssItems(xml, 'https://www.ato.gov.au');
    assert.ok(events[0]!.raw_title.includes('R&D'));
    assert.ok(!events[0]!.raw_title.includes('&amp;'));
  });

  test('returns empty array for empty feed', () => {
    const xml = '<?xml version="1.0"?><rss><channel></channel></rss>';
    const events = parseRssItems(xml, 'https://www.ato.gov.au');
    assert.equal(events.length, 0);
  });

  test('skips items without title or guid', () => {
    const xml = `
      <rss><channel>
        <item><description>No title here</description></item>
        <item><title>Has title</title><guid>g1</guid></item>
      </channel></rss>
    `;
    const events = parseRssItems(xml, 'https://example.com');
    assert.equal(events.length, 1);
    assert.equal(events[0]!.raw_title, 'Has title');
  });
});

describe('AustLII HTML connector', () => {
  test('parses decisions and filters for R&DTI relevance', () => {
    const html = readFileSync(resolve(fixtureDir, 'austlii-decisions-sample.html'), 'utf-8');
    const events = parseAustliiDecisions(html, 'https://www.austlii.edu.au');

    // Should filter out the Smith v Commissioner (no R&DTI keywords)
    assert.equal(events.length, 2);
    assert.ok(events[0]!.raw_title.includes('Innovation Corp'));
    assert.ok(events[1]!.raw_title.includes('Tech Solutions'));
  });

  test('constructs full URLs from relative hrefs', () => {
    const html = readFileSync(resolve(fixtureDir, 'austlii-decisions-sample.html'), 'utf-8');
    const events = parseAustliiDecisions(html, 'https://www.austlii.edu.au');
    assert.ok(events[0]!.source_url!.startsWith('https://www.austlii.edu.au'));
  });

  test('extracts year from case citation', () => {
    const html = readFileSync(resolve(fixtureDir, 'austlii-decisions-sample.html'), 'utf-8');
    const events = parseAustliiDecisions(html, 'https://www.austlii.edu.au');
    assert.ok(events[0]!.published_at.startsWith('2025-'));
  });

  test('returns empty array for page with no relevant decisions', () => {
    const html =
      '<html><body><ul><li><a href="/x">Smith v Tax [2025] - income</a></li></ul></body></html>';
    const events = parseAustliiDecisions(html, 'https://www.austlii.edu.au');
    assert.equal(events.length, 0);
  });
});

describe('Industry RSS connector', () => {
  test('reuses parseRssItems for standard RSS', () => {
    const xml = readFileSync(resolve(fixtureDir, 'industry-rss-sample.xml'), 'utf-8');
    const events = parseRssItems(xml, 'https://www.rsm.global/australia');

    assert.equal(events.length, 1);
    assert.ok(events[0]!.raw_title.includes('R&D Tax Incentive'));
    assert.equal(events[0]!.external_id, 'rsm-rd-fy2025-001');
  });
});

describe('business.gov.au HTML connector', () => {
  test('returns empty array for page with no articles', () => {
    const events = parseBusinessGovAuPage(
      '<html><body>No articles</body></html>',
      'https://business.gov.au',
    );
    assert.equal(events.length, 0);
  });

  test('extracts article with time element', () => {
    const html = `
      <html><body>
        <article>
          <h3><a href="/grants/rdti-update">R&D Tax Incentive Update</a></h3>
          <time datetime="2025-03-01">1 March 2025</time>
          <p class="summary">Important changes to R&DTI eligibility criteria.</p>
        </article>
      </body></html>
    `;
    const events = parseBusinessGovAuPage(html, 'https://business.gov.au');
    assert.equal(events.length, 1);
    assert.equal(events[0]!.raw_title, 'R&D Tax Incentive Update');
    assert.ok(events[0]!.published_at.startsWith('2025-03-01'));
    assert.equal(events[0]!.raw_content, 'Important changes to R&DTI eligibility criteria.');
  });

  test('constructs full URL from relative href', () => {
    const html = `
      <html><body>
        <article>
          <a href="/programs/rdti">RDTI Program</a>
        </article>
      </body></html>
    `;
    const events = parseBusinessGovAuPage(html, 'https://business.gov.au');
    assert.equal(events.length, 1);
    assert.equal(events[0]!.source_url, 'https://business.gov.au/programs/rdti');
  });
});

describe('ISA HTML connector', () => {
  test('returns empty array for page with no views-row items', () => {
    const events = parseIsaPage(
      '<html><body>No items</body></html>',
      'https://www.industry.gov.au',
    );
    assert.equal(events.length, 0);
  });

  test('extracts items from views-row divs', () => {
    const html = `
      <html><body>
        <div class="views-row views-row-1">
          <a href="/publications/isa-review-2025">ISA Annual Review 2025</a>
          <time datetime="2025-06-15">15 June 2025</time>
          <p>A comprehensive review of innovation policy outcomes.</p>
        </div>
      </body></html>
    `;
    const events = parseIsaPage(html, 'https://www.industry.gov.au');
    assert.equal(events.length, 1);
    assert.equal(events[0]!.raw_title, 'ISA Annual Review 2025');
    assert.ok(events[0]!.published_at.startsWith('2025-06-15'));
    assert.equal(events[0]!.raw_content, 'A comprehensive review of innovation policy outcomes.');
  });
});
