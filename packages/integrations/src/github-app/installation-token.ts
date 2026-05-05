import { createAppJwt } from './jwt.js';

/**
 * GitHub App installation-token cache (Task B.2 / P7).
 *
 * GitHub's two-tier auth model:
 *   1. Mint a short-lived App JWT (10-min max) — see `jwt.ts`.
 *   2. Exchange that JWT at `POST /app/installations/:id/access_tokens`
 *      for an installation token (60-min lifetime) scoped to the repos
 *      the App is installed on.
 *
 * Step 2 costs a network round-trip and counts against rate limits, so
 * this module caches per-installation tokens in memory and refreshes
 * them 10 minutes early. The 10-min refresh window is a safety margin:
 * a long-running PR-creation request that snags a near-expiry token at
 * 59m59s would otherwise risk a 401 mid-flight.
 *
 * Cache scope is process-local. Each app instance maintains its own
 * cache; this is intentional — installation tokens are revocable and
 * cheap to remint, so we don't push them into Redis or the DB. If two
 * processes hit GitHub for the same installation within the same
 * minute, we pay one extra `POST` and that's it.
 *
 * Test seams:
 *   - `fetch` parameter for mock injection (avoids live network in
 *     unit tests).
 *   - `cacheKey` parameter for cache isolation between test cases.
 *   - `_clearTokenCache()` for resetting cache between tests.
 */

export interface GetInstallationTokenOptions {
  appId: string;
  privateKey: string;
  installationId: string;
  /** DI seam for tests. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Cache key override; defaults to `installationId`. Tests use this
   *  to keep cache state isolated per test case without flushing the
   *  whole module-level map. */
  cacheKey?: string;
  /** Override `now` for tests. Defaults to `Date.now()`. */
  now?: () => number;
}

interface CachedToken {
  token: string;
  /** Epoch ms at which this cached entry should be considered stale.
   *  Set to `(GitHub's expires_at) - REFRESH_EARLY_MS`. */
  refreshAt: number;
}

const REFRESH_EARLY_MS = 10 * 60 * 1000;

const _cache = new Map<string, CachedToken>();

interface InstallationTokenResponse {
  token: string;
  expires_at: string;
  // …other fields (permissions, repository_selection, etc.) — we don't
  // need them for the cache.
}

export async function getInstallationToken(opts: GetInstallationTokenOptions): Promise<string> {
  const {
    appId,
    privateKey,
    installationId,
    fetch: fetchImpl = globalThis.fetch,
    cacheKey,
    now = Date.now,
  } = opts;

  const key = cacheKey ?? installationId;
  const cached = _cache.get(key);
  if (cached && now() < cached.refreshAt) {
    return cached.token;
  }

  const jwt = createAppJwt({ appId, privateKey, now });

  const url = `https://api.github.com/app/installations/${encodeURIComponent(
    installationId,
  )}/access_tokens`;

  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'cpa-platform-github-app',
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(
      `getInstallationToken: GitHub returned ${res.status} ${res.statusText}: ${body}`,
    );
  }

  const json = (await res.json()) as Partial<InstallationTokenResponse>;
  if (typeof json.token !== 'string' || typeof json.expires_at !== 'string') {
    throw new Error(
      `getInstallationToken: malformed response (missing token or expires_at): ${JSON.stringify(json)}`,
    );
  }

  const expiresAtMs = Date.parse(json.expires_at);
  if (Number.isNaN(expiresAtMs)) {
    throw new Error(`getInstallationToken: unparseable expires_at "${json.expires_at}"`);
  }

  _cache.set(key, {
    token: json.token,
    refreshAt: expiresAtMs - REFRESH_EARLY_MS,
  });

  return json.token;
}

/** Test helper — clears the module-level cache. Not exported from the
 *  package barrel; only `installation-token.test.ts` should import it. */
export function _clearTokenCache(): void {
  _cache.clear();
}
