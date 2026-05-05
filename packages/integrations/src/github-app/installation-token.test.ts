import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { _clearTokenCache, getInstallationToken } from './installation-token.js';

// Module-level keypair fixture — see jwt.test.ts. Reused across tests
// so we pay the keygen cost once.
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { format: 'pem', type: 'spki' },
  privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
});

beforeEach(() => {
  _clearTokenCache();
});

function makeFetchMock(
  body: unknown,
  opts: { ok?: boolean; status?: number; statusText?: string } = {},
): typeof globalThis.fetch {
  const ok = opts.ok ?? true;
  const status = opts.status ?? 201;
  const statusText = opts.statusText ?? 'Created';
  return mock.fn(() =>
    Promise.resolve({
      ok,
      status,
      statusText,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    } as unknown as Response),
  );
}

const futureExpiry = (offsetMs = 60 * 60 * 1000): string =>
  new Date(Date.now() + offsetMs).toISOString();

test('getInstallationToken: first call hits network, returns token', async () => {
  const fetchMock = makeFetchMock({ token: 'tok_xyz', expires_at: futureExpiry() });
  const token = await getInstallationToken({
    appId: '123',
    privateKey,
    installationId: 'install-1',
    fetch: fetchMock,
    cacheKey: 'isolated-1',
  });
  assert.equal(token, 'tok_xyz');
  assert.equal((fetchMock as unknown as { mock: { calls: unknown[] } }).mock.calls.length, 1);
});

test('getInstallationToken: caches across calls within TTL (single fetch)', async () => {
  const fetchMock = makeFetchMock({ token: 'tok_xyz', expires_at: futureExpiry() });
  const t1 = await getInstallationToken({
    appId: '123',
    privateKey,
    installationId: 'install-2',
    fetch: fetchMock,
    cacheKey: 'isolated-2',
  });
  const t2 = await getInstallationToken({
    appId: '123',
    privateKey,
    installationId: 'install-2',
    fetch: fetchMock,
    cacheKey: 'isolated-2',
  });
  assert.equal(t1, t2);
  assert.equal((fetchMock as unknown as { mock: { calls: unknown[] } }).mock.calls.length, 1);
});

test('getInstallationToken: cache miss after refreshAt threshold', async () => {
  // Token expires_at is 60 min from "now"; refreshAt = expiresAt - 10 min.
  // Advancing virtual `now` past refreshAt forces a refetch.
  const baseNow = 1_700_000_000_000;
  const expiresAt = new Date(baseNow + 60 * 60 * 1000).toISOString();

  const fetchMock = mock.fn((..._args: unknown[]) =>
    Promise.resolve({
      ok: true,
      status: 201,
      statusText: 'Created',
      json: () =>
        Promise.resolve({
          // Each call returns a new token so we can tell them apart.
          token: `tok_${(fetchMock as unknown as { mock: { calls: unknown[] } }).mock.calls.length}`,
          expires_at: expiresAt,
        }),
      text: () => Promise.resolve(''),
    } as unknown as Response),
  );

  let virtualNow = baseNow;
  const t1 = await getInstallationToken({
    appId: '1',
    privateKey,
    installationId: 'install-3',
    fetch: fetchMock,
    cacheKey: 'isolated-3',
    now: () => virtualNow,
  });

  // Within TTL (5 min later) — should hit cache.
  virtualNow = baseNow + 5 * 60 * 1000;
  const t2 = await getInstallationToken({
    appId: '1',
    privateKey,
    installationId: 'install-3',
    fetch: fetchMock,
    cacheKey: 'isolated-3',
    now: () => virtualNow,
  });
  assert.equal(t2, t1);

  // Past refreshAt (55 min later — refreshAt is at expires - 10 min = 50 min) — refetch.
  virtualNow = baseNow + 55 * 60 * 1000;
  const t3 = await getInstallationToken({
    appId: '1',
    privateKey,
    installationId: 'install-3',
    fetch: fetchMock,
    cacheKey: 'isolated-3',
    now: () => virtualNow,
  });
  assert.notEqual(t3, t1);
  assert.equal((fetchMock as unknown as { mock: { calls: unknown[] } }).mock.calls.length, 2);
});

test('getInstallationToken: different cacheKeys are isolated', async () => {
  const fetchMock = mock.fn((..._args: unknown[]) =>
    Promise.resolve({
      ok: true,
      status: 201,
      statusText: 'Created',
      json: () =>
        Promise.resolve({
          token: `tok_${(fetchMock as unknown as { mock: { calls: unknown[] } }).mock.calls.length}`,
          expires_at: futureExpiry(),
        }),
      text: () => Promise.resolve(''),
    } as unknown as Response),
  );

  const a = await getInstallationToken({
    appId: '1',
    privateKey,
    installationId: 'install-A',
    fetch: fetchMock,
    cacheKey: 'key-A',
  });
  const b = await getInstallationToken({
    appId: '1',
    privateKey,
    installationId: 'install-B',
    fetch: fetchMock,
    cacheKey: 'key-B',
  });
  assert.notEqual(a, b);
  assert.equal((fetchMock as unknown as { mock: { calls: unknown[] } }).mock.calls.length, 2);
});

test('getInstallationToken: non-2xx response throws with status info', async () => {
  const fetchMock = makeFetchMock('integration not found', {
    ok: false,
    status: 404,
    statusText: 'Not Found',
  });
  await assert.rejects(
    () =>
      getInstallationToken({
        appId: '1',
        privateKey,
        installationId: 'install-missing',
        fetch: fetchMock,
        cacheKey: 'isolated-err',
      }),
    /404 Not Found/,
  );
});

test('getInstallationToken: malformed response (missing token) throws', async () => {
  const fetchMock = makeFetchMock({ expires_at: futureExpiry() });
  await assert.rejects(
    () =>
      getInstallationToken({
        appId: '1',
        privateKey,
        installationId: 'install-malformed',
        fetch: fetchMock,
        cacheKey: 'isolated-malformed-1',
      }),
    /malformed response/,
  );
});

test('getInstallationToken: malformed response (missing expires_at) throws', async () => {
  const fetchMock = makeFetchMock({ token: 'tok_xyz' });
  await assert.rejects(
    () =>
      getInstallationToken({
        appId: '1',
        privateKey,
        installationId: 'install-malformed-2',
        fetch: fetchMock,
        cacheKey: 'isolated-malformed-2',
      }),
    /malformed response/,
  );
});

test('getInstallationToken: unparseable expires_at throws', async () => {
  const fetchMock = makeFetchMock({ token: 'tok_xyz', expires_at: 'not-a-date' });
  await assert.rejects(
    () =>
      getInstallationToken({
        appId: '1',
        privateKey,
        installationId: 'install-bad-date',
        fetch: fetchMock,
        cacheKey: 'isolated-bad-date',
      }),
    /unparseable expires_at/,
  );
});

test('getInstallationToken: network error propagates', async () => {
  const fetchMock = mock.fn(() => Promise.reject(new Error('ECONNRESET')));
  await assert.rejects(
    () =>
      getInstallationToken({
        appId: '1',
        privateKey,
        installationId: 'install-network',
        fetch: fetchMock,
        cacheKey: 'isolated-network',
      }),
    /ECONNRESET/,
  );
});

test('getInstallationToken: posts to correct GitHub endpoint with App JWT', async () => {
  let capturedUrl: string | undefined;
  let capturedHeaders: Record<string, string> | undefined;
  const fetchMock = mock.fn((url: unknown, init: unknown) => {
    capturedUrl = url as string;
    capturedHeaders = (init as { headers?: Record<string, string> }).headers;
    return Promise.resolve({
      ok: true,
      status: 201,
      statusText: 'Created',
      json: () => Promise.resolve({ token: 'tok_xyz', expires_at: futureExpiry() }),
      text: () => Promise.resolve(''),
    } as unknown as Response);
  });

  await getInstallationToken({
    appId: '42',
    privateKey,
    installationId: '99887766',
    fetch: fetchMock,
    cacheKey: 'isolated-endpoint',
  });

  assert.equal(capturedUrl, 'https://api.github.com/app/installations/99887766/access_tokens');
  assert.ok(capturedHeaders?.Authorization?.startsWith('Bearer '), 'Bearer auth header');
  assert.equal(capturedHeaders?.Accept, 'application/vnd.github+json');
  assert.equal(capturedHeaders?.['X-GitHub-Api-Version'], '2022-11-28');
});
