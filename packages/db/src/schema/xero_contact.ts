import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenant } from './tenant.js';

/**
 * Xero contact cache (T-B5).
 *
 * One row per Xero contact (vendor/customer) per Xero org per tenant.
 * Refreshed on every `syncContacts` run; not a domain object — purely
 * a reference cache used by the F5 mapping-rule UI to power vendor
 * lookups (autocomplete, fuzzy match, "is this a known supplier?"
 * heuristics).
 *
 * **Composite primary key**: `(tenant_id, xero_contact_id)`. Xero
 * issues `ContactID` as a UUID-shaped string scoped to the Xero
 * organisation; combined with `tenant_id` we get cross-firm safety
 * even if two firms ever happen to share a Xero ContactID (vanishingly
 * unlikely in practice but the composite key removes the risk
 * entirely).
 *
 * **`raw_payload`** carries the full Xero contact JSON for audit
 * reconstruction; jsonb (not json) for query/index flexibility.
 *
 * **`is_supplier` / `is_customer`** mirror Xero's `IsSupplier` /
 * `IsCustomer` flags. The mapping-rule UI uses `is_supplier=true` to
 * scope vendor-pattern matching to actual ACCPAY counterparties (not
 * customers we're invoicing).
 *
 * **`contact_status`** is one of `'ACTIVE' | 'ARCHIVED' | 'GDPRREQUEST'`.
 * The sync filter pulls only ACTIVE rows from Xero, but the column is
 * left typed as plain `text` so a future Xero-side status addition
 * doesn't break the schema; the runtime guard surfaces unknown values
 * via the audit log.
 *
 * **`email`** is nullable: not all Xero contacts carry an email
 * (organisations often capture only a billing address + phone).
 *
 * **`synced_at`** is refreshed on every UPSERT — `now()` fires both
 * on INSERT (default) and on UPDATE (set in the sync function's
 * `ON CONFLICT DO UPDATE` clause).
 *
 * **GIN index on `to_tsvector('english', name)`**: hand-authored in
 * the migration (drizzle-kit cannot emit functional GIN indexes on a
 * text-search expression). Powers the F5 fuzzy vendor-match UI —
 * consultants typing "smith" should match "Smith Industries Pty
 * Ltd". A regular btree index on `name` would only support prefix
 * matches.
 *
 * RLS-protected: same `tenant_id = current_setting('app.current_tenant_id')::uuid`
 * pattern as `expenditure` and the F1/F2 tenant-scoped tables. The
 * sync worker writes via `privilegedSql` (RLS bypass — same rationale
 * as `sync-receipts.ts` et al.); read paths from the rules-engine UI
 * go through the cpa_app role.
 *
 * Naming convention: camelCase TS / snake_case SQL (per T5/T6 chain).
 */
export const xeroContact = pgTable(
  'xero_contact',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    // Xero ContactID — UUID-shaped, but not strictly UUIDv4. Stored as
    // text to avoid the v4-validation crash an `uuid` column would
    // raise on a Xero-shaped non-v4 id.
    xeroContactId: text('xero_contact_id').notNull(),
    name: text('name').notNull(),
    // Nullable — many Xero contacts have no email captured.
    email: text('email'),
    // Mirrors Xero's IsSupplier flag — used by the F5 rule engine to
    // scope vendor-pattern matching to ACCPAY counterparties.
    isSupplier: boolean('is_supplier').notNull().default(false),
    isCustomer: boolean('is_customer').notNull().default(false),
    // 'ACTIVE' | 'ARCHIVED' | 'GDPRREQUEST'. Plain text — no CHECK so
    // a future Xero-side addition doesn't fail the sync.
    contactStatus: text('contact_status').notNull(),
    // Full Xero contact JSON for audit reconstruction.
    rawPayload: jsonb('raw_payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    // Refreshed on every UPSERT (sync sets `synced_at = now()` in the
    // ON CONFLICT DO UPDATE clause).
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.xeroContactId] }),
    tenantIdx: index('xero_contact_tenant_idx').on(t.tenantId),
    // GIN index on to_tsvector('english', name) is hand-authored in
    // the migration — drizzle-kit can't emit functional GIN indexes.
  }),
);
