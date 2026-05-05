import { foreignKey, index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { promptSuggestion } from './prompt_suggestion.js';
import { tenant } from './tenant.js';
import { user } from './user.js';

/**
 * P7 Theme B Task B.1 — prompt_suggestion_review (reviewer disposition events).
 *
 * Append-only audit trail of reviewer dispositions on prompt
 * suggestions. Each row records ONE reviewer's verdict on ONE
 * suggestion at ONE point in time. A "change of mind" is a NEW review
 * row (reviewers cannot edit prior dispositions); the application
 * layer (Task B.3) is responsible for picking the most recent
 * disposition per suggestion when computing UI state.
 *
 * **Append-only**: enforced at the GRANT level — the migration grants
 * only `SELECT, INSERT` to `cpa_app` (NO UPDATE / DELETE). Mirrors
 * `audit_log` from migration 0022 and `narrative_draft_version` from
 * migration 0030. Postgres has no built-in "append-only table" mode;
 * the GRANT discipline is the structural enforcement.
 *
 * **Composite primary key**: `(tenant_id, id)`. Tenant-scoped tables
 * use a composite PK so RLS isolation is structural — even if a
 * privileged caller accidentally bypassed the policy, two firms
 * can't collide on the `id` half.
 *
 * **Composite FK to prompt_suggestion**: the parent's PK is
 * `(tenant_id, id)`, so the FK MUST reference both columns. A
 * single-column FK to `prompt_suggestion.id` alone would fail because
 * `id` is not unique on the parent without the `tenant_id` half. The
 * FK is hand-authored in `0038_prompt_suggestion_queue.sql` because
 * drizzle's `.references()` only models single-column FKs; this
 * schema uses `foreignKey({ columns, foreignColumns })` to express
 * the composite reference for type-narrowing purposes.
 *
 * **Denormalized tenant_id**: `tenant_id` is duplicated from the
 * parent at insert time (the application layer is responsible for
 * setting it). This avoids subquery RLS — the tenant-isolation policy
 * filters on the child's own tenant_id directly. The composite FK to
 * prompt_suggestion(tenant_id, id) structurally enforces consistency
 * (a row whose tenant_id doesn't match its parent's would fail the
 * FK lookup).
 *
 * **`disposition`** is typed against a literal-union enum via
 * `text({ enum: ... })`. The matching CHECK constraint
 * (`prompt_suggestion_review_disposition_valid`) is hand-authored in
 * the migration because drizzle-kit can't reliably round-trip CHECK
 * constraints across regenerations.
 *
 * **`notes`** is nullable. Reviewers may leave free-text context
 * (e.g., "Same issue as #234, dismissing as duplicate") or skip them.
 *
 * RLS-protected (migration hand-authors the policy):
 *   tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
 *
 * **CASCADE behaviour**: ON DELETE NO ACTION (the default). Reviews
 * outlive their parent suggestions as audit metadata; deleting a
 * suggestion is not expected (dismissal flips status instead).
 *
 * Naming convention: camelCase TS / snake_case SQL.
 */

/**
 * Single source of truth for prompt_suggestion_review disposition values.
 *
 * Mirrors the `prompt_suggestion_review_disposition_valid` CHECK
 * constraint in `0038_prompt_suggestion_queue.sql`. Drift between
 * this array and the SQL CHECK surfaces as a runtime constraint
 * violation on insert.
 *
 * Three-way parity (this array ↔ SQL CHECK ↔ Zod enum in @cpa/schemas)
 * lands with Task B.4.
 */
export const PROMPT_SUGGESTION_REVIEW_DISPOSITIONS = [
  'approve_for_pr',
  'request_more_info',
  'dismiss',
  'escalate_to_code_change',
] as const;
export type PromptSuggestionReviewDisposition =
  (typeof PROMPT_SUGGESTION_REVIEW_DISPOSITIONS)[number];

export const promptSuggestionReview = pgTable(
  'prompt_suggestion_review',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    id: uuid('id')
      .notNull()
      .$defaultFn(() => crypto.randomUUID()),
    // Half of the composite FK to prompt_suggestion(tenant_id, id) —
    // the FK itself is declared at the table level via foreignKey()
    // below, since drizzle's `.references()` only models single-
    // column FKs.
    suggestionId: uuid('suggestion_id').notNull(),
    reviewerUserId: uuid('reviewer_user_id')
      .notNull()
      .references(() => user.id),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }).notNull().defaultNow(),
    disposition: text('disposition', { enum: PROMPT_SUGGESTION_REVIEW_DISPOSITIONS }).notNull(),
    notes: text('notes'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.id] }),
    // Per-suggestion scan — "give me all reviews for suggestion X" in
    // the triage UI's review history panel.
    suggestionIdx: index('prompt_suggestion_review_suggestion_idx').on(t.tenantId, t.suggestionId),
    // Composite FK to prompt_suggestion(tenant_id, id) — drizzle's
    // single-column `.references()` cannot express the composite
    // shape required by the parent's composite PK.
    suggestionFk: foreignKey({
      columns: [t.tenantId, t.suggestionId],
      foreignColumns: [promptSuggestion.tenantId, promptSuggestion.id],
      name: 'prompt_suggestion_review_suggestion_fk',
    }),
  }),
);

/** Inferred row type for SELECT statements via drizzle. */
export type PromptSuggestionReview = InferSelectModel<typeof promptSuggestionReview>;

/** Inferred row type for INSERT statements via drizzle. */
export type NewPromptSuggestionReview = InferInsertModel<typeof promptSuggestionReview>;
