import { index, integer, numeric, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { expenditure } from './expenditure.js';

/**
 * Expenditure line — a single line item within an `expenditure` row,
 * carrying the per-account-code amount and (after consultant review)
 * the R&D apportionment percentage (per design doc §"Core tables").
 *
 * One expenditure typically has one-to-many lines:
 *   - A Xero invoice with multiple line items splits into N rows
 *     here.
 *   - A bank transaction or receipt usually maps to a single line
 *     (the whole amount).
 *
 * `account_code` is the upstream Xero account code (e.g. "400", "404")
 * — used by the mapping rule engine in F5 to suggest a default
 * `rd_percent` based on the consultant's prior decisions.
 *
 * `amount` matches the upstream line amount; the sum of lines should
 * equal `expenditure.total_amount` minus any tax/fee variations
 * (validation lives in the route layer, not as a DB constraint).
 *
 * `rd_percent` is nullable: null means the line is unmapped (awaiting
 * consultant review). Once mapped, it sits in [0, 100] — the 0-100
 * CHECK constraint is hand-authored in F4.
 *
 * No tenant_id column on this table — and this is an intentional
 * deviation from the F1 convention. F1 child tables that carry tenant
 * data (see `subject_tenant_employee.ts`, `media_artefact.ts`,
 * `time_entry.ts`) denormalise `tenant_id` and get their own direct
 * RLS policy in 0008. Here, we deliberately do NOT denormalise:
 * isolation is by access path, not by RLS. Routes that read/write
 * `expenditure_line` always join through `expenditure` (which IS
 * RLS-protected on `tenant_id`), so the parent's policy gates the
 * data the route can see. Inserts/deletes go via the same routes,
 * which establish tenant context via the parent before touching the
 * children. The FK constraint guarantees no orphan lines exist.
 *
 * IMPORTANT: Postgres RLS does NOT walk FKs automatically. A raw
 * `SELECT * FROM expenditure_line` as `cpa_app` would NOT be filtered
 * by `expenditure`'s tenant policy. Protection here is enforced by
 * code path (route handlers / views that always join `expenditure`)
 * plus GRANT scoping, not by row-level security on this table.
 *
 * F4 directive: F4 will NOT enable RLS on `expenditure_line` and will
 * NOT add a tenant-isolation policy. F4 will GRANT to `cpa_app` and
 * rely on the route layer / parent join for isolation.
 *
 * No created_at / updated_at: lines are immutable from the
 * sync/ingestion layer's perspective (re-syncing replaces the parent
 * expenditure's lines as a unit). The route layer handles this as
 * delete+reinsert under one transaction.
 *
 * FK does NOT carry ON DELETE CASCADE in this initial F3 schema —
 * Drizzle does not emit cascade by default and the design doc does
 * not commit to cascade semantics. F4 (or a later task) can layer
 * cascade on if the route layer's delete+reinsert pattern proves
 * insufficient.
 *
 * Naming convention: camelCase TS / snake_case SQL (per T5/T6 chain).
 */
export const expenditureLine = pgTable(
  'expenditure_line',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    expenditureId: uuid('expenditure_id')
      .notNull()
      .references(() => expenditure.id),
    description: text('description').notNull(),
    // Xero account code (e.g. "400"); used for mapping-rule lookup in F5.
    accountCode: text('account_code'),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    // Apportionment % (0-100); null = unmapped. CHECK 0-100 hand-authored in F4.
    rdPercent: integer('rd_percent'),
    // 1-based authored line number (P5 Theme 1.3). NOT NULL DEFAULT 1 so
    // the migration backfills every existing row to 1 (existing data is
    // single-line in practice). Sync paths and manual route handlers
    // stamp a per-line sequence at insert time so downstream consumers
    // (preview-rules multi-line picker, expenditure schedule UI, audit
    // reports) can order by an authored, semantically-meaningful sequence
    // instead of UUID lexicographic order. Per-expenditure uniqueness is
    // enforced by `lineNumberUnique` below.
    lineNumber: integer('line_number').notNull().default(1),
  },
  (t) => ({
    expenditureIdx: index('expenditure_line_expenditure_idx').on(t.expenditureId),
    lineNumberUnique: uniqueIndex('expenditure_line_number_unique').on(
      t.expenditureId,
      t.lineNumber,
    ),
  }),
);
