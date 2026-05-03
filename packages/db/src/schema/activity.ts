import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { claim } from './claim.js';
import { project } from './project.js';
import { tenant } from './tenant.js';

/**
 * R&DTI activity — a Core Activity (CA-NN) or Supporting Activity
 * (SA-NN) registered against a claim, anchored to the project where
 * the work happened. Activities are the regulator-facing unit: each
 * one carries the Section 355-25 narrative chain (hypothesis →
 * technical uncertainty → experimentation log → expected/actual
 * outcome) per design doc §"Core tables".
 *
 * Uniqueness: `(claim_id, code)` — within a single fiscal-year claim,
 * each CA/SA code is unique (CA-01, CA-02, SA-01, SA-02, …). Codes can
 * repeat across different claims (a multi-year program would have
 * CA-01 in both 2024 and 2025 claims).
 *
 * `kind` is `'core' | 'supporting'`; `code` follows the `^(CA|SA)-\d+$`
 * shape (and `kind` must agree with the `code` prefix). Both columns
 * are plain `text` here — F2 hand-authors CHECK constraints enforcing
 * the enum (`kind IN ('core','supporting')`) and the regex
 * (`code ~ '^(CA|SA)-\d+$'`) plus the kind/code agreement check.
 *
 * Narrative fields are all nullable because activities pass through
 * stages of completion as the consultant gathers evidence — nothing
 * is required up-front beyond identity (`code`, `kind`, `title`).
 *
 * RLS-protected (F2 hand-authors): tenant_id =
 *   current_setting('app.current_tenant_id', true)::uuid
 *
 * Naming convention: camelCase TS / snake_case SQL (per T5/T6 chain).
 */

/**
 * Single source of truth for activity kind classification.
 *
 * Keep in sync with the `activity_kind_valid` CHECK constraint in
 * `migrations/0012_hard_titania.sql`. The Drizzle column type uses
 * `text({ enum: ACTIVITY_KINDS })` to narrow the TS type to this union,
 * so any divergence between this array and the SQL CHECK would surface
 * as a runtime constraint violation on insert/update.
 */
export const ACTIVITY_KINDS = ['core', 'supporting'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const activity = pgTable(
  'activity',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    projectId: uuid('project_id')
      .notNull()
      .references(() => project.id),
    claimId: uuid('claim_id')
      .notNull()
      .references(() => claim.id),
    // CA-NN or SA-NN; CHECK constraint hand-authored in 0012.
    code: text('code').notNull(),
    // 'core' | 'supporting'; CHECK constraint hand-authored in 0012.
    kind: text('kind', { enum: ACTIVITY_KINDS }).notNull(),
    title: text('title').notNull(),
    description: text('description'),
    hypothesis: text('hypothesis'),
    technicalUncertainty: text('technical_uncertainty'),
    experimentationLog: text('experimentation_log'),
    expectedOutcome: text('expected_outcome'),
    actualOutcome: text('actual_outcome'),
    // P7 Theme A — multi-cycle chain walk (Q-Fix2=A locked decision).
    // Nullable: pre-P7 activities had no Agent B proposal step. Chain
    // walk via (tenant_id, proposed_id, fy_label) for prior-cycle lookup.
    proposedId: uuid('proposed_id'),
    // P7 Theme A — fiscal-year label, e.g. 'FY25' for fiscal_year=2025
    // (Q-Fix3=A locked decision). NOT NULL — backfilled from
    // claim.fiscal_year in migration 0037. The migration sets
    // `DEFAULT ''` so existing application-code INSERT paths that
    // pre-date Theme A keep working; Theme A's activity writers should
    // set an explicit FY label.
    fyLabel: text('fy_label').notNull().default(''),
    // P7 Theme A — first-known-hypothesis timestamp (Q-Fix4=B locked
    // decision). Immutable post-insert: BEFORE UPDATE trigger
    // `activity_hypothesis_formed_at_immutable` raises check_violation
    // on any DISTINCT-FROM update. Backfilled from MIN(narrative_draft
    // .created_at) per activity, falling back to activity.created_at
    // when no drafts exist yet. `DEFAULT now()` covers paths that
    // INSERT without specifying the column.
    hypothesisFormedAt: timestamp('hypothesis_formed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    tenantIdx: index('activity_tenant_idx').on(t.tenantId),
    projectIdx: index('activity_project_idx').on(t.projectId),
    claimIdx: index('activity_claim_idx').on(t.claimId),
    claimCodeUnique: uniqueIndex('activity_claim_code_unique').on(t.claimId, t.code),
    // Partial index: chain-walk lookup ignores rows without proposed_id
    // (pre-P7 activities). Migration 0037 declares the matching SQL.
    proposedIdFyIdx: index('activity_proposed_id_fy_idx')
      .on(t.tenantId, t.proposedId, t.fyLabel, t.hypothesisFormedAt)
      .where(sql`${t.proposedId} IS NOT NULL`),
  }),
);
