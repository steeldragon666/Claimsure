import path from 'node:path';
import type { NextConfig } from 'next';

/**
 * API rewrite target.
 *
 * Resolution chain (first non-empty wins):
 *   1. process.env.API_URL           — explicit override (set in Vercel env)
 *   2. Railway prod URL on Vercel    — fallback when VERCEL=1 so the rewrite
 *      still works if the env var fails to populate. Vercel auto-marks new
 *      env vars as `sensitive`, and we observed the value reaching the build
 *      as "" even after a successful POST. Hardcoded fallback eliminates
 *      that propagation risk for the canonical prod target.
 *   3. http://localhost:3000         — local dev (no VERCEL flag, no env)
 *
 * The empty-string guard (`!== ''`) matters: `??` only catches null/undefined,
 * so an empty env var would otherwise pass through and break the rewrite to a
 * relative path, triggering Vercel's `DNS_HOSTNAME_RESOLVED_PRIVATE` SSRF
 * guard.
 *
 * All client fetches use relative `/v1/...` paths and rely on this rewrite,
 * so changing the deploy target is purely a deploy-time concern — no client
 * code changes ever required.
 */
function resolveApiUrl(): string {
  const envVar = process.env.API_URL;
  if (envVar && envVar !== '') return envVar;
  if (process.env.VERCEL === '1') return 'https://cpaapi-production.up.railway.app';
  return 'http://localhost:3000';
}

const API_URL = resolveApiUrl();
// Surface the resolved value in build logs so deploy issues are obvious.
// eslint-disable-next-line no-console
console.log('[next.config] API_URL rewrite target:', API_URL);

const nextConfig: NextConfig = {
  // Pin tracing root to the monorepo so Next ignores any stray lockfiles
  // higher up the filesystem (e.g. C:\Users\Aaron\package-lock.json).
  outputFileTracingRoot: path.join(import.meta.dirname, '..', '..'),
  async rewrites() {
    return [
      {
        source: '/v1/:path*',
        destination: `${API_URL}/v1/:path*`,
      },
    ];
  },
  reactStrictMode: true,
};

export default nextConfig;
