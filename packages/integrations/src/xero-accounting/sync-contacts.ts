import { privilegedSql } from '@cpa/db/client';
import { xeroAccountingGet } from './client.js';

/**
 * Xero Accounting contacts sync (T-B5).
 *
 * Walks every page of the Xero `/Contacts` endpoint and UPSERTs each
 * **ACTIVE** contact into the `xero_contact` cache table. This is a
 * pure reference cache — no event-chain integration, no domain rows
 * are touched. Refreshed on every sync run; the F5 mapping-rule UI
 * reads from this cache to power vendor-name autocomplete and
 * fuzzy-match heuristics.
 *
 * **Modes** (mirrors B2/B3/B4):
 *   - `backfill`: no `If-Modified-Since`. Used for the initial connect-
 *     + import flow — pulls every ACTIVE contact the connection has
 *     access to. Idempotent: the composite primary key
 *     `(tenant_id, xero_contact_id)` means re-running an already-
 *     completed backfill UPDATEs the matched rows in place.
 *   - `incremental`: `If-Modified-Since: <since.toUTCString()>`. Used by
 *     the periodic worker — Xero returns only contacts touched at-or-
 *     after `since`. New rows insert; touched-but-pre-existing rows
 *     UPDATE.
 *
 * **Pagination**: Xero's documented hard cap on Accounting endpoints is
 * 100 items per page. We send `?pageSize=100` explicitly and loop
 * until we get a short page (< 100 results), same shape as B2/B3/B4.
 *
 * **ACTIVE filter**: applied via Xero's `where` syntax —
 * `where=ContactStatus=="ACTIVE"`. Doing the filter at the API layer
 * avoids paying for round-trips that return ARCHIVED rows we'd
 * discard locally. The fixture covers an ARCHIVED row so the test
 * suite verifies the local guard rejects it too if Xero's filter ever
 * misbehaves.
 *
 * **No event chain**: cache tables are NOT domain events. Unlike B2-B4
 * which write `EXPENDITURE_INGESTED` on every new expenditure, B5
 * does NOT call `insertEventWithChain`. The mapping-rule UI cares
 * about the *current* state of vendors, not the history of when each
 * one was first seen.
 *
 * **UPSERT semantics**:
 *   - Match key: composite PK `(tenant_id, xero_contact_id)`.
 *   - On hit: UPDATE all mutable fields (name, email, is_supplier,
 *     is_customer, contact_status, raw_payload). Always set
 *     `synced_at = now()` so the rules-engine UI can surface "last
 *     refreshed N hours ago".
 *   - On miss: INSERT.
 *   - Implementation: a single `INSERT ... ON CONFLICT (tenant_id,
 *     xero_contact_id) DO UPDATE SET ...` statement — atomic, single
 *     round-trip, returns whether we INSERTed (xmax = 0) or UPDATEd
 *     (xmax != 0) so we can populate the inserted/updated counters
 *     without a separate read-then-write.
 *
 * Privileged SQL — same rationale as `sync-receipts.ts` and the
 * payroll sync workers. The sync worker runs out-of-band with no
 * request session, so it bypasses RLS via `privilegedSql`. Tests
 * inject a mock `sql_client` mirroring the postgres-js template-tag
 * interface.
 */

export type SqlClient = typeof privilegedSql;

export interface SyncContactsConnection {
  /** integration_connection.id — used for trace logging only. */
  id: string;
  /** owning tenant_id — drives RLS and the composite PK. */
  tenant_id: string;
  /** Xero org tenant_id (the `Xero-tenant-id` header value). */
  xero_tenant_id: string;
  /** Decrypted access token (caller decrypts via `decryptToken`). */
  access_token: string;
}

export interface SyncContactsOptions {
  mode: 'backfill' | 'incremental';
  /** Required if mode='incremental'. Sent as If-Modified-Since header. */
  since?: Date;
  /** Override for tests; defaults to the privileged DB client. */
  sql_client?: SqlClient;
  /** Test override for the API base URL — forwarded to xeroAccountingGet. */
  base_url?: string;
}

export interface SyncContactsResult {
  /** Number of contacts fetched from Xero (paginated total, ACTIVE only). */
  fetched: number;
  /** Number of new xero_contact rows inserted. */
  inserted: number;
  /** Number of existing xero_contact rows updated (idempotent re-sync). */
  updated: number;
}

const PAGE_SIZE = 100;

interface XeroContact {
  ContactID: string;
  // 'ACTIVE' | 'ARCHIVED' | 'GDPRREQUEST' are the documented values;
  // typed as plain string to allow future Xero additions without a
  // type diff.
  ContactStatus?: string;
  Name?: string;
  EmailAddress?: string;
  IsSupplier?: boolean;
  IsCustomer?: boolean;
}

interface XeroContactsResponse {
  Contacts?: XeroContact[];
}

export async function syncContacts(
  connection: SyncContactsConnection,
  options: SyncContactsOptions,
): Promise<SyncContactsResult> {
  const sql = options.sql_client ?? privilegedSql;

  if (options.mode === 'incremental' && !options.since) {
    throw new Error(
      'syncContacts: mode=incremental requires `since` — pass the last successful sync timestamp',
    );
  }

  const result: SyncContactsResult = {
    fetched: 0,
    inserted: 0,
    updated: 0,
  };

  let page = 1;
  while (true) {
    const query: Record<string, string> = {
      // ACTIVE-only filter at the API layer — see header comment.
      where: 'ContactStatus=="ACTIVE"',
      page: String(page),
      pageSize: String(PAGE_SIZE),
    };

    const extraHeaders: Record<string, string> = {};
    if (options.mode === 'incremental' && options.since) {
      // Xero documents `If-Modified-Since` as the canonical incremental
      // filter. UTCString is the RFC 7231 IMF-fixdate format servers
      // expect — matches the B2/B3/B4 sibling syncs for parity.
      extraHeaders['If-Modified-Since'] = options.since.toUTCString();
    }

    const data = (await xeroAccountingGet(
      {
        access_token: connection.access_token,
        xero_tenant_id: connection.xero_tenant_id,
        ...(options.base_url !== undefined ? { base_url: options.base_url } : {}),
      },
      '/Contacts',
      query,
      extraHeaders,
    )) as XeroContactsResponse;

    const contacts = data.Contacts ?? [];

    for (const c of contacts) {
      // Defensive: belt-and-braces filter in case Xero's `where`
      // parameter ever drops the constraint or surfaces a malformed
      // row. The test suite exercises this branch with a mixed
      // ACTIVE/ARCHIVED fixture even though the production API call
      // is filtered.
      if (c.ContactStatus !== 'ACTIVE') continue;

      result.fetched++;

      const name = c.Name ?? '(unnamed contact)';
      const email = c.EmailAddress ?? null;
      const isSupplier = c.IsSupplier === true;
      const isCustomer = c.IsCustomer === true;
      const contactStatus = c.ContactStatus;
      const rawPayload = JSON.stringify(c);

      // Single-statement UPSERT — atomic and round-trip-efficient.
      // The `xmax = 0` trick distinguishes INSERT from UPDATE: on
      // INSERT, xmax is 0 (the row was just created and has no
      // outstanding update transaction); on UPDATE, xmax is non-zero
      // (the prior row's MVCC slot is being superseded by this
      // statement's transaction). Documented Postgres pattern — see
      // https://stackoverflow.com/a/39204667 for the canonical
      // explanation. Robust across all Postgres versions used in CI.
      const rows = (await sql`
        INSERT INTO xero_contact (
          tenant_id, xero_contact_id, name, email,
          is_supplier, is_customer, contact_status, raw_payload, synced_at
        ) VALUES (
          ${connection.tenant_id}, ${c.ContactID}, ${name}, ${email},
          ${isSupplier}, ${isCustomer}, ${contactStatus}, ${rawPayload}::jsonb, now()
        )
        ON CONFLICT (tenant_id, xero_contact_id) DO UPDATE SET
          name = EXCLUDED.name,
          email = EXCLUDED.email,
          is_supplier = EXCLUDED.is_supplier,
          is_customer = EXCLUDED.is_customer,
          contact_status = EXCLUDED.contact_status,
          raw_payload = EXCLUDED.raw_payload,
          synced_at = now()
        RETURNING (xmax = 0) AS inserted
      `) as Array<{ inserted: boolean }>;

      const upsertedRow = rows[0];
      if (!upsertedRow) {
        // Defensive: an UPSERT with RETURNING should always emit one
        // row. A zero-row response indicates a driver-level oddity
        // — fail loudly rather than silently miscount.
        throw new Error(
          `syncContacts: UPSERT into xero_contact returned no row (contact=${c.ContactID})`,
        );
      }
      if (upsertedRow.inserted) {
        result.inserted++;
      } else {
        result.updated++;
      }
    }

    // Short page → done. Xero's documented contract: a full page of
    // PAGE_SIZE items signals more pages remain; anything less means
    // we've hit the end. (Empty pages also terminate.)
    if (contacts.length < PAGE_SIZE) break;
    page++;
  }

  return result;
}
