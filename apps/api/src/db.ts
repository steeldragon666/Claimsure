import { sql } from '@cpa/db/client';

export interface DbCheckResult {
  ok: boolean;
  latencyMs: number;
}

/**
 * Minimal logger contract — accepts a `req.log` from a Fastify request
 * (or any pino-shaped logger). The optional shape lets callers in non-
 * request contexts (e.g. CLI scripts) skip it.
 */
export interface DbCheckLogger {
  error: (obj: object, msg: string) => void;
}

const CHECK_TIMEOUT_MS = 1500;

/**
 * Check whether the application can talk to Postgres.
 *
 * Issues a trivial `SELECT 1` with a 1500ms timeout. Returns
 * `ok: true` only if the query succeeded inside the budget;
 * `ok: false` on any error (connection refused, auth failed,
 * timeout, query error). The `latencyMs` is the elapsed wall-clock
 * time — useful even on failure to distinguish fast-fail from
 * slow-fail.
 *
 * Errors are NOT thrown — `/readyz` callers want a structured result.
 * If a logger is provided, errors are logged at `error` level with
 * the err object so SREs can debug 503s without grepping code.
 *
 * Uses the module-scoped pool from `@cpa/db/client`; per-request
 * connections are not supported here by design.
 */
export async function checkDb(logger?: DbCheckLogger): Promise<DbCheckResult> {
  const start = Date.now();
  let timeoutId: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      sql`SELECT 1`,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`checkDb timeout after ${CHECK_TIMEOUT_MS}ms`)),
          CHECK_TIMEOUT_MS,
        );
      }),
    ]);
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    logger?.error({ err }, 'checkDb failed');
    return { ok: false, latencyMs: Date.now() - start };
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
