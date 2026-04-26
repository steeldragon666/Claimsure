import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { subjectTenant } from './subject_tenant.js';
import { tenant } from './tenant.js';
import { user } from './user.js';

/**
 * Federation primitive — record of a scoped read token issued to an
 * external party (typically a financier or auditor) granting them
 * time-limited access to a subject_tenant's data.
 *
 * P1 ships the schema only. The API endpoints that issue + redeem
 * tokens land in P8 (per architecture design doc §3.6).
 *
 * The actual signed token (JWT or similar) lives in URLs / emails
 * and is verified per-request; this row is the AUDIT RECORD of who
 * issued what to whom, when, and what scope.
 *
 * APPEND-ONLY: no deletedAt column. Once issued, tokens are revoked
 * via revokedAt (set to a non-null timestamp), never deleted. This
 * preserves the federation audit trail that the Assurance Report (P5)
 * will hash-chain over.
 *
 * RLS-protected (T11): issuer_tenant_id = current_setting(
 *   'app.current_tenant_id', true)::uuid
 *
 * Naming convention: camelCase TS / snake_case SQL (per T5/T6 chain
 * 2aa8e18 → 1149b17). Imports alphabetical (per T6 precedent).
 */
export const delegationToken = pgTable('delegation_token', {
  id: uuid('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  issuerTenantId: uuid('issuer_tenant_id')
    .notNull()
    .references(() => tenant.id),
  subjectTenantId: uuid('subject_tenant_id')
    .notNull()
    .references(() => subjectTenant.id),
  issuedToEmail: text('issued_to_email').notNull(),
  scope: jsonb('scope').notNull(), // e.g. { "read": ["assurance_report"] }
  issuedByUserId: uuid('issued_by_user_id')
    .notNull()
    .references(() => user.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
