const DEV_DATABASE_URL = 'postgres://cpa:cpa@localhost:5432/cpa_dev';

/**
 * Resolve the Postgres connection URL.
 *
 * In production (NODE_ENV=production) DATABASE_URL is required — we
 * throw rather than fall back, because a silent fallback to a dev URL
 * would be a silent connect-to-the-wrong-thing bug.
 *
 * In dev/test, fall back to the canonical local docker compose URL.
 */
export function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url) return url;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('DATABASE_URL is required in production');
  }
  return DEV_DATABASE_URL;
}

/**
 * Postgres connection pool size. Defaults to 10. Override with
 * DATABASE_POOL_MAX for higher-concurrency deployments.
 */
export function getDatabasePoolMax(): number {
  const v = Number(process.env.DATABASE_POOL_MAX ?? '10');
  return Number.isFinite(v) && v > 0 ? v : 10;
}
