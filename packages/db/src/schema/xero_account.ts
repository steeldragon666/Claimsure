import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenant } from './tenant.js';

/**
 * Xero account cache (T-B5).
 *
 * One row per Xero account (chart-of-accounts entry) per Xero org per
 * tenant. Refreshed on every `syncAccounts` run; not a domain object
 * — purely a reference cache used by the F5 mapping-rule UI to power
 * account-code lookups (e.g. "what does code 400 map to in this
 * firm's chart of accounts?", "list expense accounts for the rule
 * dropdown").
 *
 * **Composite primary key**: `(tenant_id, xero_account_id)`. Xero
 * issues `AccountID` as a UUID-shaped string scoped to the Xero
 * organisation; combined with `tenant_id` we get cross-firm safety.
 * Note that Xero's `Code` (e.g. '400') is NOT globally unique across
 * orgs — two firms can both have a code '400' meaning different
 * things — so we keep `code` as a regular column, not the PK.
 *
 * **Pagination assumption**: chart-of-accounts is small (~50-200
 * entries per typical small-business Xero org); per Xero's docs the
 * `/Accounts` endpoint returns the full chart in one response and
 * does NOT advertise pagination metadata. The sync function performs
 * a single GET and treats the response as the full list. If a tenant
 * ever exceeds ~1000 accounts (a 5-10x outlier), the sync would still
 * complete — Xero's hard cap on a single response is much higher
 * than the cap on paginated endpoints — but a follow-up task would
 * add pagination then.
 *
 * **`type`** is one of Xero's account-class strings — `'EXPENSE' |
 * 'REVENUE' | 'BANK' | 'CURRENT' | 'EQUITY' | 'FIXED' | 'LIABILITY'
 * | …`. Stored as plain text so the schema doesn't have to track
 * Xero's evolving list. The mapping-rule UI filters to type='EXPENSE'
 * (and a few others) for the account-code dropdown.
 *
 * **`status`** is `'ACTIVE' | 'ARCHIVED'` per Xero's contract. We
 * sync ALL accounts (no status filter on the API call) so the UI can
 * surface archived accounts that older expenditures still reference.
 *
 * **`raw_payload`** carries the full Xero account JSON for audit
 * reconstruction.
 *
 * **`synced_at`** is refreshed on every UPSERT (sync sets
 * `synced_at = now()` in the `ON CONFLICT DO UPDATE` clause).
 *
 * **Index on `(tenant_id, code)`**: powers the F5 "look up account
 * code 400" query path. The composite-PK lookup is on `xero_account_id`,
 * not on `code`, so a separate index is needed for code-based reads.
 *
 * RLS-protected: same `tenant_id = current_setting('app.current_tenant_id')::uuid`
 * pattern as `expenditure` and the F1/F2 tenant-scoped tables.
 *
 * Naming convention: camelCase TS / snake_case SQL (per T5/T6 chain).
 */
export const xeroAccount = pgTable(
  'xero_account',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    // Xero AccountID — UUID-shaped, but not strictly UUIDv4. Stored as
    // text to avoid v4-validation issues.
    xeroAccountId: text('xero_account_id').notNull(),
    // Xero account code (e.g. "400"). NOT unique across tenants — see
    // header rationale.
    code: text('code').notNull(),
    name: text('name').notNull(),
    // Account class — 'EXPENSE' | 'REVENUE' | 'BANK' | ... Plain text.
    type: text('type').notNull(),
    // 'ACTIVE' | 'ARCHIVED'. Plain text — no CHECK.
    status: text('status').notNull(),
    // Full Xero account JSON for audit reconstruction.
    rawPayload: jsonb('raw_payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    // Refreshed on every UPSERT.
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.xeroAccountId] }),
    tenantCodeIdx: index('xero_account_tenant_code_idx').on(t.tenantId, t.code),
  }),
);
