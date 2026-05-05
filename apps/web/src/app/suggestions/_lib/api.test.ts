import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictError } from '@/lib/api';
import { generatePullRequest } from './api.js';
import type { GeneratePullRequestResponse } from './api.js';

/**
 * P7 Theme B Task B.7 review fixes — tests for the generate-PR API wrapper.
 *
 * apps/web's test runner is `tsx --test` (Node, no jsdom). The mocking
 * pattern matches `apps/web/src/lib/api.test.ts`: replace globalThis.fetch
 * with a deterministic stub and assert the wrapper's URL / method / body
 * shape, plus its response decoding and error mapping.
 */

const SUGGESTION_ID = '00000000-0000-4000-8000-000000000001';
const TENANT_ID = '00000000-0000-4000-8000-000000000099';

const SUCCESS_BODY: GeneratePullRequestResponse = {
  pr: {
    id: '00000000-0000-4000-8000-000000000010',
    tenant_id: TENANT_ID,
    suggestion_id: SUGGESTION_ID,
    github_pr_number: 42,
    github_pr_url: 'https://github.com/example/repo/pull/42',
    branch_name: 'p7-suggestion-fix-42',
    changed_files: ['packages/agents/src/foo.ts'],
    created_at: '2026-05-04T11:30:00.000Z',
    merged_at: null,
    merge_commit_sha: null,
  },
  suggestion: {
    id: SUGGESTION_ID,
    tenant_id: TENANT_ID,
    flagged_by_user_id: '00000000-0000-4000-8000-000000000020',
    flagged_at: '2026-05-04T10:00:00.000Z',
    source_kind: 'consultant_flag',
    source_payload: { reason: 'hypothesis is repeating itself' },
    affected_prompt_module: 'narrative.hypothesis',
    affected_section_kind: 'block',
    issue_summary: 'Hypothesis section repeats verbatim across cycles',
    status: 'pr_drafted',
    triage_classification: 'prompt_change',
    resolved_at: '2026-05-04T11:30:00.000Z',
    first_recorded_at: '2026-05-04T10:00:00.000Z',
  },
};

interface CapturedRequest {
  url: string;
  method: string | undefined;
  body: BodyInit | null | undefined;
  credentials: RequestCredentials | undefined;
}

const captureFetch = (
  status: number,
  body: unknown,
  captured: { value: CapturedRequest | null },
): typeof fetch => {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    captured.value = {
      url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      method: init?.method,
      body: init?.body,
      credentials: init?.credentials,
    };
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as unknown as Response);
  };
};

// =============================================================================
// generatePullRequest — URL + method shape
// =============================================================================

test('generatePullRequest: posts to /v1/suggestions/:id/generate-pr', async () => {
  const captured: { value: CapturedRequest | null } = { value: null };
  globalThis.fetch = captureFetch(202, SUCCESS_BODY, captured);

  await generatePullRequest(SUGGESTION_ID);

  assert.ok(captured.value, 'fetch should have been called');
  assert.equal(
    captured.value.url,
    `/v1/suggestions/${SUGGESTION_ID}/generate-pr`,
    'URL must match B.5 route shape exactly',
  );
  assert.equal(captured.value.method, 'POST');
  // POST with no body is intentional — the route reads everything from
  // the URL :id and the session cookie. apiFetch should NOT set a
  // body or content-type header when no body is provided.
  assert.equal(captured.value.body, undefined);
});

test('generatePullRequest: encodes the suggestionId path segment', async () => {
  const captured: { value: CapturedRequest | null } = { value: null };
  globalThis.fetch = captureFetch(202, SUCCESS_BODY, captured);

  // Use an id that requires URL encoding to surface any double-encode bug.
  const idWithSlash = 'has/slash-and-space and-plus+';
  await generatePullRequest(idWithSlash);

  assert.ok(captured.value);
  assert.equal(
    captured.value.url,
    `/v1/suggestions/${encodeURIComponent(idWithSlash)}/generate-pr`,
  );
});

// =============================================================================
// generatePullRequest — response decoding
// =============================================================================

test('generatePullRequest: 202 returns the typed { pr, suggestion } envelope', async () => {
  const captured: { value: CapturedRequest | null } = { value: null };
  globalThis.fetch = captureFetch(202, SUCCESS_BODY, captured);

  const result = await generatePullRequest(SUGGESTION_ID);

  // The wrapper preserves the wire shape verbatim — both the pr row and
  // the parent suggestion row (now flipped to pr_drafted).
  assert.equal(result.pr.github_pr_number, 42);
  assert.equal(result.pr.branch_name, 'p7-suggestion-fix-42');
  assert.equal(result.pr.suggestion_id, SUGGESTION_ID);
  assert.equal(result.suggestion.id, SUGGESTION_ID);
  assert.equal(result.suggestion.status, 'pr_drafted', 'API flips status to pr_drafted on success');
});

// =============================================================================
// generatePullRequest — error mapping
// =============================================================================

test('generatePullRequest: 409 throws ConflictError (stale-state recovery hook)', async () => {
  const captured: { value: CapturedRequest | null } = { value: null };
  globalThis.fetch = captureFetch(
    409,
    {
      error: 'invalid_state_transition',
      message: "cannot generate PR from status=open; suggestion must be 'triaged'",
    },
    captured,
  );

  await assert.rejects(
    () => generatePullRequest(SUGGESTION_ID),
    (err: unknown) => err instanceof ConflictError && err.status === 409,
  );
});

test('generatePullRequest: 503 evaluator_not_configured surfaces as ApiError', async () => {
  const captured: { value: CapturedRequest | null } = { value: null };
  globalThis.fetch = captureFetch(
    503,
    {
      error: 'evaluator_not_configured',
      message: 'Suggestion-evaluator is not wired into the API yet.',
    },
    captured,
  );

  await assert.rejects(
    () => generatePullRequest(SUGGESTION_ID),
    (err: unknown) => {
      // ApiError is the parent class; ConflictError / NotFoundError are
      // 409 / 404 specialisations. 503 doesn't have a named subclass, so
      // it surfaces as ApiError with status=503.
      return (
        err instanceof Error &&
        'status' in err &&
        (err as { status: number }).status === 503 &&
        (err as unknown as { errorCode: string }).errorCode === 'evaluator_not_configured'
      );
    },
  );
});
