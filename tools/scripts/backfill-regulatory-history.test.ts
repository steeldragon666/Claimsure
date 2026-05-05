/**
 * D.14 -- Historical backfill script tests.
 *
 * Pure unit tests for URL generation, flag parsing, and parser
 * integration. Does NOT require DB or Anthropic API.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildAustliiYearUrls, parseFlags } from './backfill-regulatory-history.js';
import { parseAustliiDecisions } from '../../packages/integrations/src/regulatory/connectors/austlii-html.js';
import { parseRssItems } from '../../packages/integrations/src/regulatory/connectors/ato-rss.js';

/* ------------------------------------------------------------------ */
/*  Flag parsing                                                       */
/* ------------------------------------------------------------------ */

describe('parseFlags', () => {
  test('defaults are sensible', () => {
    const flags = parseFlags([]);
    assert.equal(flags.dryRun, false);
    assert.equal(flags.classify, false);
    assert.equal(flags.classifyLimit, 50);
    assert.equal(flags.austliiOnly, false);
    assert.equal(flags.atoOnly, false);
    assert.equal(flags.fromYear, null);
  });

  test('parses --dry-run', () => {
    const flags = parseFlags(['--dry-run']);
    assert.equal(flags.dryRun, true);
  });

  test('parses --classify and --classify-limit', () => {
    const flags = parseFlags(['--classify', '--classify-limit', '25']);
    assert.equal(flags.classify, true);
    assert.equal(flags.classifyLimit, 25);
  });

  test('parses --austlii-only', () => {
    const flags = parseFlags(['--austlii-only']);
    assert.equal(flags.austliiOnly, true);
  });

  test('parses --ato-only', () => {
    const flags = parseFlags(['--ato-only']);
    assert.equal(flags.atoOnly, true);
  });

  test('parses --from-year', () => {
    const flags = parseFlags(['--from-year', '2020']);
    assert.equal(flags.fromYear, 2020);
  });

  test('parses all flags combined', () => {
    const flags = parseFlags([
      '--dry-run',
      '--classify',
      '--classify-limit',
      '10',
      '--austlii-only',
      '--from-year',
      '2022',
    ]);
    assert.equal(flags.dryRun, true);
    assert.equal(flags.classify, true);
    assert.equal(flags.classifyLimit, 10);
    assert.equal(flags.austliiOnly, true);
    assert.equal(flags.fromYear, 2022);
  });
});

/* ------------------------------------------------------------------ */
/*  URL generation                                                     */
/* ------------------------------------------------------------------ */

describe('buildAustliiYearUrls', () => {
  test('generates correct URLs for a range of years', () => {
    const urls = buildAustliiYearUrls(2015, 2017);
    assert.equal(urls.length, 3);
    assert.equal(urls[0], 'https://www.austlii.edu.au/cgi-bin/viewdb/au/cases/cth/AATA/2015/');
    assert.equal(urls[1], 'https://www.austlii.edu.au/cgi-bin/viewdb/au/cases/cth/AATA/2016/');
    assert.equal(urls[2], 'https://www.austlii.edu.au/cgi-bin/viewdb/au/cases/cth/AATA/2017/');
  });

  test('generates single URL for same from/to year', () => {
    const urls = buildAustliiYearUrls(2023, 2023);
    assert.equal(urls.length, 1);
    assert.equal(urls[0], 'https://www.austlii.edu.au/cgi-bin/viewdb/au/cases/cth/AATA/2023/');
  });

  test('generates empty list when from > to', () => {
    const urls = buildAustliiYearUrls(2025, 2020);
    assert.equal(urls.length, 0);
  });

  test('generates URLs from 2015 to current year', () => {
    const currentYear = new Date().getUTCFullYear();
    const urls = buildAustliiYearUrls(2015, currentYear);
    assert.equal(urls.length, currentYear - 2015 + 1);
    assert.ok(urls[0]!.endsWith('/2015/'));
    assert.ok(urls[urls.length - 1]!.endsWith(`/${currentYear}/`));
  });
});

/* ------------------------------------------------------------------ */
/*  AustLII HTML fixture parsing                                       */
/* ------------------------------------------------------------------ */

describe('parseAustliiDecisions (fixture)', () => {
  const fixturePath = resolve(
    import.meta.dirname ?? '.',
    '../../tests/fixtures/regulatory/austlii-decisions-sample.html',
  );
  const html = readFileSync(fixturePath, 'utf-8');
  const baseUrl = 'https://www.austlii.edu.au/cgi-bin/viewdb/au/cases/cth/AATA/2025/';

  test('extracts R&DTI-relevant decisions from fixture', () => {
    const events = parseAustliiDecisions(html, baseUrl);
    // Fixture has 3 decisions, 2 are R&DTI-relevant (the income tax one is not)
    assert.equal(events.length, 2);
  });

  test('first event contains correct title', () => {
    const events = parseAustliiDecisions(html, baseUrl);
    assert.ok(events[0]!.raw_title.includes('Innovation Corp'));
    assert.ok(events[0]!.raw_title.includes('R&D Tax Incentive'));
  });

  test('events have correct external_id from href', () => {
    const events = parseAustliiDecisions(html, baseUrl);
    assert.equal(events[0]!.external_id, '/cgi-bin/viewdoc/au/cases/cth/AATA/2025/100.html');
    assert.equal(events[1]!.external_id, '/cgi-bin/viewdoc/au/cases/cth/AATA/2025/102.html');
  });

  test('events have fully-qualified source_url', () => {
    const events = parseAustliiDecisions(html, baseUrl);
    assert.ok(events[0]!.source_url!.startsWith('https://'));
  });

  test('events have ISO-8601 published_at', () => {
    const events = parseAustliiDecisions(html, baseUrl);
    // Year extracted from title: [2025]
    assert.ok(events[0]!.published_at.startsWith('2025-'));
  });
});

/* ------------------------------------------------------------------ */
/*  ATO RSS fixture parsing                                            */
/* ------------------------------------------------------------------ */

describe('parseRssItems (fixture)', () => {
  const fixturePath = resolve(
    import.meta.dirname ?? '.',
    '../../tests/fixtures/regulatory/ato-rss-sample.xml',
  );
  const xml = readFileSync(fixturePath, 'utf-8');
  const feedUrl = 'https://www.ato.gov.au/rss/taxpayer-alerts.xml';

  test('extracts all items from fixture RSS', () => {
    const events = parseRssItems(xml, feedUrl);
    assert.equal(events.length, 2);
  });

  test('first item has decoded title', () => {
    const events = parseRssItems(xml, feedUrl);
    assert.ok(events[0]!.raw_title.includes('R&D Tax Incentive'));
  });

  test('items have correct external_id from guid', () => {
    const events = parseRssItems(xml, feedUrl);
    assert.ok(events[0]!.external_id.includes('TA20251'));
  });

  test('items have ISO-8601 published_at', () => {
    const events = parseRssItems(xml, feedUrl);
    // pubDate: Mon, 15 Jan 2025 00:00:00 +1100
    const d = new Date(events[0]!.published_at);
    assert.equal(d.getUTCFullYear(), 2025);
  });
});
