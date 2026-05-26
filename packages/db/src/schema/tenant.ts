import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Consultant firm — the white-label root tenant of the platform.
 *
 * Every domain row is ultimately scoped to a `tenant` via the
 * `current_setting('app.current_tenant_id')::uuid` RLS context-setter.
 * `tenant` itself is a GLOBAL table (no RLS) — access is gated at the
 * API layer.
 *
 * `slug` is a URL-safe identifier used in admin/portal paths.
 * `primaryIdp` records which IdP this firm primarily uses; users in
 * the firm can sign in via either Microsoft or Google regardless.
 *
 * Naming convention: TS property names are camelCase (per Drizzle
 * idiom and `system.ts` precedent); SQL column names (the first
 * string arg to each column constructor) are snake_case.
 */
export const tenant = pgTable('tenant', {
  id: uuid('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  primaryIdp: text('primary_idp', { enum: ['microsoft', 'google', 'mixed'] })
    .notNull()
    .default('mixed'),
  // Wizard Step 1 (migration 0085). Per-firm engagement-letter template
  // in markdown with {{variable}} placeholders. NULL = firm has not yet
  // configured a letter and the wizard's "send" action is gated off.
  // Rendered per-claim at send time into engagement_letter.rendered_markdown
  // (snapshot, immutable post-sign).
  engagementLetterTemplateMd: text('engagement_letter_template_md'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});
