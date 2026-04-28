import { privilegedSql } from '@cpa/db/client';
import { xeroAccountingGet } from './client.js';

/**
 * Xero Accounting accounts (chart-of-accounts) sync (T-B5).
 *
 * Fetches the Xero `/Accounts` endpoint and UPSERTs each account into
 * the `xero_account` cache table. This is a pure reference cache —
 * no event-chain integration, no domain rows touched. Refreshed on
 * every sync run; the F5 mapping-rule UI reads from this cache to
 * power account-code dropdowns and "what does code 400 mean here?"
 * lookups.
 *
 * **No pagination**: Xero's chart-of-accounts is small (~50-200 entries
 * per typical small-business org) and the `/Accounts` endpoint
 * returns the full chart in one response. Per Xero's docs the
 * endpoint does NOT advertise pagination metadata for this resource;
 * unlike `/Invoices`, `/BankTransactions`, `/Receipts`, `/Contacts`
 * we do NOT issue `?page=N` here. If a tenant ever exceeds a few
 * thousand accounts we'd add pagination, but that's a P9+ concern.
 *
 * **Modes** (mirrors B2/B3/B4 — single page, but the mode shape is
 * preserved for B6 pg-boss orchestrator parity):
 *   - `backfill`: no `If-Modified-Since`. Pulls all accounts.
 *   - `incremental`: `If-Modified-Since: <since.toUTCString()>`.
 *     Returns only accounts touched at-or-after `since`.
 *
 * **No status filter**: we sync ALL accounts (ACTIVE + ARCHIVED) so
 * the UI can surface archived accounts that older expenditures still
 * reference. The mapping-rule UI applies the active/archived filter
 * client-side based on context (e.g. "list active expense accounts
 * for the rule dropdown" vs "show me all account codes referenced by
 * this expenditure").
 *
 * **No event chain**: cache tables are NOT domain events. Unlike B2-B4
 * which write `EXPENDITURE_INGESTED` on every new expenditure, B5
 * does NOT call `insertEventWithChain`.
 *
 * **UPSERT semantics**:
 *   - Match key: composite PK `(tenant_id, xero_account_id)`.
 *   - On hit: UPDATE all mutable fields (code, name, type, status,
 *     raw_payload). Always set `synced_at = now()`.
 *   - On miss: INSERT.
 *   - Implementation: a single `INSERT ... ON CONFLICT (tenant_id,
 *     xero_account_id) DO UPDATE SET ...` statement.
 *
 * Privileged SQL — same rationale as the sibling sync workers.
 */

export type SqlClient = typeof privilegedSql;

export interface SyncAccountsConnection {
  /** integration_connection.id — used for trace logging only. */
  id: string;
  /** owning tenant_id — drives RLS and the composite PK. */
  tenant_id: string;
  /** Xero org tenant_id (the `Xero-tenant-id` header value). */
  xero_tenant_id: string;
  /** Decrypted access token (caller decrypts via `decryptToken`). */
  access_token: string;
}

export interface SyncAccountsOptions {
  mode: 'backfill' | 'incremental';
  /** Required if mode='incremental'. Sent as If-Modified-Since header. */
  since?: Date;
  /** Override for tests; defaults to the privileged DB client. */
  sql_client?: SqlClient;
  /** Test override for the API base URL — forwarded to xeroAccountingGet. */
  base_url?: string;
}

export interface SyncAccountsResult {
  /** Number of accounts fetched from Xero. */
  fetched: number;
  /** Number of new xero_account rows inserted. */
  inserted: number;
  /** Number of existing xero_account rows updated (idempotent re-sync). */
  updated: number;
}

interface XeroAccount {
  AccountID: string;
  Code?: string;
  Name?: string;
  Type?: string;
  // 'ACTIVE' | 'ARCHIVED' per Xero's contract.
  Status?: string;
}

interface XeroAccountsResponse {
  Accounts?: XeroAccount[];
}

export async function syncAccounts(
  connection: SyncAccountsConnection,
  options: SyncAccountsOptions,
): Promise<SyncAccountsResult> {
  const sql = options.sql_client ?? privilegedSql;

  if (options.mode === 'incremental' && !options.since) {
    throw new Error(
      'syncAccounts: mode=incremental requires `since` — pass the last successful sync timestamp',
    );
  }

  const result: SyncAccountsResult = {
    fetched: 0,
    inserted: 0,
    updated: 0,
  };

  const extraHeaders: Record<string, string> = {};
  if (options.mode === 'incremental' && options.since) {
    extraHeaders['If-Modified-Since'] = options.since.toUTCString();
  }

  const data = (await xeroAccountingGet(
    {
      access_token: connection.access_token,
      xero_tenant_id: connection.xero_tenant_id,
      ...(options.base_url !== undefined ? { base_url: options.base_url } : {}),
    },
    '/Accounts',
    // No query params — chart-of-accounts comes back in a single
    // response. See no-pagination rationale in the header.
    undefined,
    extraHeaders,
  )) as XeroAccountsResponse;

  const accounts = data.Accounts ?? [];

  for (const a of accounts) {
    result.fetched++;

    // Code, Name, Type, Status are all required in Xero's documented
    // contract — but defend against a malformed response by emitting
    // a placeholder rather than crashing the whole sync. The cache
    // is a refresh-every-N-minutes view; one weird row should not
    // halt updates for the rest.
    const code = a.Code ?? '';
    const name = a.Name ?? '(unnamed account)';
    const type = a.Type ?? 'UNKNOWN';
    const status = a.Status ?? 'ACTIVE';
    const rawPayload = JSON.stringify(a);

    const rows = (await sql`
      INSERT INTO xero_account (
        tenant_id, xero_account_id, code, name, type, status, raw_payload, synced_at
      ) VALUES (
        ${connection.tenant_id}, ${a.AccountID}, ${code}, ${name},
        ${type}, ${status}, ${rawPayload}::jsonb, now()
      )
      ON CONFLICT (tenant_id, xero_account_id) DO UPDATE SET
        code = EXCLUDED.code,
        name = EXCLUDED.name,
        type = EXCLUDED.type,
        status = EXCLUDED.status,
        raw_payload = EXCLUDED.raw_payload,
        synced_at = now()
      RETURNING (xmax = 0) AS inserted
    `) as Array<{ inserted: boolean }>;

    const upsertedRow = rows[0];
    if (!upsertedRow) {
      throw new Error(
        `syncAccounts: UPSERT into xero_account returned no row (account=${a.AccountID})`,
      );
    }
    if (upsertedRow.inserted) {
      result.inserted++;
    } else {
      result.updated++;
    }
  }

  return result;
}
