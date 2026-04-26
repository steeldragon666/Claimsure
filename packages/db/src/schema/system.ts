import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * System table — sanity check for the migration runner.
 *
 * Establishes audit-column conventions for every domain table:
 * - `created_at`, `updated_at`: notNull, defaultNow(). `updated_at` carries
 *   `$onUpdate(() => new Date())` so ORM `db.update()` calls auto-bump it.
 *   Raw SQL UPDATE statements DO NOT auto-bump; callers using the postgres-js
 *   client directly must set `updated_at = NOW()` manually. A DB-side trigger
 *   will be introduced when audit_log lands in P2.
 * - `deleted_at`: nullable, soft-delete marker. Append-only audit tables in P2
 *   (event, weekly_log, document) will NOT carry deleted_at — they're immutable
 *   by design.
 *
 * UUID v4 is generated app-side via crypto.randomUUID(), matching the strict
 * @cpa/schemas Uuid contract. Per design doc §4, all timestamps are timestamptz
 * to anchor the audit chain in UTC.
 */
export const system = pgTable('system', {
  id: uuid('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  key: text('key').notNull(),
  value: text('value').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});
