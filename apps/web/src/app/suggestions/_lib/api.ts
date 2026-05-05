/**
 * Typed fetch helpers for the /suggestions surfaces (P7 Theme B Task B.7).
 *
 * Wraps the six prompt-suggestion endpoints registered by
 * `apps/api/src/routes/prompt-suggestions.ts`:
 *
 *   POST   /v1/suggestions                  (B.3)
 *   GET    /v1/suggestions                  (B.3 list with cursor)
 *   GET    /v1/suggestions/:id              (B.3 detail incl. pr + reviews)
 *   POST   /v1/suggestions/:id/triage       (B.3 reviewer)
 *   POST   /v1/suggestions/:id/review       (B.3 reviewer)
 *   POST   /v1/suggestions/:id/generate-pr  (B.5 choreography)
 *
 * Same shape as `apps/web/src/app/projects/_lib/api.ts` — thin wrappers
 * around `apiFetch`, typed via the local mirrors in `./types.ts`.
 *
 * URL prefix `/v1/...` is rewritten to the Fastify API on localhost via
 * `next.config.ts`.
 */

import { apiFetch } from '@/lib/api';
import type {
  ListSuggestionsResponse,
  PromptSuggestion,
  PromptSuggestionPr,
  PromptSuggestionReview,
  SuggestionDetailResponse,
  SuggestionReviewDisposition,
  SuggestionSourceKind,
  SuggestionStatus,
  SuggestionTriageClassification,
} from './types';

// ============================================================================
// POST /v1/suggestions — flag
// ============================================================================

export interface FlagSuggestionBody {
  source_kind: SuggestionSourceKind;
  source_payload: Record<string, unknown>;
  affected_prompt_module?: string;
  affected_section_kind?: string;
  issue_summary: string;
}

export interface FlagSuggestionResponse {
  suggestion: PromptSuggestion;
}

export async function flagSuggestion(
  body: FlagSuggestionBody,
  signal?: AbortSignal,
): Promise<FlagSuggestionResponse> {
  return apiFetch<FlagSuggestionResponse>('/v1/suggestions', {
    method: 'POST',
    body: JSON.stringify(body),
    signal,
  });
}

// ============================================================================
// GET /v1/suggestions — list
// ============================================================================

export interface ListSuggestionsOptions {
  status?: SuggestionStatus;
  source_kind?: SuggestionSourceKind;
  limit?: number;
  cursor?: string;
}

export async function listSuggestions(
  opts: ListSuggestionsOptions = {},
  signal?: AbortSignal,
): Promise<ListSuggestionsResponse> {
  const qs = new URLSearchParams();
  if (opts.status) qs.set('status', opts.status);
  if (opts.source_kind) qs.set('source_kind', opts.source_kind);
  if (typeof opts.limit === 'number') qs.set('limit', String(opts.limit));
  if (opts.cursor) qs.set('cursor', opts.cursor);
  const suffix = qs.toString();
  const path = suffix ? `/v1/suggestions?${suffix}` : '/v1/suggestions';
  return apiFetch<ListSuggestionsResponse>(path, { signal });
}

// ============================================================================
// GET /v1/suggestions/:id — detail (with reviews + pr)
// ============================================================================

export async function getSuggestion(
  id: string,
  signal?: AbortSignal,
): Promise<SuggestionDetailResponse> {
  return apiFetch<SuggestionDetailResponse>(`/v1/suggestions/${encodeURIComponent(id)}`, {
    signal,
  });
}

// ============================================================================
// POST /v1/suggestions/:id/triage
// ============================================================================

export interface TriageSuggestionBody {
  triage_classification: SuggestionTriageClassification;
  /** Spec restricts triage transitions: only triaged or dismissed. */
  status_after: 'triaged' | 'dismissed';
  notes?: string;
}

export interface TriageSuggestionResponse {
  suggestion: PromptSuggestion;
}

export async function triageSuggestion(
  id: string,
  body: TriageSuggestionBody,
  signal?: AbortSignal,
): Promise<TriageSuggestionResponse> {
  return apiFetch<TriageSuggestionResponse>(`/v1/suggestions/${encodeURIComponent(id)}/triage`, {
    method: 'POST',
    body: JSON.stringify(body),
    signal,
  });
}

// ============================================================================
// POST /v1/suggestions/:id/review
// ============================================================================

export interface ReviewSuggestionBody {
  disposition: SuggestionReviewDisposition;
  notes?: string;
}

export interface ReviewSuggestionResponse {
  review: PromptSuggestionReview;
}

export async function reviewSuggestion(
  id: string,
  body: ReviewSuggestionBody,
  signal?: AbortSignal,
): Promise<ReviewSuggestionResponse> {
  return apiFetch<ReviewSuggestionResponse>(`/v1/suggestions/${encodeURIComponent(id)}/review`, {
    method: 'POST',
    body: JSON.stringify(body),
    signal,
  });
}

// ============================================================================
// POST /v1/suggestions/:id/generate-pr — Task B.5 choreography
// ============================================================================

/**
 * Wire shape returned by POST /v1/suggestions/:id/generate-pr (HTTP 202).
 *
 * Mirrors the route handler in `apps/api/src/routes/prompt-suggestions.ts`
 * which returns `{ pr, suggestion }` after the GitHub App opens a draft
 * PR and the parent `prompt_suggestion.status` flips to `pr_drafted`.
 *
 * Error mapping (from the same handler):
 *   - 422 contract_test_failed     → evaluator output failed contract tests
 *   - 502 github_upstream_failure  → GitHub App / token errors
 *   - 503 evaluator_not_configured → evaluator dep not wired in this env
 *   - 503 github_app_not_configured → required GITHUB_APP_* env vars missing
 *   - 409 invalid_state_transition → suggestion not in `triaged` (race)
 */
export interface GeneratePullRequestResponse {
  pr: PromptSuggestionPr;
  suggestion: PromptSuggestion;
}

export async function generatePullRequest(
  id: string,
  signal?: AbortSignal,
): Promise<GeneratePullRequestResponse> {
  return apiFetch<GeneratePullRequestResponse>(
    `/v1/suggestions/${encodeURIComponent(id)}/generate-pr`,
    { method: 'POST', signal },
  );
}
