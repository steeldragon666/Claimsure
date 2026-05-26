import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import nock from 'nock';
import { searchArxiv } from './client.js';
import { ArxivError } from './types.js';

beforeEach(() => {
  nock.cleanAll();
});

after(() => {
  nock.cleanAll();
});

const ARXIV_HOST = 'http://export.arxiv.org';
const QUERY_PATH = '/api/query';

const atomFeed = (
  entries: Array<{
    id: string;
    title: string;
    summary: string;
    published: string;
    alternateUrl?: string;
  }>,
) => {
  const entryXml = entries
    .map(
      (e) => `
  <entry>
    <id>${e.id}</id>
    <title>
      ${e.title}
    </title>
    <summary>
      ${e.summary}
    </summary>
    <published>${e.published}</published>
    <link href="${e.alternateUrl ?? e.id}" rel="alternate" type="text/html"/>
    <link href="${e.id.replace('/abs/', '/pdf/')}" rel="related" type="application/pdf"/>
    <author><name>Some Author</name></author>
  </entry>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>ArXiv Query</title>
  <id>http://arxiv.org/api/abc</id>${entryXml}
</feed>`;
};

const emptyAtomFeed = () => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>ArXiv Query</title>
  <id>http://arxiv.org/api/abc</id>
</feed>`;

test('searchArxiv: happy path returns normalized results', async () => {
  nock(ARXIV_HOST)
    .get(QUERY_PATH)
    .query({
      search_query: 'transformer architecture',
      max_results: '20',
    })
    .reply(
      200,
      atomFeed([
        {
          id: 'http://arxiv.org/abs/2401.12345v2',
          title: 'Attention Is All You Need',
          summary: 'We propose a new architecture for sequence modelling.',
          published: '2024-01-15T18:30:00Z',
          alternateUrl: 'http://arxiv.org/abs/2401.12345v2',
        },
        {
          id: 'http://arxiv.org/abs/2402.99999v1',
          title: 'Follow-up paper',
          summary: 'Extending the previous work to vision.',
          published: '2024-02-20T12:00:00Z',
        },
      ]),
    );

  const results = await searchArxiv('transformer architecture');
  assert.equal(results.length, 2);
  assert.equal(results[0].externalId, '2401.12345');
  assert.equal(results[0].title, 'Attention Is All You Need');
  assert.equal(results[0].abstract, 'We propose a new architecture for sequence modelling.');
  assert.equal(results[0].publishedAt, '2024-01-15T18:30:00Z');
  assert.equal(results[0].url, 'http://arxiv.org/abs/2401.12345v2');
  assert.equal(results[0].relevanceScore, undefined);
  assert.equal(results[1].externalId, '2402.99999');
});

test('searchArxiv: maxResults overrides max_results', async () => {
  nock(ARXIV_HOST)
    .get(QUERY_PATH)
    .query((q) => q.max_results === '5')
    .reply(200, atomFeed([]));

  const results = await searchArxiv('q', { maxResults: 5 });
  assert.deepEqual(results, []);
});

test('searchArxiv: empty feed returns empty array', async () => {
  nock(ARXIV_HOST).get(QUERY_PATH).query(true).reply(200, emptyAtomFeed());

  const results = await searchArxiv('zzz-no-matches');
  assert.deepEqual(results, []);
});

test('searchArxiv: single entry handled (fast-xml-parser singleton -> array)', async () => {
  nock(ARXIV_HOST)
    .get(QUERY_PATH)
    .query(true)
    .reply(
      200,
      atomFeed([
        {
          id: 'http://arxiv.org/abs/2301.00001v1',
          title: 'Only One',
          summary: 'Just one paper.',
          published: '2023-01-01T00:00:00Z',
        },
      ]),
    );

  const results = await searchArxiv('q');
  assert.equal(results.length, 1);
  assert.equal(results[0].externalId, '2301.00001');
});

test('searchArxiv: whitespace collapsed in title and summary', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2401.00002v1</id>
    <title>
      Multi
      line
      title
    </title>
    <summary>
      Multi
      line
      summary
      with    extra   spaces.
    </summary>
    <published>2024-01-01T00:00:00Z</published>
    <link href="http://arxiv.org/abs/2401.00002v1" rel="alternate" type="text/html"/>
  </entry>
</feed>`;
  nock(ARXIV_HOST).get(QUERY_PATH).query(true).reply(200, xml);

  const results = await searchArxiv('q');
  assert.equal(results[0].title, 'Multi line title');
  assert.equal(results[0].abstract, 'Multi line summary with extra spaces.');
});

test('searchArxiv: id without v-suffix is preserved', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2401.00003</id>
    <title>No version</title>
    <summary>...</summary>
    <published>2024-01-01T00:00:00Z</published>
    <link href="http://arxiv.org/abs/2401.00003" rel="alternate" type="text/html"/>
  </entry>
</feed>`;
  nock(ARXIV_HOST).get(QUERY_PATH).query(true).reply(200, xml);

  const results = await searchArxiv('q');
  assert.equal(results[0].externalId, '2401.00003');
});

test('searchArxiv: missing alternate link falls back to constructed /abs/ URL', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2401.00004v1</id>
    <title>No alt link</title>
    <summary>...</summary>
    <published>2024-01-01T00:00:00Z</published>
    <link href="http://arxiv.org/abs/2401.00004v1.pdf" rel="related" type="application/pdf"/>
  </entry>
</feed>`;
  nock(ARXIV_HOST).get(QUERY_PATH).query(true).reply(200, xml);

  const results = await searchArxiv('q');
  assert.equal(results[0].url, 'http://arxiv.org/abs/2401.00004');
});

test('searchArxiv: 5xx throws upstream_error after exhausting retries', async () => {
  nock(ARXIV_HOST).get(QUERY_PATH).query(true).times(3).reply(503, 'service_unavailable');

  await assert.rejects(searchArxiv('q'), (err: unknown) => {
    assert.ok(err instanceof ArxivError);
    assert.equal(err.code, 'upstream_error');
    assert.equal(err.statusCode, 503);
    assert.match(err.message, /arxiv: 503 service_unavailable/);
    return true;
  });
});

test('searchArxiv: 429 throws rate_limited after exhausting retries', async () => {
  nock(ARXIV_HOST).get(QUERY_PATH).query(true).times(3).reply(429, 'rate_limited');

  await assert.rejects(searchArxiv('q'), (err: unknown) => {
    assert.ok(err instanceof ArxivError);
    assert.equal(err.code, 'rate_limited');
    assert.equal(err.statusCode, 429);
    return true;
  });
});

test('searchArxiv: respects custom baseUrl', async () => {
  nock('http://export.example.test')
    .get('/api/query')
    .query(true)
    .reply(
      200,
      atomFeed([
        {
          id: 'http://arxiv.org/abs/9999.99999v1',
          title: 'Mirror',
          summary: 'Mirror summary.',
          published: '2024-01-01T00:00:00Z',
        },
      ]),
    );

  const results = await searchArxiv('q', { baseUrl: 'http://export.example.test/api/query' });
  assert.equal(results[0].title, 'Mirror');
});

// ---------------------------------------------------------------------------
// Resilience tests — AbortController + retry + typed ArxivError.
// ---------------------------------------------------------------------------

test('searchArxiv: retries 429 then succeeds on next attempt', async () => {
  nock(ARXIV_HOST).get(QUERY_PATH).query(true).reply(429, 'slow_down');
  nock(ARXIV_HOST)
    .get(QUERY_PATH)
    .query(true)
    .reply(
      200,
      atomFeed([
        {
          id: 'http://arxiv.org/abs/2401.55555v1',
          title: 'Retried',
          summary: 'Retried summary.',
          published: '2024-01-15T00:00:00Z',
        },
      ]),
    );

  const results = await searchArxiv('q');
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'Retried');
});

test('searchArxiv: retries 5xx then succeeds', async () => {
  nock(ARXIV_HOST).get(QUERY_PATH).query(true).reply(502, 'bad_gateway');
  nock(ARXIV_HOST)
    .get(QUERY_PATH)
    .query(true)
    .reply(
      200,
      atomFeed([
        {
          id: 'http://arxiv.org/abs/2401.66666v1',
          title: 'Recovered',
          summary: 'Recovered summary.',
          published: '2024-02-02T00:00:00Z',
        },
      ]),
    );

  const results = await searchArxiv('q');
  assert.equal(results[0].externalId, '2401.66666');
});

test('searchArxiv: retries network error then succeeds', async () => {
  nock(ARXIV_HOST).get(QUERY_PATH).query(true).replyWithError({
    code: 'ECONNRESET',
    message: 'socket hang up',
  });
  nock(ARXIV_HOST)
    .get(QUERY_PATH)
    .query(true)
    .reply(
      200,
      atomFeed([
        {
          id: 'http://arxiv.org/abs/2401.77777v1',
          title: 'After Reset',
          summary: 'After reset summary.',
          published: '2024-03-03T00:00:00Z',
        },
      ]),
    );

  const results = await searchArxiv('q');
  assert.equal(results[0].externalId, '2401.77777');
});

test('searchArxiv: 4xx other than 429 throws http_error immediately (no retry)', async () => {
  nock(ARXIV_HOST).get(QUERY_PATH).query(true).reply(400, 'bad_request');

  await assert.rejects(searchArxiv('q'), (err: unknown) => {
    assert.ok(err instanceof ArxivError);
    assert.equal(err.code, 'http_error');
    assert.equal(err.statusCode, 400);
    return true;
  });
});

test('searchArxiv: caller-supplied AbortSignal aborts immediately when pre-aborted', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(searchArxiv('q', { signal: controller.signal }), (err: unknown) => {
    assert.ok(err instanceof ArxivError);
    assert.equal(err.code, 'timeout');
    return true;
  });
});

test('searchArxiv: caller-supplied AbortSignal aborts mid-flight', async () => {
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
  setTimeout(() => controller.abort(), 10);

  await assert.rejects(
    searchArxiv('q', { fetchImpl, signal: controller.signal }),
    (err: unknown) => {
      assert.ok(err instanceof ArxivError);
      assert.equal(err.code, 'timeout');
      return true;
    },
  );
});
