import { PgBoss } from 'pg-boss';

/**
 * Singleton pg-boss client for scheduled-job and async-work registration.
 *
 * ## Why a singleton?
 *
 * pg-boss owns its own pg connection pool, polls the `pgboss.job` table on a
 * timer (default ~2s), and runs maintenance background tasks. Constructing a
 * second instance against the same Postgres would double-poll and double-
 * maintain. The singleton enforces "exactly one boss per process".
 *
 * ## Connection-string strategy
 *
 * pg-boss creates and writes to a global `pgboss` schema (tables: `job`,
 * `archive`, `schedule`, `queue`, `version`, etc.). These tables are NOT
 * subject to application-level RLS — they belong to the queue infrastructure,
 * not to any tenant. They therefore need a **privileged** connection that can
 * (a) run DDL on first start to create/migrate the schema, and (b) read/write
 * `pgboss.*` without an RLS-scoped role's restrictions.
 *
 * We honour `DATABASE_URL_BOSS` as an explicit override hook (lets ops point
 * pg-boss at a different DB or a dedicated pgboss role if desired), then fall
 * back to `DATABASE_URL` — the same privileged URL the migration runner uses
 * (see `.env.example`). We deliberately do NOT use `DATABASE_URL_APP`: that
 * URL is the RLS-scoped runtime role (`cpa_app`, NOSUPERUSER, NOBYPASSRLS),
 * which would block pg-boss's schema bootstrap.
 *
 * ## Lifecycle
 *
 * - `getBoss()` is the only public entrypoint. It returns the same instance
 *   on every call after the first; the first call lazily constructs and
 *   `start()`s the boss.
 * - `stopBoss()` is wired into the SIGTERM/SIGINT shutdown path in
 *   `server.ts` so in-flight workers drain cleanly before `app.close()`.
 * - The error listener is attached BEFORE `start()` so any startup error
 *   (e.g. schema-migration failure on first boot) routes through the same
 *   visibility surface as steady-state errors.
 *
 * ## Bootstrap rationale (Task D.0)
 *
 * The P7 implementation plan's Theme D references pg-boss as an "existing
 * dependency" but it was never installed — every `apps/api/src/jobs/*.ts`
 * file has comments saying the pg-boss subscriber wiring is "future" work.
 * This module is the gap-fix that unblocks D.9's `boss.schedule(...)`
 * registration of the daily RIF scrape cron.
 */

let bossInstance: PgBoss | null = null;

/**
 * Get-or-create the pg-boss singleton.
 *
 * On first call this lazily:
 *   1. Reads `DATABASE_URL_BOSS` (override) or `DATABASE_URL` (default).
 *   2. Constructs a `PgBoss` against that connection string.
 *   3. Wires an `error` listener (currently routes to `console.error`;
 *      the Sentry integration lands with P8 T1.2).
 *   4. Awaits `boss.start()`, which creates the `pgboss` schema on first
 *      run (idempotent — re-runs are no-ops once the schema exists at the
 *      expected version).
 *
 * Subsequent calls return the same cached instance.
 *
 * @throws if neither `DATABASE_URL_BOSS` nor `DATABASE_URL` is set, or if
 *   `boss.start()` fails (typically due to bad credentials / DB unreachable).
 */
export async function getBoss(): Promise<PgBoss> {
  if (bossInstance) return bossInstance;
  const connectionString = process.env['DATABASE_URL_BOSS'] ?? process.env['DATABASE_URL'];
  if (!connectionString) {
    throw new Error(
      'pg-boss-client: DATABASE_URL not set (and DATABASE_URL_BOSS not set as override)',
    );
  }
  const boss = new PgBoss(connectionString);
  // Attach the error listener BEFORE start() so any startup error
  // (schema-migration failure, connection refused, etc.) routes through
  // the same surface as steady-state errors.
  boss.on('error', (err: Error) => {
    // Sentry routing lands with P8 T1.2; for now console.error is the
    // visibility surface. console is intentional here — Fastify's app
    // logger is not yet constructed when boot calls getBoss().
    console.error('[pg-boss] error', err);
  });
  await boss.start();
  bossInstance = boss;
  return bossInstance;
}

/**
 * Gracefully stop the pg-boss singleton.
 *
 * No-op when the singleton was never constructed (e.g. test-only paths
 * that imported the module but never called `getBoss()`). Safe to call
 * multiple times — after the first successful stop the instance is
 * cleared, so a re-call short-circuits on the same null-check.
 *
 * Used in:
 *   - `server.ts` SIGTERM/SIGINT handlers (production shutdown).
 *   - Test `after` hooks that exercise `getBoss()`.
 */
export async function stopBoss(): Promise<void> {
  if (!bossInstance) return;
  const boss = bossInstance;
  // Clear the cache BEFORE awaiting stop so a concurrent getBoss() after
  // shutdown begins doesn't get a stopping/stopped instance back. Any
  // such caller will construct a fresh boss; if shutdown is in progress,
  // the new boss will fight for the schema and (correctly) lose. In
  // practice this only matters for test interleavings.
  bossInstance = null;
  await boss.stop({ graceful: true });
}

/**
 * Test-only: reset the singleton cache without stopping the boss.
 *
 * Allows tests to verify start/stop semantics across multiple `getBoss()`
 * calls within a single process. Production code MUST NOT call this —
 * the public lifecycle is `getBoss()` (idempotent) plus `stopBoss()`
 * (which already clears the cache).
 *
 * @internal
 */
export function __resetBossForTests(): void {
  bossInstance = null;
}
