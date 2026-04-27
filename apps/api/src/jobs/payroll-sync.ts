import { privilegedSql } from '@cpa/db/client';
import { decryptToken, getTokenEncryptionKey } from '@cpa/integrations/runtime';
import { employmentHero, keypay, deputy, xeroPayroll } from '@cpa/integrations/payroll';

/**
 * Employment Hero sync orchestrator (T-B11).
 *
 * One-shot HANDLER function (the pg-boss subscriber wiring is deferred
 * to a later task). Given an `integration_connection.id` it:
 *
 *   1. Fetches the connection row (privileged — RLS-bypassing because
 *      sync is system-driven, not request-scoped).
 *   2. Marks `sync_state='syncing'`.
 *   3. Decrypts the access token, looks up the active subject_tenant
 *      and an admin user (for `invited_by_user_id` on new employees).
 *   4. Calls `employmentHero.syncEmployees` then `pullTimesheets`.
 *   5. On success: clears last_error, sets `sync_state='idle'` +
 *      bumps `last_synced_at = NOW()`.
 *   6. On any error: tombstones the row with `sync_state='failed'` +
 *      `last_error = <message>` and returns a `SyncResult` with the
 *      error string set (so the caller — eventually pg-boss — can
 *      surface it without rethrowing).
 *
 * Multi-claimant: for v1 we assume one subject_tenant per (tenant,
 * provider). The query picks the first claimant subject_tenant by
 * `created_at`. Multi-claimant-per-firm sync support comes later.
 *
 * Dependency injection: sub-functions and the sql client are injected
 * via the optional `deps` arg so tests can verify the orchestrator's
 * decision logic without mocking the import system.
 */

export type SyncResult = {
  tenant_id: string;
  provider: 'employment_hero' | 'keypay' | 'deputy' | 'xero_payroll';
  employees: { upserted: number; deactivated: number };
  timesheets: {
    inserted: number;
    updated: number;
    skipped_unmatched: number;
    /** Deputy-only — surfaced for `provider === 'deputy'` only; absent for EH/KeyPay/Xero. */
    skipped_discarded?: number;
    /** Xero-only — surfaced for `provider === 'xero_payroll'` only; absent for EH/KeyPay/Deputy. */
    skipped_rejected?: number;
  };
  error?: string;
};

export type PayrollSyncDeps = {
  sql_client?: typeof privilegedSql;
  decrypt?: (blob: string, key: string) => string;
  get_encryption_key?: () => string;
  sync_employees?: typeof employmentHero.syncEmployees;
  pull_timesheets?: typeof employmentHero.pullTimesheets;
};

export type KeypaySyncDeps = {
  sql_client?: typeof privilegedSql;
  decrypt?: (blob: string, key: string) => string;
  get_encryption_key?: () => string;
  sync_employees?: typeof keypay.syncEmployees;
  pull_timesheets?: typeof keypay.pullTimesheets;
};

export type DeputySyncDeps = {
  sql_client?: typeof privilegedSql;
  decrypt?: (blob: string, key: string) => string;
  get_encryption_key?: () => string;
  sync_employees?: typeof deputy.syncEmployees;
  pull_timesheets?: typeof deputy.pullTimesheets;
};

export type XeroPayrollSyncDeps = {
  sql_client?: typeof privilegedSql;
  decrypt?: (blob: string, key: string) => string;
  get_encryption_key?: () => string;
  sync_employees?: typeof xeroPayroll.syncEmployees;
  pull_timesheets?: typeof xeroPayroll.pullTimesheets;
};

interface IntegrationConnectionRow {
  tenant_id: string;
  access_token_encrypted: string;
  external_account_id: string | null;
  last_synced_at: Date | null;
  expires_at?: Date | null;
}

interface SubjectTenantRow {
  id: string;
}

interface AdminUserRow {
  user_id: string;
}

export async function syncEmploymentHero(
  connectionId: string,
  deps: PayrollSyncDeps = {},
): Promise<SyncResult> {
  const sql = deps.sql_client ?? privilegedSql;
  const decrypt = deps.decrypt ?? decryptToken;
  const getKey = deps.get_encryption_key ?? getTokenEncryptionKey;
  const syncEmployees = deps.sync_employees ?? employmentHero.syncEmployees;
  const pullTimesheets = deps.pull_timesheets ?? employmentHero.pullTimesheets;

  const connRows = (await sql`
    SELECT tenant_id, access_token_encrypted, external_account_id, last_synced_at
      FROM integration_connection
     WHERE id = ${connectionId}
       AND provider = 'employment_hero'
       AND sync_state <> 'failed'
  `) as IntegrationConnectionRow[];
  const conn = connRows[0];
  if (!conn) {
    throw new Error(`integration_connection not found or failed: ${connectionId}`);
  }
  if (!conn.external_account_id) {
    // No organisation_id means we never persisted the EH org during the
    // OAuth callback — treat as a misconfigured connection.
    await sql`
      UPDATE integration_connection
         SET sync_state = 'failed',
             last_error = 'external_account_id (organisation_id) required'
       WHERE id = ${connectionId}
    `;
    return {
      tenant_id: conn.tenant_id,
      provider: 'employment_hero',
      employees: { upserted: 0, deactivated: 0 },
      timesheets: { inserted: 0, updated: 0, skipped_unmatched: 0 },
      error: 'external_account_id (organisation_id) required',
    };
  }

  // Move into 'syncing' state up-front so concurrent invocations can
  // observe the in-flight sync.
  await sql`
    UPDATE integration_connection
       SET sync_state = 'syncing'
     WHERE id = ${connectionId}
  `;

  try {
    const accessToken = decrypt(conn.access_token_encrypted, getKey());

    const subjRows = (await sql`
      SELECT id FROM subject_tenant
       WHERE tenant_id = ${conn.tenant_id}
         AND kind = 'claimant'
         AND deleted_at IS NULL
       ORDER BY created_at
       LIMIT 1
    `) as SubjectTenantRow[];
    const subj = subjRows[0];
    if (!subj) {
      throw new Error('no subject_tenant for this connection');
    }

    const adminRows = (await sql`
      SELECT user_id FROM tenant_user
       WHERE tenant_id = ${conn.tenant_id}
         AND role = 'admin'
         AND deleted_at IS NULL
       ORDER BY created_at
       LIMIT 1
    `) as AdminUserRow[];
    const admin = adminRows[0];
    if (!admin) {
      throw new Error('no admin user for this connection');
    }

    const sharedOpts = {
      access_token: accessToken,
      organisation_id: conn.external_account_id,
      tenant_id: conn.tenant_id,
      subject_tenant_id: subj.id,
      ...(conn.last_synced_at ? { changed_since: conn.last_synced_at } : {}),
      sql_client: sql,
    };

    const employees = await syncEmployees({
      ...sharedOpts,
      invited_by_user_id: admin.user_id,
    });
    const timesheets = await pullTimesheets(sharedOpts);

    await sql`
      UPDATE integration_connection
         SET sync_state = 'idle',
             last_synced_at = NOW(),
             last_error = NULL
       WHERE id = ${connectionId}
    `;

    return {
      tenant_id: conn.tenant_id,
      provider: 'employment_hero',
      employees,
      timesheets,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await sql`
      UPDATE integration_connection
         SET sync_state = 'failed',
             last_error = ${msg}
       WHERE id = ${connectionId}
    `;
    return {
      tenant_id: conn.tenant_id,
      provider: 'employment_hero',
      employees: { upserted: 0, deactivated: 0 },
      timesheets: { inserted: 0, updated: 0, skipped_unmatched: 0 },
      error: msg,
    };
  }
}

/**
 * KeyPay sync orchestrator (T-B14).
 *
 * Mirrors `syncEmploymentHero` with two notable differences:
 *
 *   1. Auth: KeyPay uses a static API key, not OAuth. We re-purpose the
 *      `access_token_encrypted` column to store the encrypted API key
 *      (it's just an opaque encrypted secret either way) and leave
 *      `refresh_token_encrypted` NULL on KeyPay rows. There is no
 *      refresh dance — if the consultant rotates the key in KeyPay,
 *      KeyPay returns 401 and the orchestrator surfaces the error so
 *      the user re-runs the connect flow.
 *
 *   2. `external_account_id` carries the KeyPay business_id as a
 *      string. KeyPay business ids are numeric — we parse with
 *      `Number(...)` and tombstone the connection if parsing fails or
 *      yields a non-positive integer (mis-stored or hand-edited row).
 */
export async function syncKeypay(
  connectionId: string,
  deps: KeypaySyncDeps = {},
): Promise<SyncResult> {
  const sql = deps.sql_client ?? privilegedSql;
  const decrypt = deps.decrypt ?? decryptToken;
  const getKey = deps.get_encryption_key ?? getTokenEncryptionKey;
  const syncEmployees = deps.sync_employees ?? keypay.syncEmployees;
  const pullTimesheets = deps.pull_timesheets ?? keypay.pullTimesheets;

  const connRows = (await sql`
    SELECT tenant_id, access_token_encrypted, external_account_id, last_synced_at
      FROM integration_connection
     WHERE id = ${connectionId}
       AND provider = 'keypay'
       AND sync_state <> 'failed'
  `) as IntegrationConnectionRow[];
  const conn = connRows[0];
  if (!conn) {
    throw new Error(`integration_connection not found or failed: ${connectionId}`);
  }
  if (!conn.external_account_id) {
    await sql`
      UPDATE integration_connection
         SET sync_state = 'failed',
             last_error = 'external_account_id (business_id) required'
       WHERE id = ${connectionId}
    `;
    return {
      tenant_id: conn.tenant_id,
      provider: 'keypay',
      employees: { upserted: 0, deactivated: 0 },
      timesheets: { inserted: 0, updated: 0, skipped_unmatched: 0 },
      error: 'external_account_id (business_id) required',
    };
  }

  const businessId = Number(conn.external_account_id);
  if (!Number.isInteger(businessId) || businessId <= 0) {
    await sql`
      UPDATE integration_connection
         SET sync_state = 'failed',
             last_error = 'external_account_id (business_id) must be a positive integer'
       WHERE id = ${connectionId}
    `;
    return {
      tenant_id: conn.tenant_id,
      provider: 'keypay',
      employees: { upserted: 0, deactivated: 0 },
      timesheets: { inserted: 0, updated: 0, skipped_unmatched: 0 },
      error: 'external_account_id (business_id) must be a positive integer',
    };
  }

  await sql`
    UPDATE integration_connection
       SET sync_state = 'syncing'
     WHERE id = ${connectionId}
  `;

  try {
    const apiKey = decrypt(conn.access_token_encrypted, getKey());

    const subjRows = (await sql`
      SELECT id FROM subject_tenant
       WHERE tenant_id = ${conn.tenant_id}
         AND kind = 'claimant'
         AND deleted_at IS NULL
       ORDER BY created_at
       LIMIT 1
    `) as SubjectTenantRow[];
    const subj = subjRows[0];
    if (!subj) {
      throw new Error('no subject_tenant for this connection');
    }

    const adminRows = (await sql`
      SELECT user_id FROM tenant_user
       WHERE tenant_id = ${conn.tenant_id}
         AND role = 'admin'
         AND deleted_at IS NULL
       ORDER BY created_at
       LIMIT 1
    `) as AdminUserRow[];
    const admin = adminRows[0];
    if (!admin) {
      throw new Error('no admin user for this connection');
    }

    const sharedOpts = {
      api_key: apiKey,
      business_id: businessId,
      tenant_id: conn.tenant_id,
      subject_tenant_id: subj.id,
      ...(conn.last_synced_at ? { changed_since: conn.last_synced_at } : {}),
      sql_client: sql,
    };

    const employees = await syncEmployees({
      ...sharedOpts,
      invited_by_user_id: admin.user_id,
    });
    const timesheets = await pullTimesheets(sharedOpts);

    await sql`
      UPDATE integration_connection
         SET sync_state = 'idle',
             last_synced_at = NOW(),
             last_error = NULL
       WHERE id = ${connectionId}
    `;

    return {
      tenant_id: conn.tenant_id,
      provider: 'keypay',
      employees,
      timesheets,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await sql`
      UPDATE integration_connection
         SET sync_state = 'failed',
             last_error = ${msg}
       WHERE id = ${connectionId}
    `;
    return {
      tenant_id: conn.tenant_id,
      provider: 'keypay',
      employees: { upserted: 0, deactivated: 0 },
      timesheets: { inserted: 0, updated: 0, skipped_unmatched: 0 },
      error: msg,
    };
  }
}

/**
 * Deputy sync orchestrator (T-B17).
 *
 * Mirrors `syncEmploymentHero` (Deputy uses OAuth 2.0 like EH) with
 * three notable differences:
 *
 *   1. `external_account_id` carries the customer's Deputy install URL
 *      (e.g. 'https://acme.deputy.com'). Deputy is multi-tenant via
 *      DNS — every install lives on its own subdomain — so the client
 *      needs the URL on every call. We pass it through as
 *      `install_url` rather than `organisation_id`.
 *
 *   2. Token-expiry handling: Deputy access tokens expire (typically 24h).
 *      The OAuth helpers expose `refreshAccessToken`, but for v1 we
 *      defer the auto-refresh-and-persist dance to a follow-up task —
 *      if `expires_at` has passed we throw with a clear message so the
 *      consultant can reconnect manually. (TODO: invoke
 *      `deputy.refreshAccessToken`, encrypt the new tokens, UPDATE
 *      access_token_encrypted + refresh_token_encrypted + expires_at
 *      in-place, and continue. Tracked separately because the encrypt
 *      helper isn't exported from runtime yet.)
 *
 *   3. Timesheet result includes `skipped_discarded` — Deputy's
 *      soft-delete marker for cancelled shifts. We surface it on the
 *      `SyncResult.timesheets` object so audit/observability can spot
 *      drift between Deputy and our copy.
 */
export async function syncDeputy(
  connectionId: string,
  deps: DeputySyncDeps = {},
): Promise<SyncResult> {
  const sql = deps.sql_client ?? privilegedSql;
  const decrypt = deps.decrypt ?? decryptToken;
  const getKey = deps.get_encryption_key ?? getTokenEncryptionKey;
  const syncEmployees = deps.sync_employees ?? deputy.syncEmployees;
  const pullTimesheets = deps.pull_timesheets ?? deputy.pullTimesheets;

  const connRows = (await sql`
    SELECT tenant_id, access_token_encrypted, external_account_id, last_synced_at, expires_at
      FROM integration_connection
     WHERE id = ${connectionId}
       AND provider = 'deputy'
       AND sync_state <> 'failed'
  `) as IntegrationConnectionRow[];
  const conn = connRows[0];
  if (!conn) {
    throw new Error(`integration_connection not found or failed: ${connectionId}`);
  }
  if (!conn.external_account_id) {
    await sql`
      UPDATE integration_connection
         SET sync_state = 'failed',
             last_error = 'external_account_id (install_url) required'
       WHERE id = ${connectionId}
    `;
    return {
      tenant_id: conn.tenant_id,
      provider: 'deputy',
      employees: { upserted: 0, deactivated: 0 },
      timesheets: { inserted: 0, updated: 0, skipped_unmatched: 0 },
      error: 'external_account_id (install_url) required',
    };
  }

  // Token-expiry guard: v1 surfaces an error rather than refreshing
  // automatically. The DB column is non-null on all rows, but we treat
  // a missing value defensively as "not expired" — the access call will
  // surface the real 401 in that case.
  if (conn.expires_at && conn.expires_at.getTime() <= Date.now()) {
    const msg = 'deputy access token expired — reconnect required (auto-refresh TODO)';
    await sql`
      UPDATE integration_connection
         SET sync_state = 'failed',
             last_error = ${msg}
       WHERE id = ${connectionId}
    `;
    return {
      tenant_id: conn.tenant_id,
      provider: 'deputy',
      employees: { upserted: 0, deactivated: 0 },
      timesheets: { inserted: 0, updated: 0, skipped_unmatched: 0 },
      error: msg,
    };
  }

  await sql`
    UPDATE integration_connection
       SET sync_state = 'syncing'
     WHERE id = ${connectionId}
  `;

  try {
    const accessToken = decrypt(conn.access_token_encrypted, getKey());

    const subjRows = (await sql`
      SELECT id FROM subject_tenant
       WHERE tenant_id = ${conn.tenant_id}
         AND kind = 'claimant'
         AND deleted_at IS NULL
       ORDER BY created_at
       LIMIT 1
    `) as SubjectTenantRow[];
    const subj = subjRows[0];
    if (!subj) {
      throw new Error('no subject_tenant for this connection');
    }

    const adminRows = (await sql`
      SELECT user_id FROM tenant_user
       WHERE tenant_id = ${conn.tenant_id}
         AND role = 'admin'
         AND deleted_at IS NULL
       ORDER BY created_at
       LIMIT 1
    `) as AdminUserRow[];
    const admin = adminRows[0];
    if (!admin) {
      throw new Error('no admin user for this connection');
    }

    const sharedOpts = {
      access_token: accessToken,
      install_url: conn.external_account_id,
      tenant_id: conn.tenant_id,
      subject_tenant_id: subj.id,
      ...(conn.last_synced_at ? { changed_since: conn.last_synced_at } : {}),
      sql_client: sql,
    };

    const employees = await syncEmployees({
      ...sharedOpts,
      invited_by_user_id: admin.user_id,
    });
    const timesheets = await pullTimesheets(sharedOpts);

    await sql`
      UPDATE integration_connection
         SET sync_state = 'idle',
             last_synced_at = NOW(),
             last_error = NULL
       WHERE id = ${connectionId}
    `;

    return {
      tenant_id: conn.tenant_id,
      provider: 'deputy',
      employees,
      timesheets: {
        inserted: timesheets.inserted,
        updated: timesheets.updated,
        skipped_unmatched: timesheets.skipped_unmatched,
        skipped_discarded: timesheets.skipped_discarded,
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await sql`
      UPDATE integration_connection
         SET sync_state = 'failed',
             last_error = ${msg}
       WHERE id = ${connectionId}
    `;
    return {
      tenant_id: conn.tenant_id,
      provider: 'deputy',
      employees: { upserted: 0, deactivated: 0 },
      timesheets: { inserted: 0, updated: 0, skipped_unmatched: 0 },
      error: msg,
    };
  }
}

/**
 * Xero Payroll AU sync orchestrator (T-B20).
 *
 * Mirrors `syncDeputy` (Xero uses OAuth 2.0 like Deputy) with three
 * notable differences:
 *
 *   1. `external_account_id` carries the Xero **tenant_id** (a GUID)
 *      discovered after OAuth via `GET /connections`. Xero is multi-
 *      tenant via the `Xero-tenant-id` header — every API call sets
 *      this header alongside the bearer token. We pass it through as
 *      `xero_tenant_id` rather than `install_url` (Deputy) /
 *      `organisation_id` (EH) / `business_id` (KeyPay).
 *
 *   2. Token-expiry handling: Xero access tokens expire in ~30 minutes
 *      (much shorter than Deputy's 24h). The OAuth helpers expose
 *      `refreshAccessToken`, but for v1 we defer the auto-refresh-and-
 *      persist dance to a follow-up task — if `expires_at` has passed
 *      we throw with a clear message so the consultant can reconnect
 *      manually. Xero rotates refresh tokens on every refresh, so the
 *      auto-refresh implementation must persist BOTH the new
 *      access_token AND the new refresh_token. (TODO: invoke
 *      `xeroPayroll.refreshAccessToken`, encrypt both tokens, UPDATE
 *      access_token_encrypted + refresh_token_encrypted + expires_at
 *      in-place, and continue. Tracked separately because the encrypt
 *      helper isn't exported from runtime yet.)
 *
 *   3. Timesheet result includes `skipped_rejected` — Xero AU's
 *      consultant-rejected status. We surface it on the
 *      `SyncResult.timesheets` object so audit/observability can spot
 *      drift between Xero and our copy.
 */
export async function syncXeroPayroll(
  connectionId: string,
  deps: XeroPayrollSyncDeps = {},
): Promise<SyncResult> {
  const sql = deps.sql_client ?? privilegedSql;
  const decrypt = deps.decrypt ?? decryptToken;
  const getKey = deps.get_encryption_key ?? getTokenEncryptionKey;
  const syncEmployees = deps.sync_employees ?? xeroPayroll.syncEmployees;
  const pullTimesheets = deps.pull_timesheets ?? xeroPayroll.pullTimesheets;

  const connRows = (await sql`
    SELECT tenant_id, access_token_encrypted, external_account_id, last_synced_at, expires_at
      FROM integration_connection
     WHERE id = ${connectionId}
       AND provider = 'xero_payroll'
       AND sync_state <> 'failed'
  `) as IntegrationConnectionRow[];
  const conn = connRows[0];
  if (!conn) {
    throw new Error(`integration_connection not found or failed: ${connectionId}`);
  }
  if (!conn.external_account_id) {
    await sql`
      UPDATE integration_connection
         SET sync_state = 'failed',
             last_error = 'external_account_id (xero_tenant_id) required'
       WHERE id = ${connectionId}
    `;
    return {
      tenant_id: conn.tenant_id,
      provider: 'xero_payroll',
      employees: { upserted: 0, deactivated: 0 },
      timesheets: { inserted: 0, updated: 0, skipped_unmatched: 0 },
      error: 'external_account_id (xero_tenant_id) required',
    };
  }

  // Token-expiry guard: v1 surfaces an error rather than refreshing
  // automatically. Xero tokens expire in ~30 minutes — much tighter
  // than Deputy's 24h — so this guard fires more frequently in
  // practice and the auto-refresh follow-up is a higher priority.
  if (conn.expires_at && conn.expires_at.getTime() <= Date.now()) {
    const msg = 'xero access token expired — reconnect required (auto-refresh TODO)';
    await sql`
      UPDATE integration_connection
         SET sync_state = 'failed',
             last_error = ${msg}
       WHERE id = ${connectionId}
    `;
    return {
      tenant_id: conn.tenant_id,
      provider: 'xero_payroll',
      employees: { upserted: 0, deactivated: 0 },
      timesheets: { inserted: 0, updated: 0, skipped_unmatched: 0 },
      error: msg,
    };
  }

  await sql`
    UPDATE integration_connection
       SET sync_state = 'syncing'
     WHERE id = ${connectionId}
  `;

  try {
    const accessToken = decrypt(conn.access_token_encrypted, getKey());

    const subjRows = (await sql`
      SELECT id FROM subject_tenant
       WHERE tenant_id = ${conn.tenant_id}
         AND kind = 'claimant'
         AND deleted_at IS NULL
       ORDER BY created_at
       LIMIT 1
    `) as SubjectTenantRow[];
    const subj = subjRows[0];
    if (!subj) {
      throw new Error('no subject_tenant for this connection');
    }

    const adminRows = (await sql`
      SELECT user_id FROM tenant_user
       WHERE tenant_id = ${conn.tenant_id}
         AND role = 'admin'
         AND deleted_at IS NULL
       ORDER BY created_at
       LIMIT 1
    `) as AdminUserRow[];
    const admin = adminRows[0];
    if (!admin) {
      throw new Error('no admin user for this connection');
    }

    const sharedOpts = {
      access_token: accessToken,
      xero_tenant_id: conn.external_account_id,
      tenant_id: conn.tenant_id,
      subject_tenant_id: subj.id,
      ...(conn.last_synced_at ? { changed_since: conn.last_synced_at } : {}),
      sql_client: sql,
    };

    const employees = await syncEmployees({
      ...sharedOpts,
      invited_by_user_id: admin.user_id,
    });
    const timesheets = await pullTimesheets(sharedOpts);

    await sql`
      UPDATE integration_connection
         SET sync_state = 'idle',
             last_synced_at = NOW(),
             last_error = NULL
       WHERE id = ${connectionId}
    `;

    return {
      tenant_id: conn.tenant_id,
      provider: 'xero_payroll',
      employees,
      timesheets: {
        inserted: timesheets.inserted,
        updated: timesheets.updated,
        skipped_unmatched: timesheets.skipped_unmatched,
        skipped_rejected: timesheets.skipped_rejected,
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await sql`
      UPDATE integration_connection
         SET sync_state = 'failed',
             last_error = ${msg}
       WHERE id = ${connectionId}
    `;
    return {
      tenant_id: conn.tenant_id,
      provider: 'xero_payroll',
      employees: { upserted: 0, deactivated: 0 },
      timesheets: { inserted: 0, updated: 0, skipped_unmatched: 0 },
      error: msg,
    };
  }
}
