import {
  bigint,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * eval_run — one row per accuracy benchmark execution.
 *
 * Populated by score-stress-test.ts (and eventually score-bulk-claims.ts)
 * to persist accuracy metrics across runs. NOT tenant-scoped; this is a
 * global operational table — see migration 0088_eval_run_tracking.sql.
 *
 * Read/write is via privilegedSql. cpa_app has no grants on this table.
 */
export const evalRun = pgTable(
  'eval_run',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    seedName: text('seed_name').notNull(),
    agentsClassifierImpl: text('agents_classifier_impl').notNull(),
    agentsExpenditureClassifierImpl: text('agents_expenditure_classifier_impl').notNull(),
    agentsClassifierModel: text('agents_classifier_model'),
    agentsExpenditureClassifierModel: text('agents_expenditure_classifier_model'),
    totalClaims: integer('total_claims').notNull().default(0),
    totalExpenditureCents: bigint('total_expenditure_cents', { mode: 'bigint' })
      .notNull()
      .default(0n),
    totalIneligibleExpenditureCents: bigint('total_ineligible_expenditure_cents', {
      mode: 'bigint',
    })
      .notNull()
      .default(0n),
    totalNotes: integer('total_notes').notNull().default(0),
    totalContaminatedNotes: integer('total_contaminated_notes').notNull().default(0),
    noteRdRecallPct: numeric('note_rd_recall_pct', { precision: 6, scale: 3 })
      .notNull()
      .default('0'),
    noteContaminationCaughtPct: numeric('note_contamination_caught_pct', {
      precision: 6,
      scale: 3,
    })
      .notNull()
      .default('0'),
    expRdRecallPct: numeric('exp_rd_recall_pct', { precision: 6, scale: 3 }).notNull().default('0'),
    expContaminationCaughtPct: numeric('exp_contamination_caught_pct', { precision: 6, scale: 3 })
      .notNull()
      .default('0'),
    notes: text('notes'),
  },
  (t) => [
    index('eval_run_seed_started_idx').on(t.seedName, t.startedAt.desc()),
    index('eval_run_started_idx').on(t.startedAt.desc()),
  ],
);
