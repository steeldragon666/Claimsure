import { index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { tenant } from './tenant.js';
import { user } from './user.js';

/**
 * P7 Theme B Task B.1 — prompt_suggestion (queue row).
 *
 * The prompt-suggestion queue is the workflow surface where consultant
 * flags, RIF events, contract test failures, and reviewer dispositions
 * accumulate as candidates for prompt revisions. Each suggestion is a
 * single queue row that progresses through a triage workflow:
 *   open → triaged → pr_drafted → pr_merged | dismissed
 *
 * **Composite primary key**: `(tenant_id, id)`. Tenant-scoped tables
 * use a composite PK so RLS isolation is structural — even if a
 * privileged caller accidentally bypassed the policy, two firms can't
 * collide on the `id` half (each `id` is a v4 UUID, but the PK shape
 * pins the "row belongs to a tenant" invariant in the schema).
 *
 * **`source_kind`, `status`, `triage_classification`** are typed
 * against literal-union enums via `text({ enum: ... })`. The matching
 * CHECK constraints (`prompt_suggestion_source_kind_valid`,
 * `prompt_suggestion_status_valid`,
 * `prompt_suggestion_triage_classification_valid`) are hand-authored
 * in `0038_prompt_suggestion_queue.sql` because drizzle-kit can't
 * reliably round-trip CHECK constraints across regenerations.
 *
 * **`source_payload` is jsonb** — shape varies by `source_kind`:
 *   - `consultant_flag`     → { reason, captured_at, ... }
 *   - `rif_event`           → { event_id, kind, ... }
 *   - `contract_test_failure` → { test_name, expected, actual, ... }
 *   - `reviewer_disposition` → { previous_review_id, reason, ... }
 *
 * Structural validation lives at the API layer (Task B.2 ingest
 * endpoint via Zod). The DB stores the canonical wire shape verbatim
 * for audit purposes.
 *
 * **`triage_classification`** is nullable. NULL until a reviewer
 * triages the suggestion (Task B.3). Once set, it pins the kind of
 * change being proposed:
 *   - `prompt_change`     → patch the prompt template
 *   - `schema_change`     → patch a Zod schema (event payload, etc.)
 *   - `code_change`       → patch application code (escalation)
 *   - `no_action_needed`  → reviewer determined the suggestion is moot
 *
 * **No `pr_id` column.** The plan's design doc had bidirectional FKs
 * (prompt_suggestion.pr_id ↔ prompt_suggestion_pr.suggestion_id) but
 * the bidirectional shape adds forward-reference ordering pain in the
 * SQL CREATE TABLE flow and offers no expressiveness over a single FK
 * from prompt_suggestion_pr.suggestion_id → prompt_suggestion.id. The
 * "many PRs per suggestion" semantic (a suggestion that gets re-PR'd
 * after the first attempt is rejected) is more flexible. Code that
 * needs the "current PR for suggestion X" can do a `MAX(created_at)`
 * lookup against `prompt_suggestion_pr`.
 *
 * **`first_recorded_at` vs `flagged_at`**: `flagged_at` is when the
 * row was created in the queue; `first_recorded_at` is when the
 * underlying issue was FIRST observed in any source (in the absence
 * of dedup, both default to `now()`; future deduping logic in Task
 * B.2 may set `first_recorded_at` to an earlier timestamp when
 * merging duplicate suggestions).
 *
 * **`resolved_at`** is nullable. Populated when status flips to
 * `pr_merged` or `dismissed`; NULL while the suggestion is still in
 * the queue.
 *
 * RLS-protected (migration hand-authors the policy):
 *   tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
 *
 * The NULLIF wrapper makes an unset GUC fail-safe to "deny
 * everything" rather than relying on the unsafe `''::uuid` coercion
 * (see 0003 commentary + 0022 audit_log keystone). FORCE ROW LEVEL
 * SECURITY is set even on owner-controlled tables, otherwise the
 * cpa role bypasses RLS.
 *
 * **GRANT discipline**: SELECT/INSERT/UPDATE only. DELETE is REVOKEd
 * — suggestions are dismissed (status flip) not removed; the row is
 * the audit record of "we considered this".
 *
 * Naming convention: camelCase TS / snake_case SQL (per existing
 * tenant / event / mapping_rule / narrative_draft precedent).
 */

/**
 * Single source of truth for prompt_suggestion source_kind classification.
 *
 * Mirrors the `prompt_suggestion_source_kind_valid` CHECK constraint
 * in `0038_prompt_suggestion_queue.sql`. Drift between this array and
 * the SQL CHECK surfaces as a runtime constraint violation on insert.
 *
 * Three-way parity (this array ↔ SQL CHECK ↔ Zod enum in @cpa/schemas)
 * lands with Task B.4 — the Zod schema sketch happens here as a code
 * comment for now.
 */
export const PROMPT_SUGGESTION_SOURCE_KINDS = [
  'consultant_flag',
  'rif_event',
  'contract_test_failure',
  'reviewer_disposition',
] as const;
export type PromptSuggestionSourceKind = (typeof PROMPT_SUGGESTION_SOURCE_KINDS)[number];

/**
 * Single source of truth for prompt_suggestion status lifecycle.
 *
 * Mirrors the `prompt_suggestion_status_valid` CHECK constraint in
 * `0038_prompt_suggestion_queue.sql`. Lifecycle:
 *   - `open`        — flagged, not yet reviewed.
 *   - `triaged`     — reviewer assigned a triage_classification.
 *   - `pr_drafted`  — Task B.6 PR-drafter opened a GitHub PR.
 *   - `pr_merged`   — the PR was merged (resolved_at populated).
 *   - `dismissed`   — reviewer determined no action needed (resolved_at populated).
 */
export const PROMPT_SUGGESTION_STATUSES = [
  'open',
  'triaged',
  'pr_drafted',
  'pr_merged',
  'dismissed',
] as const;
export type PromptSuggestionStatus = (typeof PROMPT_SUGGESTION_STATUSES)[number];

/**
 * Single source of truth for prompt_suggestion triage_classification.
 *
 * Mirrors the `prompt_suggestion_triage_classification_valid` CHECK
 * constraint in `0038_prompt_suggestion_queue.sql`. Nullable on the
 * column — these values apply only once a reviewer has triaged the
 * suggestion (Task B.3).
 */
export const PROMPT_SUGGESTION_TRIAGE_CLASSIFICATIONS = [
  'prompt_change',
  'schema_change',
  'code_change',
  'no_action_needed',
] as const;
export type PromptSuggestionTriageClassification =
  (typeof PROMPT_SUGGESTION_TRIAGE_CLASSIFICATIONS)[number];

export const promptSuggestion = pgTable(
  'prompt_suggestion',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    id: uuid('id')
      .notNull()
      .$defaultFn(() => crypto.randomUUID()),
    flaggedByUserId: uuid('flagged_by_user_id')
      .notNull()
      .references(() => user.id),
    flaggedAt: timestamp('flagged_at', { withTimezone: true }).notNull().defaultNow(),
    sourceKind: text('source_kind', { enum: PROMPT_SUGGESTION_SOURCE_KINDS }).notNull(),
    // jsonb shape varies by source_kind; structural validation lives at
    // the API layer (Task B.2). $type intentionally left as `unknown`
    // here — Task B.4 introduces the discriminated-union Zod schema in
    // @cpa/schemas and we'll narrow the column type then.
    sourcePayload: jsonb('source_payload').notNull(),
    affectedPromptModule: text('affected_prompt_module'),
    affectedSectionKind: text('affected_section_kind'),
    issueSummary: text('issue_summary').notNull(),
    status: text('status', { enum: PROMPT_SUGGESTION_STATUSES }).notNull().default('open'),
    // Nullable: NULL until the reviewer triages (Task B.3).
    triageClassification: text('triage_classification', {
      enum: PROMPT_SUGGESTION_TRIAGE_CLASSIFICATIONS,
    }),
    // Nullable: populated when status flips to pr_merged or dismissed.
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    firstRecordedAt: timestamp('first_recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.id] }),
    // Queue-list scan — "all open suggestions for tenant X" / "all
    // pr_drafted suggestions for tenant X" in the triage UI.
    statusIdx: index('prompt_suggestion_status_idx').on(t.tenantId, t.status),
    // Source-filter scan — "all rif_event suggestions for tenant X" in
    // the triage UI's source-filter panel.
    sourceKindIdx: index('prompt_suggestion_source_kind_idx').on(t.tenantId, t.sourceKind),
  }),
);

/** Inferred row type for SELECT statements via drizzle. */
export type PromptSuggestion = InferSelectModel<typeof promptSuggestion>;

/** Inferred row type for INSERT statements via drizzle. */
export type NewPromptSuggestion = InferInsertModel<typeof promptSuggestion>;
