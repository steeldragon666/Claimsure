/**
 * Resolves the public web URL of this deployment — the URL a human user
 * types into their browser, with trailing slash stripped so callers can
 * safely append `/some-path?...` without worrying about double slashes.
 *
 * Used wherever the server constructs a URL the browser will visit:
 *   - signup verification emails (`/verify-email?token=...`)
 *   - federation invitation emails (`/federation/accept?token=...`)
 *   - any future transactional email containing a clickable link
 *
 * Resolution order:
 *   1. `PUBLIC_BASE_URL` (canonical — matches the VPS infra convention
 *      in `tools/vps/.env.production.example`)
 *   2. `APP_BASE_URL` (legacy — logs a deprecation warning on first use)
 *   3. `WEB_BASE_URL` (legacy — logs a deprecation warning on first use)
 *   4. In dev / test: defaults to `http://localhost:3000` (Next.js dev port)
 *   5. In production: THROWS — silently shipping localhost links to real
 *      users is worse than a boot-time crash. Setting `PUBLIC_BASE_URL`
 *      is non-optional in production.
 *
 * Production is defined as `NODE_ENV === 'production'`. Anything else
 * (dev, test, staging without explicit override) gets the localhost
 * default.
 *
 * Result is memoized after the first successful call. This is deliberate:
 *   - the env vars are read once at boot
 *   - the deprecation warning fires once, not once per email
 *   - tests must call `resetPublicBaseUrlForTesting()` between cases
 */

export interface PublicBaseUrlLogger {
  warn: (msg: string) => void;
}

interface PublicBaseUrlOptions {
  logger?: PublicBaseUrlLogger;
}

let cached: string | null = null;

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function getPublicBaseUrl(opts: PublicBaseUrlOptions = {}): string {
  if (cached !== null) return cached;

  const logger = opts.logger ?? console;

  const publicVal = process.env['PUBLIC_BASE_URL'];
  if (publicVal && publicVal.length > 0) {
    cached = stripTrailingSlash(publicVal);
    return cached;
  }

  const appVal = process.env['APP_BASE_URL'];
  if (appVal && appVal.length > 0) {
    logger.warn(
      'APP_BASE_URL is deprecated — please set PUBLIC_BASE_URL instead. ' +
        'APP_BASE_URL support will be removed in a future release.',
    );
    cached = stripTrailingSlash(appVal);
    return cached;
  }

  const webVal = process.env['WEB_BASE_URL'];
  if (webVal && webVal.length > 0) {
    logger.warn(
      'WEB_BASE_URL is deprecated — please set PUBLIC_BASE_URL instead. ' +
        'WEB_BASE_URL support will be removed in a future release.',
    );
    cached = stripTrailingSlash(webVal);
    return cached;
  }

  if (process.env['NODE_ENV'] === 'production') {
    throw new Error(
      'PUBLIC_BASE_URL is required in production. Set it to the URL ' +
        'users visit in their browser (e.g. https://claimsure.app). This ' +
        'value is embedded in signup-verification and federation-invitation ' +
        'emails — without it, those emails contain unreachable links.',
    );
  }

  // Dev / test default. Next.js dev runs on :3000 by default.
  cached = 'http://localhost:3000';
  return cached;
}

/**
 * Test-only: clears the memoized value so subsequent `getPublicBaseUrl()`
 * calls re-read process.env. Production code MUST NOT call this — the
 * memoization is a feature, not a bug.
 */
export function resetPublicBaseUrlForTesting(): void {
  cached = null;
}
