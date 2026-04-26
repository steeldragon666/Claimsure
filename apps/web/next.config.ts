import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Pin tracing root to the monorepo so Next ignores any stray lockfiles
  // higher up the filesystem (e.g. C:\Users\Aaron\package-lock.json).
  outputFileTracingRoot: path.join(import.meta.dirname, '..', '..'),
  async rewrites() {
    return [
      {
        source: '/v1/:path*',
        destination: 'http://localhost:3000/v1/:path*',
      },
    ];
  },
  reactStrictMode: true,
};

export default nextConfig;
