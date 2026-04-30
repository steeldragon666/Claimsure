import { sql } from 'drizzle-orm';
import {
  date,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { claim } from './claim.js';
import { subjectTenant } from './subject_tenant.js';
import { tenant } from './tenant.js';
import { user } from './user.js';

/**
 * Expenditure — a single spending event captured against a
 * `subject_tenant` for R&DTI apportionment (per design doc §"Core
 * tables"). One row per Xero invoice / bank tx / receipt or per manual
 * entry; line items live in `expenditure_line` and carry the
 * activity-level apportionment percentages.
 *
 * `source` discriminates origin. Xero-sourced rows carry the upstream
 * identifier in `source_external_id`; manual entries leave it null.
 * The partial unique index
 * `(tenant_id, source, source_external_id) WHERE source_external_id IS
 * NOT NULL` is declared in this schema and emitted by drizzle-kit (same
 * pattern as `event.idempotencyUnique` and `time_entry.payrollSourceDedupeUnique`).
 * It enforces dedupe so re-running a Xero sync upserts cleanly without
 * forcing uniqueness on manual entries.
 *
 * `raw_payload` carries the full upstream response (Xero JSON) for
 * audit reconstruction; jsonb (not json) for indexing flexibility.
 * Defaults to empty `{}` so manual route handlers can simply omit the
 * field; sync paths must populate with the full upstream payload.
 *
 * `expenditure_date` is a calendar date (the date the expense was
 * incurred — e.g. invoice date), distinct from `ingested_at` which is
 * the timestamptz when this row was synced into our system.
 *
 * `currency` is plain `text` here; F4 hand-authors a CHECK constraint
 * locking it to `'AUD'` for P4 (multi-currency may return in P9, hence
 * the column type is left open and the constraint sits at the DB
 * layer rather than the column type).
 *
 * `reimbursed_to_user_id` is non-null only for employee expense claims
 * (where the firm reimburses the user). FK to `user.id`.
 *
 * `voided_at` (nullable timestamptz) is the soft-void marker. Voided
 * expenditures stay queryable for audit but are filtered out of
 * apportionment calculations.
 *
 * RLS-protected (F4 hand-authors the policy alongside the CHECK
 * constraints): tenant_id =
 *   current_setting('app.current_tenant_id', true)::uuid
 *
 * Naming convention: camelCase TS / snake_case SQL (per T5/T6 chain).
 */

/**
 * Single source of truth for expenditure source classification.
 *
 * Keep in sync with the `expenditure_source_valid` CHECK constraint
 * hand-authored in F4 (migration 0013's appended block — see
 * DO-NOT-REGENERATE header in the .sql file). The Drizzle column type
 * uses `text({ enum: EXPENDITURE_SOURCES })` to narrow the TS type to
 * this union, so any divergence between this array and the SQL CHECK
 * would surface as a runtime constraint violation on insert/update.
 *
 * Consumers across the workspace (API routes, web components, Xero
 * sync workers) should import from this file rather than redeclare
 * the list — duplicated literal arrays drift silently and cannot be
 * caught by the type checker.
 */
export const EXPENDITURE_SOURCES = [
  'xero_invoice',
  'xero_bank_tx',
  'xero_receipt',
  'manual',
] as const;
export type ExpenditureSource = (typeof EXPENDITURE_SOURCES)[number];

export const expenditure = pgTable(
  'expenditure',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    subjectTenantId: uuid('subject_tenant_id')
      .notNull()
      .references(() => subjectTenant.id),
    // Discriminator; CHECK constraint hand-authored in F4 (0013 appended block).
    source: text('source', { enum: EXPENDITURE_SOURCES }).notNull(),
    // Upstream Xero ID; null for manual entries. Partial unique index
    // (tenant_id, source, source_external_id) WHERE source_external_id IS NOT NULL
    // is declared in the table options below.
    sourceExternalId: text('source_external_id'),
    vendorName: text('vendor_name').notNull(),
    // Invoice #, bank reference, receipt # — free-form upstream identifier.
    reference: text('reference'),
    // Calendar date of the expense itself (invoice date), not the sync time.
    expenditureDate: date('expenditure_date').notNull(),
    totalAmount: numeric('total_amount', { precision: 12, scale: 2 }).notNull(),
    // AUD only in P4; CHECK constraint hand-authored in F4.
    currency: text('currency').notNull(),
    // Non-null for employee expense claims (firm reimburses the user).
    reimbursedToUserId: uuid('reimbursed_to_user_id').references(() => user.id),
    // Full upstream response (Xero JSON) for audit reconstruction.
    // Defaults to `{}` so manual entries can omit the field; sync paths
    // must populate with the full upstream payload.
    rawPayload: jsonb('raw_payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
    // Soft-void marker; voided rows stay queryable but are filtered from apportionment.
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    // Denormalised FK to the claim this expenditure rolls up into (P5 Theme 1.2).
    // Nullable because unmapped expenditures are a real, valid state — Xero
    // sync ingests rows before the consultant has decided which claim they
    // belong to. Theme 5's mapping engine populates this once the consultant
    // signs off. No backfill in 0020 — pre-P5 rows stay NULL and Theme 5
    // assigns them on first review. Identity uniqueness stays on
    // (tenant_id, source, source_external_id); claim_id is descriptive.
    claimId: uuid('claim_id').references(() => claim.id),
  },
  (t) => ({
    tenantIdx: index('expenditure_tenant_idx').on(t.tenantId),
    subjectTenantIdx: index('expenditure_subject_tenant_idx').on(t.subjectTenantId),
    sourceIdx: index('expenditure_source_idx').on(t.source),
    claimIdx: index('expenditure_claim_id_idx').on(t.claimId),
    sourceExternalUnique: uniqueIndex('expenditure_source_external_unique')
      .on(t.tenantId, t.source, t.sourceExternalId)
      .where(sql`${t.sourceExternalId} IS NOT NULL`),
  }),
);
