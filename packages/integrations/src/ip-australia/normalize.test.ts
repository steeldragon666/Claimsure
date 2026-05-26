/**
 * Tests for the upstream → IpAustraliaResult normaliser. No network.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQuickSearch } from './normalize.js';

describe('normalizeQuickSearch — trade marks', () => {
  test('extracts the `results` wrapper and produces deep links', () => {
    const payload = {
      results: [
        {
          tradeMarkNumber: 2012345,
          words: 'CARBON PROJECT',
          summary: 'Mark for environmental services.',
          applicationDate: '2024-02-14',
          score: 0.87,
        },
      ],
    };

    const out = normalizeQuickSearch(payload, 'trademark');

    assert.equal(out.length, 1);
    const row = out[0]!;
    assert.equal(row.externalId, '2012345');
    assert.equal(row.title, 'CARBON PROJECT');
    assert.equal(row.abstract, 'Mark for environmental services.');
    assert.equal(row.publishedAt, '2024-02-14T00:00:00.000Z');
    assert.equal(row.url, 'https://search.ipaustralia.gov.au/trademarks/search/view/2012345');
    assert.equal(row.relevanceScore, 0.87);
  });

  test('falls back to data.records wrapper', () => {
    const payload = {
      data: {
        records: [
          { tradeMarkNumber: 1, words: 'Alpha', applicationDate: '2020-01-01' },
          { tradeMarkNumber: 2, words: 'Beta', applicationDate: '2021-06-30' },
        ],
      },
    };
    const out = normalizeQuickSearch(payload, 'trademark');
    assert.equal(out.length, 2);
    assert.equal(out[0]!.title, 'Alpha');
    assert.equal(out[1]!.title, 'Beta');
  });

  test('skips rows missing an identifier or title', () => {
    const payload = {
      results: [
        { tradeMarkNumber: 100 }, // no title
        { words: 'No id mark' }, // no id
        { tradeMarkNumber: 200, words: 'Valid', applicationDate: 'not-a-date' },
      ],
    };
    const out = normalizeQuickSearch(payload, 'trademark');
    assert.equal(out.length, 1);
    assert.equal(out[0]!.externalId, '200');
    assert.equal(out[0]!.publishedAt, null);
  });

  test('treats a bare array as the row list', () => {
    const payload = [{ tradeMarkNumber: 9, words: 'Bare' }];
    const out = normalizeQuickSearch(payload, 'trademark');
    assert.equal(out.length, 1);
    assert.equal(out[0]!.externalId, '9');
  });

  test('normalises 0..100 scores into 0..1', () => {
    const payload = {
      results: [{ tradeMarkNumber: 1, words: 'A', score: 85 }],
    };
    const out = normalizeQuickSearch(payload, 'trademark');
    assert.equal(out[0]!.relevanceScore, 0.85);
  });

  test('omits relevanceScore when upstream does not provide one', () => {
    const payload = {
      results: [{ tradeMarkNumber: 1, words: 'A' }],
    };
    const out = normalizeQuickSearch(payload, 'trademark');
    assert.equal('relevanceScore' in out[0]!, false);
  });

  test('returns empty array for unknown payload shapes', () => {
    assert.deepEqual(normalizeQuickSearch(null, 'trademark'), []);
    assert.deepEqual(normalizeQuickSearch(42, 'trademark'), []);
    assert.deepEqual(normalizeQuickSearch({ foo: 'bar' }, 'trademark'), []);
  });
});

describe('normalizeQuickSearch — patents', () => {
  test('uses the patent portal URL', () => {
    const payload = {
      results: [
        {
          patentNumber: 'AU2023123456',
          title: 'Method for low-emission concrete production',
          abstract: 'A novel binder formulation...',
          filingDate: '2023-08-12T00:00:00Z',
        },
      ],
    };
    const out = normalizeQuickSearch(payload, 'patent');
    assert.equal(out.length, 1);
    assert.equal(out[0]!.externalId, 'AU2023123456');
    assert.equal(out[0]!.url, 'https://search.ipaustralia.gov.au/patents/search/view/AU2023123456');
    assert.equal(out[0]!.title, 'Method for low-emission concrete production');
  });
});
