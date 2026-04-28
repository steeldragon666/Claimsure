import { privilegedSql } from '@cpa/db/client';
import { insertEventWithChain } from '@cpa/db';
import { ExpenditureIngestedPayload } from '@cpa/schemas';
import { parseXeroDate, xeroAccountingGet } from './client.js';

/**
 * Xero Accounting receipts sync (T-B4).
 *
 * Walks every page of the Xero `/Receipts` endpoint and upserts each
 * **AUTHORISED** receipt into `expenditure` plus its line items into
 * `expenditure_line`. Receipts in Xero go through a
 * `DRAFT → SUBMITTED → AUTHORISED` workflow; only AUTHORISED rows have
 * a stable `Date` and final `Total`, so we filter to that status both
 * via Xero's `where` query parameter and as a defensive client-side
 * guard. Unlike Invoices (B2) or BankTransactions (B3), Receipts have
 * no `Type` field — every receipt is an out-of-pocket employee
 * expenditure by definition.
 *
 * **Modes** (per plan, mirrors B2/B3):
 *   - `backfill`: no `If-Modified-Since`. Used for the initial connect-
 *     + import flow — pulls every AUTHORISED receipt the connection
 *     has access to. Idempotent: the partial unique index
 *     `(tenant_id, source='xero_receipt', source_external_id)` means
 *     re-running an already-completed backfill UPDATEs the matched rows
 *     in place rather than duplicating.
 *   - `incremental`: `If-Modified-Since: <since.toUTCString()>`. Used by
 *     the periodic worker — Xero returns only receipts touched at-or-
 *     after `since`. New rows insert + emit `EXPENDITURE_INGESTED`;
 *     touched-but-pre-existing rows UPDATE without emitting an event
 *     (the event already exists in the chain).
 *
 * **Pagination**: Xero's documented hard cap on Accounting endpoints is
 * 100 items per page (the plan said 200, but Xero rejects pageSize >
 * 100 — see https://developer.xero.com/documentation/api/accounting/requests-and-responses).
 * We send `?pageSize=100` explicitly and loop until we get a short page
 * (< 100 results).
 *
 * **AUTHORISED filter**: applied via Xero's `where` syntax —
 * `where=Status=="AUTHORISED"`. Doing the filter in the API request
 * avoids paying for a round-trip that returns DRAFT/SUBMITTED rows
 * we'd discard locally. The fixture includes one DRAFT row so the test
 * suite verifies the local guard rejects it too in case Xero's filter
 * ever misbehaves.
 *
 * **Reimbursee email mapping** (B4-specific, the only divergence from
 * B2/B3): Xero attaches a `User` object to each receipt — the firm
 * employee who incurred the expense and is being reimbursed. We map
 * Xero's `User.Email` to our `user.id` by joining through `tenant_user`
 * to ensure the matched user is actually a member of this firm — a
 * pure `user WHERE email = $1` lookup would silently match a user who
 * happens to share the email but belongs to a different firm. This
 * happens both on INSERT (set `reimbursed_to_user_id`) and on UPDATE
 * (re-resolve in case the user's email changed in our system).
 *
 *   - Match found in tenant_user: set `expenditure.reimbursed_to_user_id`.
 *   - No match (user not in this firm, or email not registered yet):
 *     leave `reimbursed_to_user_id = null`. The reimbursee can be
 *     resolved later by a manual link in the consultant UI.
 *
 * Soft-deleted users (user.deleted_at IS NOT NULL or
 * tenant_user.deleted_at IS NOT NULL) are excluded from the match —
 * the reimbursement target must be an active firm member.
 *
 * **Upsert semantics** (mirrors B2/B3):
 *   - Match key: `(tenant_id, source='xero_receipt', source_external_id=<ReceiptID>)`
 *     enforced by the F3 partial unique index.
 *   - On hit (existing row): UPDATE all mutable fields (vendor_name,
 *     expenditure_date, total_amount, currency, raw_payload, reference,
 *     reimbursed_to_user_id). Do NOT write a new EXPENDITURE_INGESTED
 *     event — the chain already records the original ingestion.
 *   - On miss (new row): INSERT, then write an EXPENDITURE_INGESTED
 *     event via `insertEventWithChain`.
 *   - `expenditure_line`: full-replace on every upsert — DELETE existing
 *     lines for the expenditure_id, then INSERT the current Xero line
 *     shape. Xero is the source of truth for lines, and partial-update
 *     semantics would risk leaving orphan lines after a Xero-side delete.
 *
 * **Currency**: P4 is AUD-only (the F4 CHECK constraint enforces
 * `currency = 'AUD'`). Non-AUD receipts throw a descriptive error
 * before INSERT so the caller (and the operator reading logs) can see
 * which row tripped it. Multi-currency support is tracked for P9.
 *
 * **Subject_tenant resolution** (mirrors B2/B3): receipts in Xero are
 * not associated with a specific R&D claimant — they're Xero-org-wide.
 * The `connection` input here doesn't carry a `subject_tenant_id`
 * because receipt ingestion is a tenant-level activity; the
 * apportionment step (F5, mapping rules) is what associates a line
 * item with a specific subject_tenant + activity. For the
 * EXPENDITURE_INGESTED event we use the firm's "self" subject_tenant
 * row (created during tenant onboarding in P0/P1) — looked up by
 * tenant_id.
 *
 * Privileged SQL — same rationale as the payroll sync workers in
 * `payroll/xero-payroll/*-sync.ts` and the sibling `sync-bank-tx.ts` /
 * `sync-invoices.ts`. The sync worker runs out-of-band with no request
 * session, so it bypasses RLS via `privilegedSql`. Tests inject a mock
 * `sql_client` mirroring the postgres-js template-tag interface.
 */

export type SqlClient = typeof privilegedSql;
export type ChainInserter = typeof insertEventWithChain;

export interface SyncReceiptsConnection {
  /** integration_connection.id — used for trace logging only. */
  id: string;
  /** owning tenant_id — drives RLS, the partial unique key, and the chain. */
  tenant_id: string;
  /** Xero org tenant_id (the `Xero-tenant-id` header value). */
  xero_tenant_id: string;
  /** Decrypted access token (caller decrypts via `decryptToken`). */
  access_token: string;
}

export interface SyncReceiptsOptions {
  mode: 'backfill' | 'incremental';
  /** Required if mode='incremental'. Sent as If-Modified-Since header. */
  since?: Date;
  /** Override for tests; defaults to the privileged DB client. */
  sql_client?: SqlClient;
  /** Override for tests; defaults to `insertEventWithChain` from `@cpa/db`. */
  chain_insert?: ChainInserter;
  /** Test override for the API base URL — forwarded to xeroAccountingGet. */
  base_url?: string;
}

export interface SyncReceiptsResult {
  /** Number of receipts fetched from Xero (paginated total, AUTHORISED only). */
  fetched: number;
  /** Number of new expenditure rows inserted. */
  inserted: number;
  /** Number of existing expenditure rows updated (idempotent re-sync). */
  updated: number;
  /** Number of expenditure_line rows total (sum across inserted+updated). */
  lines: number;
  /** Number of EXPENDITURE_INGESTED events written (= inserted, never on update). */
  events_written: number;
  /** Number of receipts whose submitter email resolved to a firm user (reimbursed_to_user_id set). */
  reimbursee_matched: number;
}

const PAGE_SIZE = 100;

interface XeroReceiptContact {
  ContactID?: string;
  Name?: string;
}

interface XeroReceiptUser {
  UserID?: string;
  Email?: string;
  FirstName?: string;
  LastName?: string;
}

interface XeroReceiptLineItem {
  LineItemID?: string;
  Description?: string;
  Quantity?: number;
  UnitAmount?: string | number;
  LineAmount?: string | number;
  AccountCode?: string;
}

interface XeroReceipt {
  ReceiptID: string;
  // 'DRAFT' | 'SUBMITTED' | 'AUTHORISED' are the documented values;
  // we type as plain string to allow future Xero additions without a
  // type diff. The runtime guard `r.Status !== 'AUTHORISED'` handles
  // filtering.
  Status?: string;
  Date?: string;
  Contact?: XeroReceiptContact;
  User?: XeroReceiptUser;
  Reference?: string;
  CurrencyCode?: string;
  Total?: string | number;
  LineItems?: XeroReceiptLineItem[];
}

interface XeroReceiptsResponse {
  Receipts?: XeroReceipt[];
}

/**
 * Format a Date as the YYYY-MM-DD string the Postgres `date` column
 * expects. Slicing the ISO string keeps us in UTC, which matches the
 * way Xero emits receipt dates (their `/Date(epoch+0000)/` format is
 * UTC absolute millis — see parseXeroDate's docstring).
 */
function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Coerce a numeric amount that may arrive as either a string ("85.50")
 * or a number (85.5) into the canonical "N.NN" string Postgres NUMERIC
 * accepts and our schema regex enforces. The two-decimal pad matches
 * the storage shape — we don't synthesise precision Xero didn't send,
 * but we DO normalise integers and one-decimal forms.
 */
function toAmountString(v: string | number | undefined): string {
  if (typeof v === 'number') return v.toFixed(2);
  if (typeof v === 'string' && v.length > 0) {
    const n = Number(v);
    if (Number.isFinite(n)) return n.toFixed(2);
    return v;
  }
  return '0.00';
}

/**
 * Resolve a Xero submitter email to a `user.id` scoped to the given
 * tenant. Joins through `tenant_user` (filtering soft-deleted rows)
 * so the matched user must be an active member of this firm — guards
 * against accidentally tagging an expense to a user who happens to
 * share the email but isn't part of the tenant.
 *
 * Returns `null` for a missing/empty email or no match.
 */
async function resolveReimbursedUserId(
  sql: SqlClient,
  tenantId: string,
  email: string | undefined,
): Promise<string | null> {
  if (!email) return null;
  const rows = (await sql`
    SELECT u.id
      FROM "user" u
      JOIN tenant_user tu ON tu.user_id = u.id
     WHERE u.email = ${email}
       AND tu.tenant_id = ${tenantId}
       AND u.deleted_at IS NULL
       AND tu.deleted_at IS NULL
     LIMIT 1
  `) as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

export async function syncReceipts(
  connection: SyncReceiptsConnection,
  options: SyncReceiptsOptions,
): Promise<SyncReceiptsResult> {
  const sql = options.sql_client ?? privilegedSql;
  const chainInsert = options.chain_insert ?? insertEventWithChain;

  if (options.mode === 'incremental' && !options.since) {
    throw new Error(
      'syncReceipts: mode=incremental requires `since` — pass the last successful sync timestamp',
    );
  }

  const result: SyncReceiptsResult = {
    fetched: 0,
    inserted: 0,
    updated: 0,
    lines: 0,
    events_written: 0,
    reimbursee_matched: 0,
  };

  let page = 1;
  while (true) {
    const query: Record<string, string> = {
      // AUTHORISED-only filter at the API layer — see header comment.
      where: 'Status=="AUTHORISED"',
      page: String(page),
      pageSize: String(PAGE_SIZE),
    };

    const extraHeaders: Record<string, string> = {};
    if (options.mode === 'incremental' && options.since) {
      // Xero documents `If-Modified-Since` as the canonical incremental
      // filter. UTCString is the RFC 7231 IMF-fixdate format servers
      // expect; toISOString would also work but UTCString is the
      // documented form and matches the payroll variant for parity.
      extraHeaders['If-Modified-Since'] = options.since.toUTCString();
    }

    const data = (await xeroAccountingGet(
      {
        access_token: connection.access_token,
        xero_tenant_id: connection.xero_tenant_id,
        ...(options.base_url !== undefined ? { base_url: options.base_url } : {}),
      },
      '/Receipts',
      query,
      extraHeaders,
    )) as XeroReceiptsResponse;

    const receipts = data.Receipts ?? [];

    for (const r of receipts) {
      // Defensive: belt-and-braces filter in case Xero's `where`
      // parameter ever drops the constraint or surfaces a malformed row.
      // The test suite exercises this branch with a mixed AUTHORISED/
      // DRAFT fixture even though the production API call is filtered.
      if (r.Status !== 'AUTHORISED') continue;

      result.fetched++;

      const currency = r.CurrencyCode ?? 'AUD';
      if (currency !== 'AUD') {
        throw new Error(
          `Non-AUD receipt unsupported in P4: tenant=${connection.tenant_id} receipt=${r.ReceiptID} currency=${currency}`,
        );
      }

      const rDate = parseXeroDate(r.Date);
      if (!rDate) {
        // AUTHORISED receipts always carry a Date — but be defensive: a
        // malformed wire response shouldn't crash the whole sync. Log
        // via thrown error so the operator can investigate.
        throw new Error(
          `syncReceipts: receipt ${r.ReceiptID} has missing/unparseable Date "${r.Date}"`,
        );
      }
      const expenditureDate = toDateOnly(rDate);
      const vendorName = r.Contact?.Name ?? '(unknown vendor)';
      const reference = r.Reference ?? null;
      const totalAmount = toAmountString(r.Total);
      const rawPayload = JSON.stringify(r);

      // Resolve the Xero submitter's email to a firm-scoped user.id.
      // Performed for both INSERT and UPDATE paths so an email change
      // in our system propagates on the next sync.
      const reimbursedToUserId = await resolveReimbursedUserId(
        sql,
        connection.tenant_id,
        r.User?.Email,
      );
      if (reimbursedToUserId) result.reimbursee_matched++;

      // Look up the existing expenditure row by the F3 partial unique
      // key. We cannot use ON CONFLICT here because we want to know
      // whether the operation was an INSERT or an UPDATE — this drives
      // the EXPENDITURE_INGESTED event-emission decision.
      const existingRows = (await sql`
        SELECT id FROM expenditure
         WHERE tenant_id = ${connection.tenant_id}
           AND source = 'xero_receipt'
           AND source_external_id = ${r.ReceiptID}
      `) as Array<{ id: string }>;
      const existing = existingRows[0];

      let expenditureId: string;
      let wasInsert: boolean;
      if (existing) {
        expenditureId = existing.id;
        wasInsert = false;
        await sql`
          UPDATE expenditure
             SET vendor_name = ${vendorName},
                 reference = ${reference},
                 expenditure_date = ${expenditureDate},
                 total_amount = ${totalAmount},
                 currency = ${currency},
                 reimbursed_to_user_id = ${reimbursedToUserId},
                 raw_payload = ${rawPayload}::jsonb
           WHERE id = ${expenditureId}
        `;
        result.updated++;
      } else {
        // We need to know the subject_tenant_id for this tenant — see
        // header comment on subject_tenant resolution. The "self"
        // subject_tenant row exists for every tenant (created during
        // tenant onboarding in P0/P1).
        const subjectTenantRows = (await sql`
          SELECT id FROM subject_tenant
           WHERE tenant_id = ${connection.tenant_id}
           ORDER BY created_at ASC
           LIMIT 1
        `) as Array<{ id: string }>;
        const subjectTenant = subjectTenantRows[0];
        if (!subjectTenant) {
          throw new Error(
            `syncReceipts: tenant ${connection.tenant_id} has no subject_tenant — onboarding incomplete`,
          );
        }

        const insertedRows = (await sql`
          INSERT INTO expenditure (
            tenant_id, subject_tenant_id, source, source_external_id,
            vendor_name, reference, expenditure_date, total_amount, currency,
            reimbursed_to_user_id, raw_payload
          ) VALUES (
            ${connection.tenant_id}, ${subjectTenant.id}, 'xero_receipt', ${r.ReceiptID},
            ${vendorName}, ${reference}, ${expenditureDate}, ${totalAmount}, ${currency},
            ${reimbursedToUserId}, ${rawPayload}::jsonb
          )
          RETURNING id
        `) as Array<{ id: string }>;
        const insertedRow = insertedRows[0];
        if (!insertedRow) {
          throw new Error(
            `syncReceipts: INSERT into expenditure returned no row (receipt=${r.ReceiptID})`,
          );
        }
        expenditureId = insertedRow.id;
        wasInsert = true;
        result.inserted++;

        // EXPENDITURE_INGESTED event — only on insert. Match the
        // ExpenditureIngestedPayload schema in @cpa/schemas/event.ts.
        const lineCount = r.LineItems?.length ?? 0;
        // Boundary-validate the payload (A1 fix #5 pattern). Programming-error
        // guard: any drift in ExpenditureIngestedPayload's shape fails here
        // instead of landing malformed events on the chain.
        const ingestedPayload = ExpenditureIngestedPayload.parse({
          expenditure_id: expenditureId,
          source: 'xero_receipt',
          vendor_name: vendorName,
          line_count: lineCount,
        });
        await chainInsert({
          tenant_id: connection.tenant_id,
          subject_tenant_id: subjectTenant.id,
          kind: 'EXPENDITURE_INGESTED',
          payload: ingestedPayload,
          classification: null,
          captured_at: new Date(),
          // Sync worker — no human captured this. The
          // captured_by_user_id NOT NULL convention used in the request
          // path doesn't apply here; chain.ts canonicalises null
          // user_id and null employee_id together for the hash.
          captured_by_user_id: null,
          override_of_event_id: null,
          override_new_kind: null,
          override_reason: null,
        });
        result.events_written++;
      }

      // Lines — full-replace. Delete first (no-op on insert; expected on
      // update), then insert the current Xero shape. The route layer's
      // delete+reinsert pattern (per expenditure_line.ts header) is the
      // sanctioned way to mutate lines.
      if (!wasInsert) {
        await sql`DELETE FROM expenditure_line WHERE expenditure_id = ${expenditureId}`;
      }
      const lines = r.LineItems ?? [];
      for (const line of lines) {
        await sql`
          INSERT INTO expenditure_line (
            expenditure_id, description, account_code, amount
          ) VALUES (
            ${expenditureId}, ${line.Description ?? ''},
            ${line.AccountCode ?? null}, ${toAmountString(line.LineAmount ?? line.UnitAmount)}
          )
        `;
        result.lines++;
      }
    }

    // Short page → done. Xero's documented contract: a full page of
    // PAGE_SIZE items signals more pages remain; anything less means
    // we've hit the end. (Empty pages also terminate.)
    if (receipts.length < PAGE_SIZE) break;
    page++;
  }

  return result;
}
