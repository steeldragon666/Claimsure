import { index, integer, jsonb, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { subjectTenant } from './subject_tenant.js';
import { tenant } from './tenant.js';

/**
 * Audit-readiness score history per claimant (T-D2).
 *
 * Each row is a point-in-time snapshot of the 10-rule scoring engine
 * (`@cpa/audit-score`). The recompute job (D3) appends a new row on a
 * schedule (cron, P5+) and on-demand from the GET /v1/audit-score/:claimant_id
 * route when no snapshot exists yet.
 *
 * `total_pts` and `max_pts` cache the aggregate so the dashboard doesn't
 * re-evaluate the rules on every page load. `rule_breakdown` (jsonb) stores
 * the per-rule rows from `ScoreResult.rule_breakdown` for the drill-down UI.
 *
 * Append-only: never UPDATEd, never DELETEd (except by the rare retention
 * job, future). The 7-day delta in D4 reads two rows: latest and the most
 * recent snapshot ≥ 7 days old.
 *
 * RLS-protected (hand-authored at end of the migration): tenant_id =
 *   current_setting('app.current_tenant_id', true)::uuid
 *
 * Naming convention: camelCase TS / snake_case SQL.
 */
export const auditScoreSnapshot = pgTable(
  'audit_score_snapshot',
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
    totalPts: integer('total_pts').notNull(),
    maxPts: integer('max_pts').notNull(),
    ruleBreakdown: jsonb('rule_breakdown').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    timelineIdx: index('audit_score_snapshot_timeline_idx').on(
      t.subjectTenantId,
      t.computedAt.desc(),
    ),
  }),
);
