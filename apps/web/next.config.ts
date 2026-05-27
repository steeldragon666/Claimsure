import path from 'node:path';
import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs';

function resolveApiUrl(): string {
  const envVar = process.env.API_URL;
  if (envVar && envVar !== '') return envVar;
  if (process.env.NODE_ENV === 'production') return 'http://api:3000';
  return 'http://localhost:3000';
}

const API_URL = resolveApiUrl();
// eslint-disable-next-line no-console
console.log('[next.config] API_URL rewrite target:', API_URL);

const nextConfig: NextConfig = {
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

// Wrap with Sentry to enable source-map upload at build time and to inject
// the webpack plugin that wires the browser SDK. All Sentry-specific options
// are env-driven; when SENTRY_ORG / SENTRY_PROJECT / SENTRY_AUTH_TOKEN are
// unset the wrap is harmless — it still produces a valid Next.js build with
// no source-map upload attempt. SENTRY_AUTH_TOKEN is only consulted at build
// time, never at runtime.
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: true,
  // Don't expose source maps to the public. Sentry still uploads them
  // (when AUTH_TOKEN is set) so stack traces remain symbolicated server-side.
  hideSourceMaps: true,
  // Avoid injecting the Sentry tunnel rewrite — we don't proxy through /v1.
  disableLogger: true,
});
