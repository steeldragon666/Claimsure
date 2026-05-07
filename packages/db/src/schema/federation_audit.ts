import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import { federationShare } from './federation_share.js';
import { user } from './user.js';

/**
 * P9 Phase 3 — federation_audit.
 *
 * Immutable log of every federated read action. When a financier partner
 * reads data via a federation_share, the audit hook inserts a row here
 * recording what was accessed, by whom, and when.
 *
 * This table is APPEND-ONLY: UPDATE and DELETE are revoked from cpa_app
 * (see migration 0070). This mirrors the audit_log table's immutability
 * contract from P5 Theme 2.
 *
 * RLS-protected (migration 0070 hand-authors the policy):
 *   USING: share's source_tenant_id OR target_tenant_id = current tenant
 *   WITH CHECK: share's target_tenant_id = current tenant (reader inserts)
 *
 * Naming convention: camelCase TS / snake_case SQL.
 */

export const federationAudit = pgTable(
  'federation_audit',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    federationShareId: uuid('federation_share_id')
      .notNull()
      .references(() => federationShare.id),
    accessedByUserId: uuid('accessed_by_user_id')
      .notNull()
      .references(() => user.id),
    resourceType: text('resource_type').notNull(),
    resourceId: uuid('resource_id').notNull(),
    action: text('action').notNull().default('read'),
    accessedAt: timestamp('accessed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    shareIdx: index('federation_audit_share_idx').on(t.federationShareId),
  }),
);

export type FederationAudit = InferSelectModel<typeof federationAudit>;
export type NewFederationAudit = InferInsertModel<typeof federationAudit>;
