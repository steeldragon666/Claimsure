import { sql } from '@cpa/db/client';

export interface DbCheckResult {
  ok: boolean;
  latencyMs: number;
}

export interface DbCheckLogger {
  error: (obj: object, msg: string) => void;
}

const CHECK_TIMEOUT_MS = 1500;

/**
 * Check whether the application can talk to its dependency.
 *
 * Caller passes a `runQuery` function that returns a Promise. Typically
 * this is `() => sql\`SELECT 1\`` for postgres-js, but accepting a generic
 * function lets tests stub the failure path without spinning up a dead
 * Postgres or mocking the entire client module.
 *
 * Errors are NOT thrown — `/readyz` callers want a structured result.
 * If a logger is provided, errors are logged at `error` level.
 *
 * Surfaced by P0 final review items I1 (timeout) + I2 (testability).
 */
export async function checkDb(
  runQuery: () => Promise<unknown>,
  logger?: DbCheckLogger,
): Promise<DbCheckResult> {
  const start = Date.now();
  let timeoutId: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      runQuery(),
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

/**
 * Default runQuery for production use — issues a `SELECT 1` against the
 * postgres-js pool. Routes call this directly; tests pass their own.
 */
export const defaultRunQuery = (): Promise<unknown> => sql`SELECT 1`;
