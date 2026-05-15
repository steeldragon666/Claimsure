import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { getAppDatabaseUrl, getDatabasePoolMax, getDatabaseUrl } from './env.js';

/**
 * Resolve SSL config for managed-Postgres connections.
 *
 * Supabase's pooler (`*.pooler.supabase.com`) presents a certificate chain
 * that includes an intermediate Node doesn't ship in its default trust
 * store, so `tls.connect()` rejects it as "self-signed certificate in
 * certificate chain". The standard fix for managed Postgres services is
 * to keep TLS encryption but skip CA-chain validation — the connection
 * is still TLS, just trust-on-first-use.
 *
 * Triggered when:
 *   - URL contains `sslmode=require|verify-ca|verify-full|prefer`, OR
 *   - NODE_ENV is `production` (assume all prod connections are over TLS)
 * Otherwise (local docker pg on 5433) returns `false` → plain TCP.
 */
function resolveSsl(url: string): { rejectUnauthorized: false } | false {
  const hasSslMode = /[?&]sslmode=(?!disable)/.test(url);
  if (hasSslMode || process.env['NODE_ENV'] === 'production') {
    return { rejectUnauthorized: false };
  }
  return false;
}

const APP_URL = getAppDatabaseUrl();
const PRIV_URL = getDatabaseUrl();

/**
 * Optional runtime role override. When set, every `sql.begin(...)` block
 * prepends a `SET LOCAL ROLE <name>` so the transaction's queries run
 * as that role even when the connection authenticated as a different
 * user.
 *
 * WHY: Supabase's session-mode pooler (Supavisor) connects every client
 * as `postgres`, which has BYPASSRLS=true. That silently disables RLS
 * for the entire application — cross-firm queries that should be filtered
 * by RLS policies instead return everything. The fix is to switch role
 * in-band to `cpa_app` (BYPASSRLS=false) for the duration of each
 * transaction.
 *
 * Default: `cpa_app` when not explicitly set, since that's what the
 * production app SHOULD be using per migration 0002. Set to empty
 * string to disable the override (useful for local docker pg where
 * the connection role is already cpa_app and SET ROLE would be a no-op
 * or error).
 *
 * The override applies ONLY to `sql.begin(...)` transactions, not to
 * top-level `sql\`...\`` queries (postgres-js implicit autocommit).
 * Application code should use sql.begin for any RLS-sensitive read.
 */
const APP_ROLE_OVERRIDE = (() => {
  const explicit = process.env['DB_APP_ROLE'];
  if (explicit !== undefined) return explicit; // empty string = disabled
  return 'cpa_app';
})();

/**
 * Application runtime client. Connects to APP_URL (which on Supabase
 * resolves to the postgres role through the pooler) and uses SET LOCAL
 * ROLE inside each transaction to switch to the RLS-enforcing role.
 *
 * Migrations are a separate path: `pnpm --filter @cpa/db migrate`
 * (src/migrate.ts) connects via getDatabaseUrl() and does NOT use the
 * role override.
 *
 * NB: caller is responsible for `await sql.end()` in short-lived scripts.
 * Long-lived processes (apps/api) leave this open intentionally.
 */
const sqlBase = postgres(APP_URL, {
  max: getDatabasePoolMax(),
  ssl: resolveSsl(APP_URL),
});

// Wrap sql.begin to inject SET LOCAL ROLE as the first statement in
// every transaction. We do this by monkey-patching .begin rather than
// re-exporting a wrapper so existing call-sites (`sql.begin(...)`,
// `sql\`...\``) continue to work unchanged.
if (APP_ROLE_OVERRIDE) {
  // postgres-js `begin` has an overloaded signature (begin(fn) and
  // begin(options, fn)) that isn't easy to express structurally. Cast
  // through a minimal shape to inject the SET LOCAL ROLE step without
  // needing the full generic plumbing.
  type TxFn = (tx: typeof sqlBase) => unknown;
  type BeginSig = (...args: unknown[]) => unknown;
  const beginMutable = sqlBase as unknown as { begin: BeginSig };
  const originalBegin = beginMutable.begin.bind(sqlBase);
  const wrappedBegin: BeginSig = (...args: unknown[]) => {
    const last = args[args.length - 1];
    if (typeof last !== 'function') {
      return originalBegin(...args);
    }
    const fn = last as TxFn;
    const wrappedFn: TxFn = async (tx) => {
      // SET LOCAL is transaction-scoped — auto-reverts on commit/rollback,
      // so connections returned to the pool are unchanged. We use
      // sql.unsafe() because postgres-js's tagged-template would quote
      // the role name as a string literal; SET ROLE needs an identifier.
      await tx.unsafe(`SET LOCAL ROLE ${APP_ROLE_OVERRIDE}`);
      return fn(tx);
    };
    return originalBegin(...args.slice(0, -1), wrappedFn);
  };
  beginMutable.begin = wrappedBegin;
}

export const sql = sqlBase;
export const db = drizzle(sql);
export type Db = typeof db;

/**
 * Privileged DB client — connects as cpa (the migration role).
 * RLS-bypassing because cpa is the bootstrap superuser AND the table owner;
 * Postgres skips RLS for both, so policies don't apply to this client.
 *
 * Use ONLY for queries that must transcend tenant scope:
 *   - Auth lookups (lookupActiveTenant — needs to see all tenant_user
 *     rows for a user across all tenants to determine the active one)
 *   - System-admin tooling (P3+; not user-facing)
 *
 * NEVER hand this to a route handler that runs after session middleware.
 * The middleware switches us to cpa_app for a reason.
 *
 * Pool capped at 5 — auth flows are infrequent compared to runtime queries.
 */
export const privilegedSql = postgres(PRIV_URL, {
  max: 5,
  ssl: resolveSsl(PRIV_URL),
});
