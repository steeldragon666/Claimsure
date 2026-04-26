import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenant } from './tenant.js';

/**
 * Claimant or financier — the consultant firm's "client" entity.
 *
 * `kind` discriminates between:
 *   - 'claimant': owned by the firm; firm staff have direct access via
 *     subject_tenant_user roles (T7).
 *   - 'financier': granted scoped read access via delegation_token (T8 schema, P8 API);
 *     does not have firm-level membership.
 *
 * RLS-protected (policies land in T11): all reads/writes filtered by
 *   tenant_id = current_setting('app.current_tenant_id', true)::uuid
 *
 * Naming convention: camelCase TS properties, snake_case SQL columns
 * (per system.ts / tenant.ts / user.ts precedent — see T5 commit 2aa8e18).
 */
export const subjectTenant = pgTable('subject_tenant', {
  id: uuid('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenant.id),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['claimant', 'financier'] })
    .notNull()
    .default('claimant'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});
