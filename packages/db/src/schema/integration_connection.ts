import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { tenant } from './tenant.js';
import { subjectTenant } from './subject_tenant.js';

/**
 * Encrypted OAuth state per (tenant, provider) — one row per consultant
 * firm per third-party integration (DocuSign, Employment Hero, KeyPay,
 * Deputy, Xero Payroll).
 *
 * `access_token_encrypted` + `refresh_token_encrypted` carry tokens
 * encrypted at rest via Postgres pgcrypto (production: KMS-derived key).
 * The DB never sees plaintext — encryption/decryption happens at the
 * integrations layer (per design doc §5.2). No CHECK on these fields:
 * they're opaque ciphertext.
 *
 * `sync_state` drives the pg-boss payroll-sync state machine (per design
 * doc §5.3): idle → syncing → idle (or → failed). `last_error` is null
 * unless `sync_state = 'failed'`.
 *
 * Unique on `(tenant_id, provider)` — one connection per integration per
 * firm. Re-authorising replaces the row in place (UPDATE, not INSERT).
 *
 * RLS-protected (hand-authored at end of 0009): tenant_id =
 *   current_setting('app.current_tenant_id', true)::uuid
 *
 * Naming convention: camelCase TS / snake_case SQL.
 */
export const INTEGRATION_PROVIDERS = [
  'docusign',
  'employment_hero',
  'keypay',
  'deputy',
  'xero_accounting',
  'xero_payroll',
  'myob_accounting',
] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

export const INTEGRATION_SYNC_STATES = ['idle', 'syncing', 'failed'] as const;
export type IntegrationSyncState = (typeof INTEGRATION_SYNC_STATES)[number];

export const integrationConnection = pgTable(
  'integration_connection',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    // The client (claimant) this connection belongs to. NULL for firm-level
    // integrations (e.g. DocuSign); set for per-client ones (Xero/MYOB
    // accounting, payroll) — every client company has its own org.
    subjectTenantId: uuid('subject_tenant_id').references(() => subjectTenant.id),
    provider: text('provider', { enum: INTEGRATION_PROVIDERS }).notNull(),
    accessTokenEncrypted: text('access_token_encrypted').notNull(),
    refreshTokenEncrypted: text('refresh_token_encrypted'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    scopes: text('scopes').array(),
    externalAccountId: text('external_account_id'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    syncState: text('sync_state', { enum: INTEGRATION_SYNC_STATES }).notNull().default('idle'),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    // Firm-level connections (subject_tenant_id IS NULL): one per (tenant, provider).
    firmProviderUnique: uniqueIndex('integration_connection_firm_provider_unique')
      .on(t.tenantId, t.provider)
      .where(sql`${t.subjectTenantId} IS NULL`),
    // Per-client connections (subject_tenant_id NOT NULL): one per (tenant, client, provider).
    clientProviderUnique: uniqueIndex('integration_connection_client_provider_unique')
      .on(t.tenantId, t.subjectTenantId, t.provider)
      .where(sql`${t.subjectTenantId} IS NOT NULL`),
    subjectTenantIdx: index('integration_connection_subject_tenant_idx')
      .on(t.tenantId, t.subjectTenantId)
      .where(sql`${t.subjectTenantId} IS NOT NULL`),
  }),
);
