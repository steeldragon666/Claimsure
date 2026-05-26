/**
 * End-to-end (in-process) test of the package's public surface.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { searchIpAustralia, IpAustraliaError } from './index.js';

describe('searchIpAustralia', () => {
  test('returns normalised results for a successful trade-mark search', async () => {
    const fakeFetch: typeof globalThis.fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            results: [
              {
                tradeMarkNumber: 2012345,
                words: 'CARBON PROJECT',
                summary: 'Environmental services.',
                applicationDate: '2024-02-14',
                score: 0.92,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

    const out = await searchIpAustralia('carbon project', {
      bearerToken: 'tok',
      fetch: fakeFetch,
    });

    assert.equal(out.length, 1);
    assert.equal(out[0]!.externalId, '2012345');
    assert.equal(out[0]!.title, 'CARBON PROJECT');
    assert.equal(out[0]!.abstract, 'Environmental services.');
    assert.equal(out[0]!.publishedAt, '2024-02-14T00:00:00.000Z');
    assert.equal(out[0]!.url, 'https://search.ipaustralia.gov.au/trademarks/search/view/2012345');
    assert.equal(out[0]!.relevanceScore, 0.92);
  });

  test('propagates IpAustriaError from underlying client (auth)', async () => {
    const fakeFetch: typeof globalThis.fetch = () =>
      Promise.resolve(new Response('', { status: 401 }));

    await assert.rejects(
      () => searchIpAustralia('x', { fetch: fakeFetch }),
      (err: unknown) => err instanceof IpAustraliaError && err.code === 'auth_error',
    );
  });
});
