import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import nock from 'nock';
import { parsePubMedDate, searchPubMed } from './client.js';
import { PubMedError } from './types.js';

beforeEach(() => {
  nock.cleanAll();
});

after(() => {
  nock.cleanAll();
});

const EUTILS_HOST = 'https://eutils.ncbi.nlm.nih.gov';
const ESEARCH_PATH = '/entrez/eutils/esearch.fcgi';
const ESUMMARY_PATH = '/entrez/eutils/esummary.fcgi';

const esearchResp = (idlist: string[]) => ({
  esearchresult: { idlist, count: String(idlist.length) },
});

const esummaryResp = (
  records: Array<{ uid: string; title: string; sortpubdate?: string; pubdate?: string }>,
) => ({
  result: {
    uids: records.map((r) => r.uid),
    ...Object.fromEntries(records.map((r) => [r.uid, r])),
  },
});

test('searchPubMed: two-step happy path returns normalized results in relevance order', async () => {
  nock(EUTILS_HOST)
    .get(ESEARCH_PATH)
    .query({
      db: 'pubmed',
      term: 'crispr cas9',
      retmode: 'json',
      retmax: '20',
    })
    .reply(200, esearchResp(['111', '222', '333']));

  nock(EUTILS_HOST)
    .get(ESUMMARY_PATH)
    .query({
      db: 'pubmed',
      id: '111,222,333',
      retmode: 'json',
    })
    .reply(
      200,
      esummaryResp([
        { uid: '111', title: 'First', sortpubdate: '2024/01/15 00:00' },
        { uid: '222', title: 'Second', sortpubdate: '2023/06/01 00:00' },
        { uid: '333', title: 'Third', sortpubdate: '2022/12/31 00:00' },
      ]),
    );

  const results = await searchPubMed('crispr cas9');
  assert.equal(results.length, 3);
  assert.equal(results[0].externalId, '111');
  assert.equal(results[0].title, 'First');
  assert.equal(results[0].publishedAt, '2024-01-15');
  assert.equal(results[0].url, 'https://pubmed.ncbi.nlm.nih.gov/111/');
  assert.equal(results[0].abstract, undefined);
  assert.equal(results[0].relevanceScore, undefined);
  // Order preserved from ESearch even if ESummary re-orders
  assert.deepEqual(
    results.map((r) => r.externalId),
    ['111', '222', '333'],
  );
});

test('searchPubMed: apiKey adds api_key to both requests', async () => {
  nock(EUTILS_HOST)
    .get(ESEARCH_PATH)
    .query((q) => q.api_key === 'secret' && q.term === 'cancer')
    .reply(200, esearchResp(['1']));

  nock(EUTILS_HOST)
    .get(ESUMMARY_PATH)
    .query((q) => q.api_key === 'secret' && q.id === '1')
    .reply(200, esummaryResp([{ uid: '1', title: 'T', sortpubdate: '2024/01/01 00:00' }]));

  const results = await searchPubMed('cancer', { apiKey: 'secret' });
  assert.equal(results.length, 1);
});

test('searchPubMed: maxResults overrides retmax', async () => {
  nock(EUTILS_HOST)
    .get(ESEARCH_PATH)
    .query((q) => q.retmax === '5')
    .reply(200, esearchResp(['1']));

  nock(EUTILS_HOST)
    .get(ESUMMARY_PATH)
    .query(true)
    .reply(200, esummaryResp([{ uid: '1', title: 'T', sortpubdate: '2024/01/01 00:00' }]));

  const results = await searchPubMed('q', { maxResults: 5 });
  assert.equal(results.length, 1);
});

test('searchPubMed: empty idlist short-circuits without calling ESummary', async () => {
  nock(EUTILS_HOST).get(ESEARCH_PATH).query(true).reply(200, esearchResp([]));

  // No ESummary mock - if the client called it the test would fail
  // with nock's "no match for request" error.
  const results = await searchPubMed('zzzz-no-matches');
  assert.deepEqual(results, []);
});

test('searchPubMed: falls back to pubdate when sortpubdate absent', async () => {
  nock(EUTILS_HOST)
    .get(ESEARCH_PATH)
    .query(true)
    .reply(200, esearchResp(['1']));
  nock(EUTILS_HOST)
    .get(ESUMMARY_PATH)
    .query(true)
    .reply(200, esummaryResp([{ uid: '1', title: 'X', pubdate: '2021 Mar 04' }]));

  const results = await searchPubMed('q');
  assert.equal(results[0].publishedAt, '2021-03-04');
});

test('searchPubMed: ESearch 5xx throws upstream_error after exhausting retries', async () => {
  // 3 attempts total — register 3 503 responses.
  nock(EUTILS_HOST).get(ESEARCH_PATH).query(true).times(3).reply(503, 'service_unavailable');

  await assert.rejects(searchPubMed('q'), (err: unknown) => {
    assert.ok(err instanceof PubMedError);
    assert.equal(err.code, 'upstream_error');
    assert.equal(err.statusCode, 503);
    assert.match(err.message, /pubmed: 503 service_unavailable/);
    return true;
  });
});

test('searchPubMed: ESearch 429 throws rate_limited after exhausting retries', async () => {
  nock(EUTILS_HOST).get(ESEARCH_PATH).query(true).times(3).reply(429, 'too_many');

  await assert.rejects(searchPubMed('q'), (err: unknown) => {
    assert.ok(err instanceof PubMedError);
    assert.equal(err.code, 'rate_limited');
    assert.equal(err.statusCode, 429);
    return true;
  });
});

test('searchPubMed: ESummary failure throws after successful ESearch', async () => {
  nock(EUTILS_HOST)
    .get(ESEARCH_PATH)
    .query(true)
    .reply(200, esearchResp(['1']));
  // ESummary fails on all 3 attempts.
  nock(EUTILS_HOST).get(ESUMMARY_PATH).query(true).times(3).reply(500, 'boom');

  await assert.rejects(searchPubMed('q'), (err: unknown) => {
    assert.ok(err instanceof PubMedError);
    assert.equal(err.code, 'upstream_error');
    assert.equal(err.statusCode, 500);
    return true;
  });
});

test('searchPubMed: respects custom baseUrl', async () => {
  nock('https://eutils.example.test')
    .get('/entrez/eutils/esearch.fcgi')
    .query(true)
    .reply(200, esearchResp(['9']));
  nock('https://eutils.example.test')
    .get('/entrez/eutils/esummary.fcgi')
    .query(true)
    .reply(200, esummaryResp([{ uid: '9', title: 'Mirror', sortpubdate: '2020/05/05 00:00' }]));

  const results = await searchPubMed('q', {
    baseUrl: 'https://eutils.example.test/entrez/eutils',
  });
  assert.equal(results[0].title, 'Mirror');
});

test('searchPubMed: drops records ESummary did not return', async () => {
  nock(EUTILS_HOST)
    .get(ESEARCH_PATH)
    .query(true)
    .reply(200, esearchResp(['1', '2', '3']));
  // ESummary only returns records for 1 and 3
  nock(EUTILS_HOST)
    .get(ESUMMARY_PATH)
    .query(true)
    .reply(
      200,
      esummaryResp([
        { uid: '1', title: 'One', sortpubdate: '2024/01/01 00:00' },
        { uid: '3', title: 'Three', sortpubdate: '2024/01/03 00:00' },
      ]),
    );

  const results = await searchPubMed('q');
  assert.deepEqual(
    results.map((r) => r.externalId),
    ['1', '3'],
  );
});

test('parsePubMedDate: sortpubdate YYYY/MM/DD HH:MM', () => {
  assert.equal(parsePubMedDate('2024/01/15 00:00'), '2024-01-15');
});

test('parsePubMedDate: pubdate "YYYY Mon DD"', () => {
  assert.equal(parsePubMedDate('2024 Jan 15'), '2024-01-15');
});

test('parsePubMedDate: pubdate "YYYY Mon" defaults day to 01', () => {
  assert.equal(parsePubMedDate('2024 Jan'), '2024-01-01');
});

test('parsePubMedDate: pubdate "YYYY" only defaults month + day to 01', () => {
  assert.equal(parsePubMedDate('2024'), '2024-01-01');
});

test('parsePubMedDate: pubdate "YYYY Season" defaults to 01-01', () => {
  assert.equal(parsePubMedDate('2024 Spring'), '2024-01-01');
});

test('parsePubMedDate: undefined / empty / unparseable -> empty string', () => {
  assert.equal(parsePubMedDate(undefined), '');
  assert.equal(parsePubMedDate(''), '');
  assert.equal(parsePubMedDate('garbage'), '');
});

// ---------------------------------------------------------------------------
// Resilience tests — AbortController + retry + typed PubMedError.
// ---------------------------------------------------------------------------

test('searchPubMed: retries 429 then succeeds on next attempt', async () => {
  // First ESearch attempt returns 429, second succeeds.
  nock(EUTILS_HOST).get(ESEARCH_PATH).query(true).reply(429, 'slow_down');
  nock(EUTILS_HOST)
    .get(ESEARCH_PATH)
    .query(true)
    .reply(200, esearchResp(['1']));
  nock(EUTILS_HOST)
    .get(ESUMMARY_PATH)
    .query(true)
    .reply(200, esummaryResp([{ uid: '1', title: 'OK', sortpubdate: '2024/01/01 00:00' }]));

  const results = await searchPubMed('q');
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'OK');
});

test('searchPubMed: retries 5xx then succeeds', async () => {
  nock(EUTILS_HOST).get(ESEARCH_PATH).query(true).reply(502, 'bad_gateway');
  nock(EUTILS_HOST)
    .get(ESEARCH_PATH)
    .query(true)
    .reply(200, esearchResp(['7']));
  nock(EUTILS_HOST)
    .get(ESUMMARY_PATH)
    .query(true)
    .reply(200, esummaryResp([{ uid: '7', title: 'Recovered', sortpubdate: '2024/02/02 00:00' }]));

  const results = await searchPubMed('q');
  assert.equal(results[0].externalId, '7');
});

test('searchPubMed: retries network error then succeeds', async () => {
  // First call: simulate a network error via nock replyWithError;
  // second call returns success.
  nock(EUTILS_HOST).get(ESEARCH_PATH).query(true).replyWithError({
    code: 'ECONNRESET',
    message: 'socket hang up',
  });
  nock(EUTILS_HOST)
    .get(ESEARCH_PATH)
    .query(true)
    .reply(200, esearchResp(['9']));
  nock(EUTILS_HOST)
    .get(ESUMMARY_PATH)
    .query(true)
    .reply(200, esummaryResp([{ uid: '9', title: 'Net', sortpubdate: '2024/03/03 00:00' }]));

  const results = await searchPubMed('q');
  assert.equal(results[0].externalId, '9');
});

test('searchPubMed: 4xx other than 429 throws http_error immediately (no retry)', async () => {
  // Only one mock — if the client retried, nock would throw "no match".
  nock(EUTILS_HOST).get(ESEARCH_PATH).query(true).reply(400, 'bad_query');

  await assert.rejects(searchPubMed('q'), (err: unknown) => {
    assert.ok(err instanceof PubMedError);
    assert.equal(err.code, 'http_error');
    assert.equal(err.statusCode, 400);
    return true;
  });
});

test('searchPubMed: caller-supplied AbortSignal aborts immediately', async () => {
  // Pre-aborted signal — fetch is never issued.
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(searchPubMed('q', { signal: controller.signal }), (err: unknown) => {
    assert.ok(err instanceof PubMedError);
    assert.equal(err.code, 'timeout');
    return true;
  });
});

test('searchPubMed: caller-supplied AbortSignal aborts mid-flight', async () => {
  // Fetch that never resolves on its own but rejects with AbortError
  // when its signal aborts (mimics real `fetch` semantics).
  const controller = new AbortController();
  const fetchImpl: typeof globalThis.fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      const sig = init?.signal;
      sig?.addEventListener('abort', () => {
        const e = new Error('aborted');
        (e as Error & { name: string }).name = 'AbortError';
        reject(e);
      });
    });
  // Abort shortly after fetch starts; the client's caller-abort
  // propagation should trip the per-attempt controller and surface
  // `timeout`.
  setTimeout(() => controller.abort(), 10);

  await assert.rejects(
    searchPubMed('q', { fetchImpl, signal: controller.signal }),
    (err: unknown) => {
      assert.ok(err instanceof PubMedError);
      assert.equal(err.code, 'timeout');
      return true;
    },
  );
});
