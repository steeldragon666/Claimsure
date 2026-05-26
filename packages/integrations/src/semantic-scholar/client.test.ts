/**
 * Wizard Step 2 Task 03 — searchSemanticScholar tests.
 *
 * Covers normalisation, query/limit validation, retry/backoff, Retry-After
 * handling, and typed-error classification without any real network calls.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { searchSemanticScholar } from './client.js';
import { SemanticScholarError } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function rawTextResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

describe('searchSemanticScholar normalisation', () => {
  test('maps API record to normalised SemanticScholarResult', async () => {
    const apiBody = {
      total: 1,
      data: [
        {
          paperId: 'abc123',
          externalIds: { DOI: '10.1234/foo' },
          title: '  Quantum entanglement of photons  ',
          abstract: '  Some abstract text.  ',
          year: 2023,
          url: 'https://www.semanticscholar.org/paper/abc123',
          citationCount: 42,
        },
      ],
    };
    globalThis.fetch = () => Promise.resolve(jsonResponse(apiBody));

    const results = await searchSemanticScholar('quantum');
    assert.equal(results.length, 1);
    assert.deepEqual(results[0], {
      externalId: 'DOI:10.1234/foo',
      title: 'Quantum entanglement of photons',
      abstract: 'Some abstract text.',
      publishedAt: '2023-01-01',
      url: 'https://www.semanticscholar.org/paper/abc123',
      citationCount: 42,
    });
  });

  test('falls back to paperId when DOI is absent', async () => {
    const apiBody = {
      data: [{ paperId: 'p-1', externalIds: {}, title: 'Paper One', year: 2020 }],
    };
    globalThis.fetch = () => Promise.resolve(jsonResponse(apiBody));

    const [r] = await searchSemanticScholar('foo');
    assert.equal(r!.externalId, 'p-1');
    assert.equal(r!.url, 'https://www.semanticscholar.org/paper/p-1');
  });

  test('returns null abstract and publishedAt when missing', async () => {
    const apiBody = {
      data: [{ paperId: 'p-2', title: 'Untitled-ish', externalIds: { DOI: '10.1/x' } }],
    };
    globalThis.fetch = () => Promise.resolve(jsonResponse(apiBody));

    const [r] = await searchSemanticScholar('foo');
    assert.equal(r!.abstract, null);
    assert.equal(r!.publishedAt, null);
    assert.equal('citationCount' in r!, false);
  });

  test('drops records missing title or identifier', async () => {
    const apiBody = {
      data: [
        { paperId: 'p-a', title: '', externalIds: { DOI: '10.1/a' } },
        { paperId: 'p-b', title: 'Good', externalIds: { DOI: '10.1/b' } },
        { title: 'No id', externalIds: {} },
      ],
    };
    globalThis.fetch = () => Promise.resolve(jsonResponse(apiBody));

    const results = await searchSemanticScholar('foo');
    assert.equal(results.length, 1);
    assert.equal(results[0]!.title, 'Good');
  });

  test('returns empty array on empty data', async () => {
    globalThis.fetch = () => Promise.resolve(jsonResponse({ data: [] }));
    const results = await searchSemanticScholar('foo');
    assert.deepEqual(results, []);
  });
});

// ---------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------

describe('searchSemanticScholar request', () => {
  test('sends query, limit, and fields params', async () => {
    let capturedUrl = '';
    globalThis.fetch = ((url: string | URL) => {
      capturedUrl = url.toString();
      return Promise.resolve(jsonResponse({ data: [] }));
    }) as typeof globalThis.fetch;

    await searchSemanticScholar('crispr gene editing', { limit: 5 });
    const u = new URL(capturedUrl);
    assert.equal(u.origin + u.pathname, 'https://api.semanticscholar.org/graph/v1/paper/search');
    assert.equal(u.searchParams.get('query'), 'crispr gene editing');
    assert.equal(u.searchParams.get('limit'), '5');
    assert.ok(u.searchParams.get('fields')!.includes('citationCount'));
  });

  test('clamps limit above 100 to 100', async () => {
    let capturedUrl = '';
    globalThis.fetch = ((url: string | URL) => {
      capturedUrl = url.toString();
      return Promise.resolve(jsonResponse({ data: [] }));
    }) as typeof globalThis.fetch;

    await searchSemanticScholar('foo', { limit: 500 });
    assert.equal(new URL(capturedUrl).searchParams.get('limit'), '100');
  });

  test('sends x-api-key when apiKey is provided', async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = ((_url: string | URL, init?: RequestInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return Promise.resolve(jsonResponse({ data: [] }));
    }) as typeof globalThis.fetch;

    await searchSemanticScholar('foo', { apiKey: 'secret-123' });
    assert.equal(capturedHeaders['x-api-key'], 'secret-123');
  });

  test('omits x-api-key when no apiKey is provided', async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = ((_url: string | URL, init?: RequestInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return Promise.resolve(jsonResponse({ data: [] }));
    }) as typeof globalThis.fetch;

    await searchSemanticScholar('foo');
    assert.equal('x-api-key' in capturedHeaders, false);
  });

  test('uses caller-supplied fetchImpl when provided', async () => {
    let called = false;
    const customFetch = ((..._args: unknown[]) => {
      called = true;
      return Promise.resolve(jsonResponse({ data: [] }));
    }) as typeof globalThis.fetch;

    // globalThis.fetch points at original — must not be called.
    globalThis.fetch = () => {
      throw new Error('global fetch should not be called');
    };

    await searchSemanticScholar('foo', { fetchImpl: customFetch });
    assert.equal(called, true);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('searchSemanticScholar validation', () => {
  test('rejects empty query without network call', async () => {
    let called = false;
    globalThis.fetch = () => {
      called = true;
      return Promise.resolve(jsonResponse({ data: [] }));
    };

    await assert.rejects(
      () => searchSemanticScholar('   '),
      (err: unknown) => err instanceof SemanticScholarError && err.kind === 'bad_request',
    );
    assert.equal(called, false);
  });

  test('rejects non-positive limit', async () => {
    await assert.rejects(
      () => searchSemanticScholar('foo', { limit: 0 }),
      (err: unknown) => err instanceof SemanticScholarError && err.kind === 'bad_request',
    );
  });
});

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

describe('searchSemanticScholar error classification', () => {
  test('401 maps to auth_error (key required when no key)', async () => {
    globalThis.fetch = () => Promise.resolve(jsonResponse({}, 401));
    await assert.rejects(
      () => searchSemanticScholar('foo'),
      (err: unknown) =>
        err instanceof SemanticScholarError &&
        err.kind === 'auth_error' &&
        err.status === 401 &&
        err.message.includes('required'),
    );
  });

  test('403 maps to auth_error (key rejected when key provided)', async () => {
    globalThis.fetch = () => Promise.resolve(jsonResponse({}, 403));
    await assert.rejects(
      () => searchSemanticScholar('foo', { apiKey: 'bad' }),
      (err: unknown) =>
        err instanceof SemanticScholarError &&
        err.kind === 'auth_error' &&
        err.message.includes('rejected'),
    );
  });

  test('400 maps to bad_request', async () => {
    globalThis.fetch = () => Promise.resolve(jsonResponse({}, 400));
    await assert.rejects(
      () => searchSemanticScholar('foo'),
      (err: unknown) => err instanceof SemanticScholarError && err.kind === 'bad_request',
    );
  });

  test('429 retries then surfaces rate_limited after exhaustion', async () => {
    let calls = 0;
    globalThis.fetch = () => {
      calls++;
      return Promise.resolve(jsonResponse({}, 429, { 'retry-after': '0' }));
    };
    await assert.rejects(
      () => searchSemanticScholar('foo'),
      (err: unknown) =>
        err instanceof SemanticScholarError && err.kind === 'rate_limited' && err.status === 429,
    );
    assert.equal(calls, 3);
  });

  test('invalid JSON body maps to parse_error', async () => {
    globalThis.fetch = () => Promise.resolve(rawTextResponse('not-json{'));
    await assert.rejects(
      () => searchSemanticScholar('foo'),
      (err: unknown) => err instanceof SemanticScholarError && err.kind === 'parse_error',
    );
  });

  test('missing data array on 200 maps to parse_error', async () => {
    globalThis.fetch = () => Promise.resolve(jsonResponse({ total: 0 }));
    await assert.rejects(
      () => searchSemanticScholar('foo'),
      (err: unknown) => err instanceof SemanticScholarError && err.kind === 'parse_error',
    );
  });

  test('5xx retried then surfaced as network_error', async () => {
    let calls = 0;
    globalThis.fetch = () => {
      calls++;
      return Promise.resolve(jsonResponse({}, 503));
    };
    await assert.rejects(
      () => searchSemanticScholar('foo'),
      (err: unknown) =>
        err instanceof SemanticScholarError && err.kind === 'network_error' && err.status === 503,
    );
    assert.equal(calls, 3);
  });

  test('5xx then 200 succeeds after retry', async () => {
    let calls = 0;
    globalThis.fetch = () => {
      calls++;
      if (calls < 2) return Promise.resolve(jsonResponse({}, 500));
      return Promise.resolve(jsonResponse({ data: [] }));
    };

    const results = await searchSemanticScholar('foo');
    assert.deepEqual(results, []);
    assert.equal(calls, 2);
  });

  test('transport error retried then surfaced as network_error', async () => {
    let calls = 0;
    globalThis.fetch = () => {
      calls++;
      return Promise.reject(new Error('ECONNRESET'));
    };
    await assert.rejects(
      () => searchSemanticScholar('foo'),
      (err: unknown) => err instanceof SemanticScholarError && err.kind === 'network_error',
    );
    assert.equal(calls, 3);
  });

  test('non-retryable 4xx surfaces as network_error with status', async () => {
    globalThis.fetch = () => Promise.resolve(jsonResponse({}, 410));
    await assert.rejects(
      () => searchSemanticScholar('foo'),
      (err: unknown) =>
        err instanceof SemanticScholarError && err.kind === 'network_error' && err.status === 410,
    );
  });
});

// ---------------------------------------------------------------------------
// Abort handling
// ---------------------------------------------------------------------------

describe('searchSemanticScholar abort', () => {
  test('caller AbortSignal rejects immediately when pre-aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    globalThis.fetch = () => Promise.resolve(jsonResponse({ data: [] }));
    await assert.rejects(
      () => searchSemanticScholar('foo', { signal: ac.signal }),
      (err: unknown) => err instanceof SemanticScholarError && err.kind === 'network_error',
    );
  });
});
