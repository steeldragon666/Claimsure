import { date, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { tenant } from './tenant.js';
import { subjectTenant } from './subject_tenant.js';
import { activity } from './activity.js';
import { user } from './user.js';

/**
 * P7 Theme D Task D.5 — knowledge_search_record (prior-art searches).
 *
 * Records prior-art and knowledge-gap searches performed for each R&D
 * activity. Demonstrates the "new knowledge" criterion was investigated
 * as required by the R&D Tax Incentive legislation.
 *
 * **`sources_consulted`** is jsonb — an array of source objects
 * describing where the search was conducted (databases, journals,
 * industry contacts, etc.). Structural validation lives at the API
 * layer via Zod.
 *
 * RLS-protected (migration hand-authors the policy):
 *   tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
 */

export const knowledgeSearchRecord = pgTable(
  'knowledge_search_record',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    subjectTenantId: uuid('subject_tenant_id')
      .notNull()
      .references(() => subjectTenant.id),
    activityId: uuid('activity_id')
      .notNull()
      .references(() => activity.id),
    searchDate: date('search_date').notNull(),
    searchQuery: text('search_query').notNull(),
    sourcesConsulted: jsonb('sources_consulted').notNull(),
    findingSummary: text('finding_summary').notNull(),
    recordedByUserId: uuid('recorded_by_user_id').references(() => user.id),
    firstRecordedAt: timestamp('first_recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    activityIdx: index('knowledge_search_record_activity_idx').on(t.tenantId, t.activityId),
  }),
);

/** Inferred row type for SELECT statements via drizzle. */
export type KnowledgeSearchRecord = InferSelectModel<typeof knowledgeSearchRecord>;

/** Inferred row type for INSERT statements via drizzle. */
export type NewKnowledgeSearchRecord = InferInsertModel<typeof knowledgeSearchRecord>;
