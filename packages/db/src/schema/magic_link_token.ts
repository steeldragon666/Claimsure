import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { subjectTenantEmployee } from './subject_tenant_employee.js';

/**
 * Single-use magic-link bootstrap token for mobile authentication.
 *
 * The raw 256-bit token is sent ONCE in the invite email (per design doc
 * §3.1). Only its hex SHA-256 hash is stored here. On redemption, the
 * server hashes the raw token and looks it up, verifying not consumed and
 * not expired (15-minute window).
 *
 * NOT RLS-scoped: redemption happens before any tenant context is available
 * — the token IS the auth signal. Lookup is by `token_hash` which is itself
 * the secret. No cross-tenant data leak risk because the only field
 * accessible without a hash collision is the token row itself.
 *
 * Lifecycle: `consumed_at` flips on first successful redeem; subsequent
 * attempts fail. Tokens never delete — audit trail.
 *
 * Naming convention: camelCase TS / snake_case SQL.
 */
export const magicLinkToken = pgTable('magic_link_token', {
  id: uuid('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  employeeId: uuid('employee_id')
    .notNull()
    .references(() => subjectTenantEmployee.id),
  // hex SHA-256 of the raw token; raw token never stored.
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
