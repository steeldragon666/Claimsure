/**
 * Tests for the resilient HTTP client. No real network — all fetches
 * are mocked through the injectable `fetch` option.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { quickSearch, defaultBaseUrl } from './client.js';
import { IpAustraliaError } from './types.js';

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function emptyResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response('', { status, headers });
}

describe('quickSearch — defaults', () => {
  test('targets the trademark production base URL by default', () => {
    assert.equal(
      defaultBaseUrl('trademark'),
      'https://production.api.ipaustralia.gov.au/public/australian-trade-mark-search-api/v1',
    );
    assert.equal(
      defaultBaseUrl('patent'),
      'https://production.api.ipaustralia.gov.au/public/australian-patent-search-api/v1',
    );
  });

  test('rejects empty queries', async () => {
    await assert.rejects(
      () => quickSearch('', { fetch: () => Promise.reject(new Error('should not be called')) }),
      (err: unknown) => err instanceof IpAustraliaError && err.code === 'bad_request',
    );
    await assert.rejects(
      () =>
        quickSearch('   ', {
          fetch: () => Promise.reject(new Error('should not be called')),
        }),
      (err: unknown) => err instanceof IpAustraliaError && err.code === 'bad_request',
    );
  });
});

describe('quickSearch — request shape', () => {
  test('POSTs JSON to /search/quick with Authorization when a token is supplied', async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fakeFetch: typeof globalThis.fetch = (input, init) => {
      capturedUrl = typeof input === 'string' ? input : (input as URL).toString();
      capturedInit = init;
      return Promise.resolve(jsonResponse(200, { results: [] }));
    };

    await quickSearch('carbon', {
      bearerToken: 'tok-123',
      fetch: fakeFetch,
    });

    assert.equal(
      capturedUrl,
      'https://production.api.ipaustralia.gov.au/public/australian-trade-mark-search-api/v1/search/quick',
    );
    assert.equal(capturedInit?.method, 'POST');
    const headers = capturedInit?.headers as Record<string, string>;
    assert.equal(headers['Authorization'], 'Bearer tok-123');
    assert.equal(headers['Content-Type'], 'application/json');
    const body = JSON.parse(capturedInit?.body as string) as Record<string, unknown>;
    assert.equal(body.query, 'carbon');
  });

  test('omits Authorization when no bearer token is supplied', async () => {
    let capturedInit: RequestInit | undefined;
    const fakeFetch: typeof globalThis.fetch = (_input, init) => {
      capturedInit = init;
      return Promise.resolve(jsonResponse(200, { results: [] }));
    };
    await quickSearch('x', { fetch: fakeFetch });
    const headers = capturedInit?.headers as Record<string, string>;
    assert.equal('Authorization' in headers, false);
  });

  test('forwards changedSinceDate when provided', async () => {
    let body: Record<string, unknown> | undefined;
    const fakeFetch: typeof globalThis.fetch = (_input, init) => {
      body = JSON.parse(init?.body as string) as Record<string, unknown>;
      return Promise.resolve(jsonResponse(200, { results: [] }));
    };
    await quickSearch('x', { fetch: fakeFetch, changedSinceDate: '2024-01-01' });
    assert.equal(body?.changedSinceDate, '2024-01-01');
  });

  test('uses the patent base URL when dataset=patent', async () => {
    let capturedUrl: string | undefined;
    const fakeFetch: typeof globalThis.fetch = (input) => {
      capturedUrl = typeof input === 'string' ? input : (input as URL).toString();
      return Promise.resolve(jsonResponse(200, { results: [] }));
    };
    await quickSearch('x', { dataset: 'patent', fetch: fakeFetch });
    assert.match(capturedUrl ?? '', /australian-patent-search-api/);
  });
});

describe('quickSearch — error mapping', () => {
  test('401 → auth_error and is NOT retried', async () => {
    let calls = 0;
    const fakeFetch: typeof globalThis.fetch = () => {
      calls++;
      return Promise.resolve(emptyResponse(401));
    };
    await assert.rejects(
      () => quickSearch('x', { fetch: fakeFetch }),
      (err: unknown) =>
        err instanceof IpAustraliaError && err.code === 'auth_error' && err.status === 401,
    );
    assert.equal(calls, 1);
  });

  test('403 → auth_error and is NOT retried', async () => {
    let calls = 0;
    const fakeFetch: typeof globalThis.fetch = () => {
      calls++;
      return Promise.resolve(emptyResponse(403));
    };
    await assert.rejects(
      () => quickSearch('x', { fetch: fakeFetch }),
      (err: unknown) => err instanceof IpAustraliaError && err.code === 'auth_error',
    );
    assert.equal(calls, 1);
  });

  test('404 → not_found and is NOT retried', async () => {
    let calls = 0;
    const fakeFetch: typeof globalThis.fetch = () => {
      calls++;
      return Promise.resolve(emptyResponse(404));
    };
    await assert.rejects(
      () => quickSearch('x', { fetch: fakeFetch }),
      (err: unknown) => err instanceof IpAustraliaError && err.code === 'not_found',
    );
    assert.equal(calls, 1);
  });

  test('400 → bad_request and is NOT retried', async () => {
    let calls = 0;
    const fakeFetch: typeof globalThis.fetch = () => {
      calls++;
      return Promise.resolve(emptyResponse(400));
    };
    await assert.rejects(
      () => quickSearch('x', { fetch: fakeFetch }),
      (err: unknown) => err instanceof IpAustraliaError && err.code === 'bad_request',
    );
    assert.equal(calls, 1);
  });

  test('parse_error when upstream returns non-JSON 200', async () => {
    const fakeFetch: typeof globalThis.fetch = () =>
      Promise.resolve(
        new Response('<html>nope</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      );
    await assert.rejects(
      () => quickSearch('x', { fetch: fakeFetch }),
      (err: unknown) => err instanceof IpAustraliaError && err.code === 'parse_error',
    );
  });
});

describe('quickSearch — retries and backoff', () => {
  test('retries 500 up to maxRetries+1 attempts then throws upstream_error', async () => {
    let calls = 0;
    const fakeFetch: typeof globalThis.fetch = () => {
      calls++;
      return Promise.resolve(emptyResponse(500));
    };
    await assert.rejects(
      () =>
        quickSearch('x', {
          fetch: fakeFetch,
          maxRetries: 2,
          // Reduce backoff to keep the test fast.
          timeoutMs: 1_000,
        }),
      (err: unknown) =>
        err instanceof IpAustraliaError && err.code === 'upstream_error' && err.attempts === 3,
    );
    assert.equal(calls, 3);
  });

  test('retries 429 then succeeds on the second attempt', async () => {
    let calls = 0;
    const fakeFetch: typeof globalThis.fetch = () => {
      calls++;
      if (calls === 1) return Promise.resolve(emptyResponse(429));
      return Promise.resolve(jsonResponse(200, { results: [{ tradeMarkNumber: 1, words: 'OK' }] }));
    };
    const result = await quickSearch('x', { fetch: fakeFetch, maxRetries: 1 });
    assert.equal(calls, 2);
    assert.deepEqual(result, { results: [{ tradeMarkNumber: 1, words: 'OK' }] });
  });

  test('network error is retried then surfaced as network_error', async () => {
    let calls = 0;
    const fakeFetch: typeof globalThis.fetch = () => {
      calls++;
      return Promise.reject(new Error('ECONNRESET'));
    };
    await assert.rejects(
      () => quickSearch('x', { fetch: fakeFetch, maxRetries: 1 }),
      (err: unknown) =>
        err instanceof IpAustraliaError && err.code === 'network_error' && err.attempts === 2,
    );
    assert.equal(calls, 2);
  });
});
