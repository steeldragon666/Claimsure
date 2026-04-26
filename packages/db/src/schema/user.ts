import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Person — globally unique by email + IdP. NOT bound to any single
 * tenant; membership is via `tenant_user` join (a user can belong to
 * multiple firms, e.g. consultant partners).
 *
 * `externalId` carries the IdP-specific subject identifier:
 *   - Microsoft Entra: 'microsoft:<oid>'
 *   - Google Workspace: 'google:<sub>'
 * Stable per-user across email changes; we use it for the canonical
 * lookup during OIDC callback.
 *
 * `user` itself is a GLOBAL table (no RLS) — access is gated at the
 * API layer (e.g. /v1/users requires admin role on active tenant).
 *
 * Naming convention: TS property names are camelCase (per Drizzle
 * idiom and `system.ts` precedent); SQL column names (the first
 * string arg to each column constructor) are snake_case.
 */
export const user = pgTable('user', {
  id: uuid('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  email: text('email').notNull().unique(),
  displayName: text('display_name'),
  primaryIdp: text('primary_idp', { enum: ['microsoft', 'google'] }).notNull(),
  externalId: text('external_id').notNull(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});
