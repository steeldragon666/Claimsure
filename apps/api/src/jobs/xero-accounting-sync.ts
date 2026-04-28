import { privilegedSql } from '@cpa/db/client';
import { decryptToken, getTokenEncryptionKey } from '@cpa/integrations/runtime';
import {
  syncInvoices,
  syncBankTransactions,
  syncReceipts,
  syncContacts,
  syncAccounts,
  type SyncInvoicesResult,
  type SyncBankTransactionsResult,
  type SyncReceiptsResult,
  type SyncContactsResult,
  type SyncAccountsResult,
} from '@cpa/integrations/xero-accounting';

/**
 * Xero Accounting periodic sync job (T-B6).
 *
 * Recurring per-tenant sync orchestrator. Drives the five Xero Accounting
 * sync functions (invoices → bank-tx → receipts → contacts → accounts) in
 * sequence for every connected `integration_connection` with
 * `provider='xero_accounting'`. Designed to be wired into pg-boss as a
 * recurring schedule; for v1 the pg-boss server itself isn't yet
 * initialised in `apps/api/src/server.ts` (mirroring the convention of
 * payroll-sync.ts and audit-score-recompute.ts — handler functions land
 * first, the pg-boss server bootstrap lands as a single cross-cutting
 * follow-up). `registerXeroAccountingSyncJob` exposes the registration
 * shim so the future bootstrap task can call it without re-shaping this
 * file.
 *
 * **Cadence**: every 15 minutes. This matches Xero's 60 req/min per-app
 * rate limit comfortably (5 syncs × ≤a few pages each, well under the
 * limit) and gets new bills / bank-tx into the firm's expenditure stream
 * fast enough to feel "live" to consultants without burning Xero quota.
 *
 * **Per-connection ordering**: the five syncs run **sequentially** within
 * a single connection — they share one Xero rate-limit budget, and
 * parallelising them risks tripping 429s. Across DIFFERENT connections we
 * also run sequentially for v1 (P4 scale = small; per-firm parallelism is
 * a P5+ concern once we have many tenants).
 *
 * **Per-tenant lock**: `pg_try_advisory_lock(hashtext('xero-sync-' || id))`
 * before each connection. Returns immediately with true (acquired) or
 * false (already held by another worker). On false we skip the connection
 * silently — this makes the job idempotent under concurrent worker
 * deployments (rolling restart, blue/green) without any "already syncing"
 * error noise. The lock is released in a try/finally so a thrown sync
 * never strands the lock.
 *
 * **Mode determination**: per-connection. `last_synced_at IS NULL` → we
 * pull every page (`mode='backfill'`); otherwise `mode='incremental'`
 * with `since=last_synced_at` (the sync functions translate `since` to
 * `If-Modified-Since` on the wire).
 *
 * **last_synced_at semantics**: updated to `NOW()` only AFTER all 5 sync
 * functions succeed for a connection. If any throws, we leave
 * `last_synced_at` UNCHANGED so the next 15-minute tick retries from the
 * same `since` — no skipped-window risk. The connection's `sync_state`
 * transitions to 'failed' with `last_error` set so a follow-up surface
 * (admin UI, dashboards) can show the error.
 *
 * **Token-expiry**: v1 surfaces a clear error if `expires_at < NOW()`.
 * Auto-refresh (call `refreshAccessToken`, encrypt new tokens, UPDATE the
 * row) is deferred — Xero rotates refresh tokens on every refresh, so the
 * implementation needs to persist BOTH new tokens. Tracked alongside the
 * payroll-sync auto-refresh TODO.
 *
 * **last_sync_result column**: NOT persisted. The structured result is
 * returned + logged only. If we want per-connection observability beyond
 * the existing `sync_state` / `last_error` columns, a follow-up migration
 * (P5+) can add a `last_sync_result jsonb` column without re-shaping the
 * orchestrator.
 *
 * **Provider value**: the `provider` column is plain `text` in Postgres
 * (no CHECK constraint) — drizzle-orm's enum is TS-only. We write
 * `'xero_accounting'` directly here. The schema's TS-level enum will be
 * widened to include `xero_accounting` as part of B0/B1 follow-ups; for
 * B6 we use the literal SQL string the rest of `packages/integrations/
 * xero-accounting` already uses (see `XERO_ACCOUNTING_PROVIDER` in
 * `types.ts`).
 *
 * Privileged SQL — same rationale as payroll-sync. Cron worker has no
 * request session, so it bypasses RLS via `privilegedSql`. Tests inject
 * a mock sql_client mirroring the postgres-js template-tag interface.
 */

export const XERO_ACCOUNTING_SYNC_JOB_NAME = 'xero-accounting-sync';
/** Cron expression — every 15 minutes. */
export const XERO_ACCOUNTING_SYNC_CADENCE = '*/15 * * * *';

/**
 * Minimal structural type for the pg-boss server. We avoid importing
 * `pg-boss` directly because it isn't yet a dependency of `@cpa/api` —
 * the package will be added when the cross-cutting bootstrap task wires
 * boss.start() into server.ts. Any shape compatible with these two
 * methods (the real `PgBoss` instance is) satisfies this type.
 */
export interface PgBossLike {
  schedule(name: string, cron: string, data?: unknown, options?: unknown): Promise<void>;
  work<T = unknown>(name: string, handler: (job: { data: T }) => unknown): Promise<string>;
}

export type SyncMode = 'backfill' | 'incremental';

/** Per-connection result, aggregated into the top-level RunResult. */
export type ConnectionSyncResult = {
  connection_id: string;
  tenant_id: string;
  mode: SyncMode;
  /** True when this run actually executed (acquired the advisory lock). */
  ran: boolean;
  /** When `ran=false`, the reason — currently only 'lock_held'. */
  skipped_reason?: 'lock_held';
  /** Per-resource results — undefined when `ran=false` or the call threw. */
  invoices?: SyncInvoicesResult;
  bank_transactions?: SyncBankTransactionsResult;
  receipts?: SyncReceiptsResult;
  contacts?: SyncContactsResult;
  accounts?: SyncAccountsResult;
  /** Set when the connection failed mid-sync; the 5 sync results may be partial. */
  error?: string;
};

export type RunResult = {
  /** Total connections matched by the SELECT (pre-lock). */
  matched: number;
  /** Subset that actually ran (lock acquired + executed all 5 syncs). */
  ran: number;
  /** Subset skipped because the advisory lock was held by another worker. */
  skipped: number;
  /** Subset that failed mid-sync (sync_state transitioned to 'failed'). */
  failed: number;
  /** Per-connection breakdown for log lines / observability. */
  per_connection: ConnectionSyncResult[];
};

interface IntegrationConnectionRow {
  id: string;
  tenant_id: string;
  access_token_encrypted: string;
  external_account_id: string | null;
  last_synced_at: Date | null;
  expires_at: Date | null;
}

interface AdvisoryLockRow {
  acquired: boolean;
}

export type XeroAccountingSyncDeps = {
  sql_client?: typeof privilegedSql;
  decrypt?: (blob: string, key: string) => string;
  get_encryption_key?: () => string;
  sync_invoices?: typeof syncInvoices;
  sync_bank_transactions?: typeof syncBankTransactions;
  sync_receipts?: typeof syncReceipts;
  sync_contacts?: typeof syncContacts;
  sync_accounts?: typeof syncAccounts;
};

/**
 * Run the periodic sync for one connection. Pulled out as its own export
 * so tests can exercise the per-connection branch in isolation
 * (independent of the multi-connection iterator's SELECT).
 *
 * Caller is responsible for the advisory-lock dance — this function
 * assumes the lock has already been acquired.
 */
export async function runOneConnection(
  conn: IntegrationConnectionRow,
  deps: Required<
    Pick<
      XeroAccountingSyncDeps,
      | 'sql_client'
      | 'decrypt'
      | 'get_encryption_key'
      | 'sync_invoices'
      | 'sync_bank_transactions'
      | 'sync_receipts'
      | 'sync_contacts'
      | 'sync_accounts'
    >
  >,
): Promise<ConnectionSyncResult> {
  const sql = deps.sql_client;
  const result: ConnectionSyncResult = {
    connection_id: conn.id,
    tenant_id: conn.tenant_id,
    mode: conn.last_synced_at ? 'incremental' : 'backfill',
    ran: true,
  };

  if (!conn.external_account_id) {
    const msg = 'external_account_id (xero_tenant_id) required';
    await sql`
      UPDATE integration_connection
         SET sync_state = 'failed',
             last_error = ${msg}
       WHERE id = ${conn.id}
    `;
    return { ...result, error: msg };
  }

  // Token-expiry guard — Xero access tokens last ~30 minutes. Surface a
  // clear error so the consultant can reconnect; auto-refresh is deferred
  // (see file header).
  if (conn.expires_at && conn.expires_at.getTime() <= Date.now()) {
    const msg = 'xero access token expired — reconnect required (auto-refresh TODO)';
    await sql`
      UPDATE integration_connection
         SET sync_state = 'failed',
             last_error = ${msg}
       WHERE id = ${conn.id}
    `;
    return { ...result, error: msg };
  }

  await sql`
    UPDATE integration_connection
       SET sync_state = 'syncing'
     WHERE id = ${conn.id}
  `;

  try {
    const accessToken = deps.decrypt(conn.access_token_encrypted, deps.get_encryption_key());

    const connOpts = {
      id: conn.id,
      tenant_id: conn.tenant_id,
      xero_tenant_id: conn.external_account_id,
      access_token: accessToken,
    };
    const baseSyncOpts =
      conn.last_synced_at !== null
        ? { mode: 'incremental' as const, since: conn.last_synced_at }
        : { mode: 'backfill' as const };

    // Sequential — same Xero rate-limit budget across all five.
    result.invoices = await deps.sync_invoices(connOpts, baseSyncOpts);
    result.bank_transactions = await deps.sync_bank_transactions(connOpts, baseSyncOpts);
    result.receipts = await deps.sync_receipts(connOpts, baseSyncOpts);
    result.contacts = await deps.sync_contacts(connOpts, baseSyncOpts);
    result.accounts = await deps.sync_accounts(connOpts, baseSyncOpts);

    // last_synced_at advances ONLY after all five succeed. On any error,
    // it stays put so the next tick replays the same `since`.
    await sql`
      UPDATE integration_connection
         SET sync_state = 'idle',
             last_synced_at = NOW(),
             last_error = NULL
       WHERE id = ${conn.id}
    `;

    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await sql`
      UPDATE integration_connection
         SET sync_state = 'failed',
             last_error = ${msg}
       WHERE id = ${conn.id}
    `;
    return { ...result, error: msg };
  }
}

/**
 * Iterate every `provider='xero_accounting'` connection and sync each
 * one. This is the function pg-boss invokes on every cadence tick. Pure
 * TS — DI'd against an injected sql client + sync functions for testing.
 */
export async function runXeroAccountingSyncForAllConnections(
  rawDeps: XeroAccountingSyncDeps = {},
): Promise<RunResult> {
  const deps = {
    sql_client: rawDeps.sql_client ?? privilegedSql,
    decrypt: rawDeps.decrypt ?? decryptToken,
    get_encryption_key: rawDeps.get_encryption_key ?? getTokenEncryptionKey,
    sync_invoices: rawDeps.sync_invoices ?? syncInvoices,
    sync_bank_transactions: rawDeps.sync_bank_transactions ?? syncBankTransactions,
    sync_receipts: rawDeps.sync_receipts ?? syncReceipts,
    sync_contacts: rawDeps.sync_contacts ?? syncContacts,
    sync_accounts: rawDeps.sync_accounts ?? syncAccounts,
  };
  const sql = deps.sql_client;

  // 'connected' in the existing schema = sync_state IN ('idle','syncing')
  // — the codebase uses `<> 'failed'` so a row mid-sync still surfaces
  // here; the advisory lock blocks the duplicate run.
  const conns = (await sql`
    SELECT id, tenant_id, access_token_encrypted, external_account_id,
           last_synced_at, expires_at
      FROM integration_connection
     WHERE provider = 'xero_accounting'
       AND sync_state <> 'failed'
     ORDER BY id
  `) as IntegrationConnectionRow[];

  const out: RunResult = {
    matched: conns.length,
    ran: 0,
    skipped: 0,
    failed: 0,
    per_connection: [],
  };

  for (const conn of conns) {
    // Per-connection advisory lock. The lock key is hashed from the
    // connection id so it's stable across worker restarts; releasing in
    // a finally block guarantees we don't strand it on a thrown sync.
    const lockKey = `xero-sync-${conn.id}`;
    const lockRows = (await sql`
      SELECT pg_try_advisory_lock(hashtext(${lockKey})) AS acquired
    `) as AdvisoryLockRow[];
    const acquired = lockRows[0]?.acquired === true;
    if (!acquired) {
      out.skipped += 1;
      out.per_connection.push({
        connection_id: conn.id,
        tenant_id: conn.tenant_id,
        mode: conn.last_synced_at ? 'incremental' : 'backfill',
        ran: false,
        skipped_reason: 'lock_held',
      });
      continue;
    }

    try {
      const r = await runOneConnection(conn, deps);
      out.per_connection.push(r);
      if (r.error) {
        out.failed += 1;
      } else {
        out.ran += 1;
      }
    } finally {
      // Best-effort release. If this throws (e.g. connection died) the
      // lock auto-releases on session end, so the next tick won't be
      // permanently blocked.
      try {
        await sql`SELECT pg_advisory_unlock(hashtext(${lockKey}))`;
      } catch (e) {
        console.error(`[xero-accounting-sync] advisory unlock failed for ${conn.id}:`, e);
      }
    }
  }

  return out;
}

/**
 * Register the recurring schedule + worker on a pg-boss instance. Called
 * by the cross-cutting bootstrap task that wires `boss.start()` in
 * `server.ts`.
 *
 * The handler ignores the job's `data` payload — the schedule fires with
 * an empty body and the orchestrator pulls its own work list from the DB.
 */
export async function registerXeroAccountingSyncJob(boss: PgBossLike): Promise<void> {
  await boss.schedule(XERO_ACCOUNTING_SYNC_JOB_NAME, XERO_ACCOUNTING_SYNC_CADENCE);
  await boss.work(XERO_ACCOUNTING_SYNC_JOB_NAME, async () => {
    const result = await runXeroAccountingSyncForAllConnections();
    console.log(
      `[xero-accounting-sync] matched=${result.matched} ran=${result.ran} skipped=${result.skipped} failed=${result.failed}`,
    );
    return result;
  });
}
