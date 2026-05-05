import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { promptSuggestion } from './prompt_suggestion.js';
import { tenant } from './tenant.js';

/**
 * P7 Theme B Task B.1 — prompt_suggestion_pr (GitHub PR records).
 *
 * Every PR opened by the Task B.6 PR-drafter against the prompt
 * repository for a given suggestion writes one row here. Multiple PRs
 * per suggestion are supported (a suggestion that gets re-PR'd after
 * the first attempt is rejected); code that needs the "current PR
 * for suggestion X" can do a `MAX(created_at)` lookup or filter by
 * `merged_at IS NOT NULL`.
 *
 * **Composite primary key**: `(tenant_id, id)`. Tenant-scoped tables
 * use a composite PK so RLS isolation is structural.
 *
 * **Composite FK to prompt_suggestion**: the parent's PK is
 * `(tenant_id, id)`, so the FK MUST reference both columns. The FK
 * is hand-authored in `0038_prompt_suggestion_queue.sql`; this schema
 * uses `foreignKey({ columns, foreignColumns })` to express the
 * composite reference for type-narrowing purposes.
 *
 * **Denormalized tenant_id**: `tenant_id` is duplicated from the
 * parent at insert time. The composite FK structurally enforces
 * consistency.
 *
 * **`changed_files` is jsonb**: a list of file paths changed in the
 * PR. The canonical Zod schema for this shape lives with Task B.6's
 * PR-drafter implementation; the column type is intentionally left
 * as `unknown` for now and will narrow when Task B.6 lands the
 * `@cpa/schemas` definition.
 *
 * **`merged_at` and `merge_commit_sha` are nullable** until the PR
 * is merged. The Task B.6 webhook handler updates both columns when
 * the GitHub `pull_request.closed` (merged=true) event fires.
 *
 * **`github_pr_number`**: globally unique per repository, not
 * per-tenant. The webhook-lookup index is therefore `(github_pr_number)`
 * alone, not tenant-led.
 *
 * RLS-protected (migration hand-authors the policy):
 *   tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
 *
 * **GRANT discipline**: SELECT/INSERT/UPDATE granted (UPDATE is
 * needed for the merge-bookkeeping flow when the webhook populates
 * `merged_at` / `merge_commit_sha`). DELETE is REVOKEd — PR rows are
 * audit metadata.
 *
 * **CASCADE behaviour**: ON DELETE NO ACTION (the default). PR rows
 * outlive their parent suggestions as audit metadata.
 *
 * Naming convention: camelCase TS / snake_case SQL.
 */
export const promptSuggestionPr = pgTable(
  'prompt_suggestion_pr',
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
    githubPrNumber: integer('github_pr_number').notNull(),
    githubPrUrl: text('github_pr_url').notNull(),
    branchName: text('branch_name').notNull(),
    // jsonb list of file paths changed in the PR; canonical Zod
    // schema lands with Task B.6's PR-drafter implementation.
    changedFiles: jsonb('changed_files').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Nullable: populated when the PR is merged (Task B.6 webhook).
    mergedAt: timestamp('merged_at', { withTimezone: true }),
    // Nullable: populated alongside merged_at when the PR is merged.
    mergeCommitSha: text('merge_commit_sha'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.id] }),
    // Per-suggestion scan — "give me all PRs for suggestion X".
    suggestionIdx: index('prompt_suggestion_pr_suggestion_idx').on(t.tenantId, t.suggestionId),
    // Webhook lookup — "find the row for incoming PR number N" when
    // the GitHub merge webhook fires. PR numbers are globally unique
    // on the prompt repo so the index doesn't need tenant_id leading.
    githubPrNumberIdx: index('prompt_suggestion_pr_github_pr_number_idx').on(t.githubPrNumber),
    // Composite FK to prompt_suggestion(tenant_id, id).
    suggestionFk: foreignKey({
      columns: [t.tenantId, t.suggestionId],
      foreignColumns: [promptSuggestion.tenantId, promptSuggestion.id],
      name: 'prompt_suggestion_pr_suggestion_fk',
    }),
  }),
);

/** Inferred row type for SELECT statements via drizzle. */
export type PromptSuggestionPr = InferSelectModel<typeof promptSuggestionPr>;

/** Inferred row type for INSERT statements via drizzle. */
export type NewPromptSuggestionPr = InferInsertModel<typeof promptSuggestionPr>;
