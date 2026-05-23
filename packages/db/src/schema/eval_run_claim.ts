import { bigint, index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { evalRun } from './eval_run.js';

/**
 * eval_run_claim — one row per (eval_run, claimant) pair.
 *
 * Per-claim accuracy metrics, stored as counts/cents so the reporter can
 * derive percentages or roll up however it likes. See migration
 * 0088_eval_run_tracking.sql.
 */
export const evalRunClaim = pgTable(
  'eval_run_claim',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    evalRunId: uuid('eval_run_id')
      .notNull()
      .references(() => evalRun.id, { onDelete: 'cascade' }),
    claimIdx: integer('claim_idx').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    claimId: uuid('claim_id').notNull(),
    claimantName: text('claimant_name').notNull(),
    domainSlug: text('domain_slug').notNull(),
    noteRdTotal: integer('note_rd_total').notNull().default(0),
    noteRdKept: integer('note_rd_kept').notNull().default(0),
    noteContaminationTotal: integer('note_contamination_total').notNull().default(0),
    noteContaminationCaught: integer('note_contamination_caught').notNull().default(0),
    expRdDollarsCents: bigint('exp_rd_dollars_cents', { mode: 'bigint' }).notNull().default(0n),
    expRdKeptCents: bigint('exp_rd_kept_cents', { mode: 'bigint' }).notNull().default(0n),
    expContaminationDollarsCents: bigint('exp_contamination_dollars_cents', { mode: 'bigint' })
      .notNull()
      .default(0n),
    expContaminationCaughtCents: bigint('exp_contamination_caught_cents', { mode: 'bigint' })
      .notNull()
      .default(0n),
  },
  (t) => [
    index('eval_run_claim_run_idx').on(t.evalRunId),
    index('eval_run_claim_tenant_idx').on(t.tenantId, t.evalRunId),
  ],
);
