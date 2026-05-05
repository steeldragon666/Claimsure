/**
 * Suggestion-evaluator (`prompt-suggestion-evaluate@1.0.0`) shared constants,
 * Zod schemas, and helper types.
 *
 * The evaluator reads a `prompt_suggestion` row (queued by Task B.2) plus the
 * surrounding repo context (read-only via the four `repoTools` defined in
 * `repo-tools.ts`) and produces a structured CHANGE-SET PROPOSAL: which files
 * to create / modify / delete, with the new content for each, and a rationale.
 *
 * THE AGENT IS READ-ONLY. It cannot write files, execute arbitrary shells,
 * make network calls, or touch git state. The API layer (Task B.5's
 * choreography) is the single trusted code path that applies the proposal to
 * a branch. This package only PROPOSES — it never LANDS — which is the
 * security boundary against an LLM hallucination producing a bad change set.
 *
 * THREE-WAY PARITY: the `change_kind` and `classification` enums below are
 * authoritative for the agents-package side of the invariant. Their twins
 * live at:
 *   - SQL: `prompt_suggestion.triage_classification` CHECK in
 *     `packages/db/migrations/0038_prompt_suggestion_queue.sql`
 *     (`'prompt_change' | 'schema_change' | 'code_change' | 'no_action_needed'`)
 *   - API: triage endpoint validation in
 *     `apps/api/src/routes/prompt-suggestions.ts`
 *
 * Task B.8 contract tests will diff the three sides and fail loudly if a
 * future change touches one without the other two.
 */

import { z } from 'zod';

/**
 * The four classifications. Pinned in lock-step with the SQL CHECK on
 * `prompt_suggestion.triage_classification` (see migration 0038).
 *
 * - `prompt_change`     — touches `*@<version>.ts` prompt-module files only.
 * - `schema_change`     — touches Zod schemas and/or SQL CHECK constraints
 *                         (three-way-parity territory).
 * - `code_change`       — touches business logic outside prompt modules.
 * - `no_action_needed`  — investigation found the suggestion was a false
 *                         positive; no change set is proposed.
 */
export const SUGGESTION_CLASSIFICATIONS = [
  'prompt_change',
  'schema_change',
  'code_change',
  'no_action_needed',
] as const;
export type SuggestionClassification = (typeof SUGGESTION_CLASSIFICATIONS)[number];

/**
 * The three change kinds a single file entry can declare.
 *
 * The API layer (Task B.5) interprets these:
 *   - `create` — file MUST NOT exist on the branch base; `newContent` is the
 *               full content to write.
 *   - `modify` — file MUST exist on the branch base; `newContent` is the full
 *               replacement content (NOT a diff). The `diff_preview` field
 *               carries a unified-diff summary for human PR reviewers.
 *   - `delete` — file MUST exist; `newContent` MUST be empty string. The
 *               API layer enacts a `git rm` rather than writing empty
 *               content.
 */
export const CHANGE_KINDS = ['create', 'modify', 'delete'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/**
 * Hard cap on files-per-change-set. Surfaced in the tool schema. A single
 * suggestion that legitimately needs > {@link MAX_FILES_PER_CHANGE_SET} file
 * touches almost certainly should be split into multiple suggestions; this
 * cap also blunts the worst-case prompt-injection blast radius (an evaluator
 * pwned via a malicious source file cannot rewrite the entire repo in one
 * shot).
 */
export const MAX_FILES_PER_CHANGE_SET = 20;

/**
 * Rationale-per-file character bounds. Long enough to explain a change, short
 * enough to fit in a PR comment without a fold.
 */
export const RATIONALE_MIN = 20;
export const RATIONALE_MAX = 800;

/**
 * Whole-change-set summary character bounds. Lands in the PR description.
 */
export const RATIONALE_SUMMARY_MIN = 50;
export const RATIONALE_SUMMARY_MAX = 2000;

/**
 * Tool-input schema for {@link evaluatePromptSuggestion}.
 *
 * Mirrors design Section 3.5 EXACTLY — extra fields are rejected via
 * `.strict()` so a model that hallucinates a `delete_database: true` field
 * gets dropped at parse time.
 *
 * `newContent` carries the FULL replacement file content. `diff_preview` is
 * a humanised unified-diff snippet for PR reviewers (cheap to compute on the
 * server side too — the evaluator's preview is just a hint for now).
 */
const FileChange = z
  .object({
    path: z.string().min(1).max(1024),
    change_kind: z.enum(CHANGE_KINDS),
    rationale: z.string().min(RATIONALE_MIN).max(RATIONALE_MAX),
    diff_preview: z.string().max(20_000),
    newContent: z.string().max(200_000),
  })
  .strict();

export type FileChangeProposal = z.infer<typeof FileChange>;

/**
 * Top-level evaluation envelope. Lands in the agent's tool-use response.
 *
 * `prompt_version` is a literal `'1.0.0'` so the registry-level pinning is
 * mirrored in the payload — a future v1.1.0 would bump both the literal and
 * the registry key, and the contract test (Task B.8) catches a slip.
 *
 * `model` is filled by the runtime call wrapper (see
 * `runtime/tool-use.ts` precedent), NOT by the model itself. We allow the
 * model to declare it for forward compatibility, but the runtime overwrites.
 */
export const promptSuggestionEvaluateToolSchema = z
  .object({
    suggestion_id: z.string().uuid(),
    classification: z.enum(SUGGESTION_CLASSIFICATIONS),
    files: z.array(FileChange).max(MAX_FILES_PER_CHANGE_SET, {
      message: `files exceeds the per-pass cap of ${MAX_FILES_PER_CHANGE_SET}`,
    }),
    cross_file_consistency_checks_run: z.array(z.string().min(1).max(500)).max(50),
    rationale_summary: z.string().min(RATIONALE_SUMMARY_MIN).max(RATIONALE_SUMMARY_MAX),
    prompt_version: z.literal('1.0.0'),
    model: z.string().min(1).max(200),
  })
  .strict();

export type PromptSuggestionEvaluation = z.infer<typeof promptSuggestionEvaluateToolSchema>;

/**
 * Input bundle passed to the evaluator. The job processor (Task B.5)
 * assembles this from the `prompt_suggestion` row plus a project-context
 * snapshot. The model receives this as a JSON-serialised user message.
 */
export type SuggestionEvaluatorInput = {
  suggestion_id: string; // UUID
  source_kind: 'consultant_flag' | 'rif_event' | 'contract_test_failure' | 'reviewer_disposition';
  source_payload: unknown; // shape varies per source_kind
  affected_prompt_module: string | null;
  affected_section_kind: string | null;
  issue_summary: string;
  /**
   * Repo-root absolute path. Used by the tool layer to gate
   * read_file/list_directory path-traversal checks. The model NEVER sees
   * this value — it stays in the tool layer.
   */
  repo_root: string;
};

/**
 * Output of {@link SuggestionEvaluator.evaluate}.
 *
 * The structural fields come from the model's tool-use payload. The
 * metadata fields (`model`, `prompt_version`, `tokens_in`, `tokens_out`) are
 * stamped by the runtime, mirroring the precedent in
 * `synthesizer-register/types.ts` and `classifier-expenditure/types.ts`.
 */
export type SuggestionEvaluatorOutput = PromptSuggestionEvaluation & {
  // Stamped by the impl/runtime, NOT by the model:
  tokens_in: number;
  tokens_out: number;
};

export interface SuggestionEvaluator {
  evaluate(input: SuggestionEvaluatorInput): Promise<SuggestionEvaluatorOutput>;
}
