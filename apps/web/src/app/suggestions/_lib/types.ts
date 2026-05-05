/**
 * P7 Theme B Task B.7 — local type mirrors for the /suggestions surfaces.
 *
 * apps/web does NOT import from `@cpa/db` or `@cpa/agents` (those packages
 * compile for the worker / Fastify runtime; pulling them into Next.js
 * inflates the client bundle and duplicates the agent-bound types we
 * really only need three columns of). The shapes below mirror the wire
 * shapes returned by `apps/api/src/routes/prompt-suggestions.ts`'s
 * `toSuggestionApi` / `toReviewApi` / `toPrApi` helpers, with timestamps
 * normalised to ISO strings (the API serialises `Date` → ISO before
 * shipping over the wire).
 *
 * The canonical types live at:
 *   - {@link import('@cpa/db/schema').PromptSuggestion} (B.1)
 *   - {@link import('@cpa/db/schema').PromptSuggestionPr} (B.1)
 *   - {@link import('@cpa/db/schema').PromptSuggestionReview} (B.1)
 *
 * If the API mapping in `prompt-suggestions.ts#toSuggestionApi` drifts
 * from these shapes the TanStack Query hooks will surface the mismatch
 * at runtime; tests pin the four enum literal unions defensively.
 *
 * Same local-mirror pattern as `multi-cycle-timeline.tsx`'s
 * `CitationGraphEntry` / `NarrativeSegmentLite` declarations.
 */

// =============================================================================
// Enum literal unions — pinned from the SQL CHECK constraints in
// `0038_prompt_suggestion_queue.sql`. Drift between this file and the
// SQL constraint surfaces as 400/500 from the API on insert / read.
// =============================================================================

/**
 * Source taxonomy for a flagged suggestion. Mirrors
 * `PROMPT_SUGGESTION_SOURCE_KINDS` in @cpa/db/schema/prompt_suggestion.
 */
export const SUGGESTION_SOURCE_KINDS = [
  'consultant_flag',
  'rif_event',
  'contract_test_failure',
  'reviewer_disposition',
] as const;
export type SuggestionSourceKind = (typeof SUGGESTION_SOURCE_KINDS)[number];

/**
 * Lifecycle status. Mirrors `PROMPT_SUGGESTION_STATUSES`. State transitions
 * are validated at the API layer (B.3); the UI just renders + drives the
 * triage / review / generate-pr endpoints conditional on the current
 * status.
 */
export const SUGGESTION_STATUSES = [
  'open',
  'triaged',
  'pr_drafted',
  'pr_merged',
  'dismissed',
] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

/** Reviewer-assigned classification at triage. Nullable until triaged. */
export const SUGGESTION_TRIAGE_CLASSIFICATIONS = [
  'prompt_change',
  'schema_change',
  'code_change',
  'no_action_needed',
] as const;
export type SuggestionTriageClassification = (typeof SUGGESTION_TRIAGE_CLASSIFICATIONS)[number];

/** Disposition recorded by a reviewer on a `triaged` suggestion. */
export const SUGGESTION_REVIEW_DISPOSITIONS = [
  'approve_for_pr',
  'request_more_info',
  'dismiss',
  'escalate_to_code_change',
] as const;
export type SuggestionReviewDisposition = (typeof SUGGESTION_REVIEW_DISPOSITIONS)[number];

// =============================================================================
// Wire shapes
// =============================================================================

/**
 * Wire shape returned by GET /v1/suggestions and GET /v1/suggestions/:id
 * (the `suggestion` field). Mirrors `toSuggestionApi` in
 * `apps/api/src/routes/prompt-suggestions.ts`.
 */
export interface PromptSuggestion {
  id: string;
  tenant_id: string;
  flagged_by_user_id: string;
  /** ISO 8601 timestamp. */
  flagged_at: string;
  source_kind: SuggestionSourceKind;
  /** jsonb — shape varies by `source_kind`; see API docs. */
  source_payload: unknown;
  affected_prompt_module: string | null;
  affected_section_kind: string | null;
  issue_summary: string;
  status: SuggestionStatus;
  triage_classification: SuggestionTriageClassification | null;
  /** ISO 8601 timestamp; populated when status flips to a terminal state. */
  resolved_at: string | null;
  /** ISO 8601 timestamp; defaults to flagged_at, set earlier on dedup. */
  first_recorded_at: string;
}

/** Wire shape returned by GET /v1/suggestions/:id (`reviews[]`). */
export interface PromptSuggestionReview {
  id: string;
  tenant_id: string;
  suggestion_id: string;
  reviewer_user_id: string;
  reviewed_at: string;
  disposition: SuggestionReviewDisposition;
  notes: string | null;
}

/** Wire shape returned by GET /v1/suggestions/:id (`pr` field, nullable). */
export interface PromptSuggestionPr {
  id: string;
  tenant_id: string;
  suggestion_id: string;
  github_pr_number: number;
  github_pr_url: string;
  branch_name: string;
  /** Array of file paths the PR touches; jsonb. */
  changed_files: unknown;
  created_at: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
}

/** Wire shape of GET /v1/suggestions (list). */
export interface ListSuggestionsResponse {
  suggestions: PromptSuggestion[];
  next_cursor: string | null;
}

/** Wire shape of GET /v1/suggestions/:id (detail). */
export interface SuggestionDetailResponse {
  suggestion: PromptSuggestion;
  reviews: PromptSuggestionReview[];
  pr: PromptSuggestionPr | null;
}

// =============================================================================
// Human-readable labels — drift-guarded by `Record<X, string>` so
// widening any of the unions above without a label here is a compile
// error.
// =============================================================================

export const SUGGESTION_STATUS_LABELS: Record<SuggestionStatus, string> = {
  open: 'Open',
  triaged: 'Triaged',
  pr_drafted: 'PR drafted',
  pr_merged: 'PR merged',
  dismissed: 'Dismissed',
};

export const SUGGESTION_SOURCE_KIND_LABELS: Record<SuggestionSourceKind, string> = {
  consultant_flag: 'Consultant flag',
  rif_event: 'RIF event',
  contract_test_failure: 'Contract test failure',
  reviewer_disposition: 'Reviewer disposition',
};

export const SUGGESTION_TRIAGE_CLASSIFICATION_LABELS: Record<
  SuggestionTriageClassification,
  string
> = {
  prompt_change: 'Prompt change',
  schema_change: 'Schema change',
  code_change: 'Code change',
  no_action_needed: 'No action needed',
};

export const SUGGESTION_REVIEW_DISPOSITION_LABELS: Record<SuggestionReviewDisposition, string> = {
  approve_for_pr: 'Approve for PR',
  request_more_info: 'Request more info',
  dismiss: 'Dismiss',
  escalate_to_code_change: 'Escalate to code change',
};

/**
 * Statuses that represent a terminal / resolved state. Used by the
 * PR-tracking widget to decide whether to keep polling.
 */
export const TERMINAL_SUGGESTION_STATUSES: ReadonlySet<SuggestionStatus> =
  new Set<SuggestionStatus>(['pr_merged', 'dismissed']);
