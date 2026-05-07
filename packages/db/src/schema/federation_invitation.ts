import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import { subjectTenant } from './subject_tenant.js';
import { tenant } from './tenant.js';
import { user } from './user.js';

/**
 * P9 Phase 3 — federation_invitation.
 *
 * Pre-share stage: a consultant firm creates an invitation containing a
 * random token, sends it to a financier partner's email. The financier
 * accepts the invitation (proving possession of the token) to create the
 * actual federation_share row.
 *
 * Security model:
 *   - token is 256-bit random (crypto.randomBytes(32))
 *   - Only the SHA-256 hash is stored (token_hash); raw token sent via email
 *   - Acceptance requires hashing the raw token and matching token_hash
 *   - Status lifecycle: pending → accepted | expired | revoked
 *
 * RLS-protected (migration 0070 hand-authors the policy):
 *   USING: source_tenant_id OR target_tenant_id = current tenant
 *   WITH CHECK: source_tenant_id = current tenant
 *
 * Naming convention: camelCase TS / snake_case SQL.
 */

export const FEDERATION_INVITATION_STATUSES = [
  'pending',
  'accepted',
  'expired',
  'revoked',
] as const;
export type FederationInvitationStatus = (typeof FEDERATION_INVITATION_STATUSES)[number];

export const federationInvitation = pgTable('federation_invitation', {
  id: uuid('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  subjectTenantId: uuid('subject_tenant_id')
    .notNull()
    .references(() => subjectTenant.id),
  sourceTenantId: uuid('source_tenant_id')
    .notNull()
    .references(() => tenant.id),
  targetEmail: text('target_email').notNull(),
  targetTenantId: uuid('target_tenant_id').references(() => tenant.id),
  invitedByUserId: uuid('invited_by_user_id')
    .notNull()
    .references(() => user.id),
  tokenHash: text('token_hash').notNull().unique(),
  status: text('status', { enum: FEDERATION_INVITATION_STATUSES }).notNull().default('pending'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type FederationInvitation = InferSelectModel<typeof federationInvitation>;
export type NewFederationInvitation = InferInsertModel<typeof federationInvitation>;
