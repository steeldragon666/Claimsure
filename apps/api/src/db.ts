import { sql } from '@cpa/db/client';

export interface DbCheckResult {
  ok: boolean;
  latencyMs: number;
}

/**
 * Check whether the application can talk to Postgres.
 *
 * Issues a trivial `SELECT 1` and times it. Returns ok=true if the query
 * succeeded, ok=false on any error (including connection failures, timeouts,
 * auth failures). The latencyMs is the round-trip time in milliseconds.
 *
 * Errors are NOT thrown — `/readyz` callers want a structured result, not
 * an exception bubbling through the request handler.
 */
export async function checkDb(): Promise<DbCheckResult> {
  const start = Date.now();
  try {
    await sql`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - start };
  } catch {
    return { ok: false, latencyMs: Date.now() - start };
  }
}
