import path from 'node:path';
import type { NextConfig } from 'next';

/**
 * API rewrite target.
 *
 * Local dev: defaults to http://localhost:3000 (the Fastify API on port 3000).
 * Vercel preview/prod: set API_URL in the Vercel project to the Railway (or
 * other host) URL of the deployed Fastify server, e.g.
 *   API_URL=https://cpa-api-production.up.railway.app
 *
 * All client-side fetches use relative /v1/... paths and rely on this rewrite,
 * so flipping API_URL is the entire deploy-time wiring — no client code
 * changes required.
 */
const API_URL = process.env.API_URL ?? 'http://localhost:3000';

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
