import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { subjectTenant } from './subject_tenant.js';
import { tenant } from './tenant.js';
import { user } from './user.js';

/**
 * P9 Phase 3 — federation_share.
 *
 * Records that firm A (source_tenant) has granted firm B (target_tenant)
 * read-only access to a specific subject_tenant's claim data. This is the
 * core federation primitive: the existence of an active (non-revoked,
 * non-expired) row here is what the extended RLS policies on claim,
 * activity, expenditure, and narrative_draft check to determine
 * cross-tenant visibility.
 *
 * Lifecycle:
 *   1. Consultant creates a federation_invitation (pre-share stage).
 *   2. Financier accepts the invitation → INSERT federation_share.
 *   3. Consultant revokes → SET revoked_at, revoked_by_user_id.
 *   4. Optional expiry: expires_at checked in RLS (fs.expires_at IS NULL OR fs.expires_at > now()).
 *
 * RLS-protected (migration 0070 hand-authors the policy):
 *   USING: source_tenant_id OR target_tenant_id = current tenant
 *   WITH CHECK: source_tenant_id = current tenant (only source can create)
 *
 * Naming convention: camelCase TS / snake_case SQL.
 */

export const federationShare = pgTable(
  'federation_share',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    subjectTenantId: uuid('subject_tenant_id')
      .notNull()
      .references(() => subjectTenant.id),
    sourceTenantId: uuid('source_tenant_id')
      .notNull()
      .references(() => tenant.id),
    targetTenantId: uuid('target_tenant_id')
      .notNull()
      .references(() => tenant.id),
    grantedByUserId: uuid('granted_by_user_id')
      .notNull()
      .references(() => user.id),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedByUserId: uuid('revoked_by_user_id').references(() => user.id),
    revokedReason: text('revoked_reason'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    targetTenantIdx: index('federation_share_target_tenant_idx').on(t.targetTenantId),
    sourceTenantIdx: index('federation_share_source_tenant_idx').on(t.sourceTenantId),
    subjectTenantIdx: index('federation_share_subject_tenant_idx')
      .on(t.subjectTenantId)
      .where(sql`${t.revokedAt} IS NULL`),
  }),
);

export type FederationShare = InferSelectModel<typeof federationShare>;
export type NewFederationShare = InferInsertModel<typeof federationShare>;
