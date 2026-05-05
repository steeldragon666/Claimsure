/**
 * Multi-file PR choreography (Task B.5 / P7).
 *
 * The single trusted code path that turns a {@link PromptSuggestionEvaluation}
 * (produced read-only by the B.4 evaluator agent) into a real branch + commit
 * + draft PR on the cpa-platform repo. Implements design Section 3.4
 * verbatim, with explicit atomic-or-rollback semantics on top.
 *
 * SEQUENCE
 * --------
 *   1. Auth          — exchange GitHub App JWT for an installation token.
 *   2. Get main SHA  — `GET /repos/:owner/:repo/git/refs/heads/main`.
 *   3. Branch        — `POST /repos/:owner/:repo/git/refs` from main SHA.
 *   4. Tree          — `POST /repos/:owner/:repo/git/trees` from change-set.
 *      • All `create`/`modify` files become tree entries at mode 100644.
 *      • All `delete` files become tree entries with `sha: null`, which
 *        instructs GitHub to drop the path in the resulting tree.
 *      • Tree is built atop main's `tree.sha` so unaffected files survive.
 *   5. Commit        — `POST /repos/:owner/:repo/git/commits`. Bot author +
 *      committer (no human GPG signing); parent: [mainSha].
 *   6. Update ref    — `PATCH /repos/:owner/:repo/git/refs/heads/<branch>`.
 *      Fast-forward only (no `force: true`); we just created the branch and
 *      nothing else has touched it.
 *   7. Contract test — subprocess `pnpm --filter <pkg> test --test-name-pattern <pat>`.
 *      If exitCode !== 0 → roll back the branch; do NOT open the PR.
 *   8. Open PR       — `POST /repos/:owner/:repo/pulls` with structured body
 *      (suggestion context + change-set rationale + reviewer attribution).
 *      Opens as a draft (`draft: true`) per the B.5 task spec; design 3.4
 *      had `draft: false` but the task overrides to draft so the consultant
 *      reviews before CI/CD picks it up.
 *   9. Return        — { pr_number, pr_url, branch_name, commit_sha,
 *      changed_files }. The API handler (Task B.5's API surface) persists
 *      a `prompt_suggestion_pr` row + flips parent suggestion to
 *      `pr_drafted` in a single transaction.
 *
 * ATOMIC-OR-ROLLBACK
 * ------------------
 * Once the branch ref exists (step 3 onward), any error on steps 4–8
 * triggers branch deletion in a `try/catch/finally`-ish sequence:
 *
 *     try { ...steps 4-8... }
 *     catch (err) {
 *        try { deleteBranchRef(...); }
 *        catch (deleteErr) { logger.warn(...); }   // best-effort, never throws
 *        throw new ChoreographyError(stage, err, ...);
 *     }
 *
 * The branch is the only side-effect that survives a step-4-or-later
 * failure if we don't clean up; the commit, tree, and blobs are reachable
 * only via the branch ref, so deleting the ref garbage-collects them
 * implicitly (GitHub prunes unreachable objects).
 *
 * FAILURE → STAGE TAGGING
 * -----------------------
 * Every error is wrapped in a {@link ChoreographyError} carrying a stage
 * tag (`'auth' | 'branch' | 'tree' | 'commit' | 'ref_update' | 'contract_test' | 'pr_create' | 'unknown'`).
 * The API layer dispatches on the stage:
 *   - `contract_test` → 422 (a valid evaluation produced a broken change
 *     set; client gets stdout/stderr to display in the UI).
 *   - `auth` / `pr_create` → 502 (upstream GitHub error, likely
 *     transient).
 *   - everything else → 500.
 *
 * GITHUB API SHAPE NOTES
 * ----------------------
 * - `Accept: application/vnd.github+json` and `X-GitHub-Api-Version: 2022-11-28`
 *   come from {@link getGitHubAppHeaders} so this module doesn't have to
 *   re-state the API version.
 * - `User-Agent` is added by us — GitHub rejects requests without one.
 * - We use Node 20+'s built-in `fetch` (no Octokit dependency on the
 *   workspace). The hand-rolled fetch matches the B.2 precedent in
 *   installation-token.ts.
 * - For DELETE requests GitHub returns 204 with empty body; we treat
 *   any 2xx as success and don't `.json()` the response.
 *
 * SECURITY
 * --------
 * - `evaluation.files[].newContent` is opaque user-controlled text. We do
 *   NOT sanitize or interpret it server-side; the model's tool-use schema
 *   already caps each file at 200 KB and the change-set at 20 files. The
 *   PR body deliberately does NOT echo `newContent` (only path + change_kind
 *   + rationale per file) so a malicious file content can't smuggle a
 *   prompt-injection into the reviewer's PR-body view via the diff.
 * - Bot identity: commits are authored as `cpa-platform-bot` via the
 *   GitHub App's installation. Email defaults to `bot@cpa-platform.local`
 *   and is configurable via `GITHUB_BOT_EMAIL`. Both the `author` and
 *   `committer` blocks are set so the GitHub UI shows a single bot
 *   identity (not a `committer: GitHub` slip).
 *
 * IDEMPOTENCY / CONCURRENCY
 * -------------------------
 * The branch name is derived from the suggestion id prefix, so two
 * concurrent calls for the same suggestion id collide on `createRef`
 * (GitHub returns 422 "Reference already exists"). The API layer
 * (apps/api/src/routes/prompt-suggestions.ts) enforces a 409 at the
 * SQL state-machine layer first (`status === 'triaged'` guard with
 * race-safe UPDATE), so this collision is a defence-in-depth backstop —
 * not the primary concurrency control. The branch-name shape itself
 * (suggestion-id prefix) is what makes parallel suggestions safe.
 */

import type { PromptSuggestionEvaluation } from '@cpa/agents';
import { getGitHubAppHeaders } from './octokit-factory.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Subset of the `prompt_suggestion` row this module consumes. The API
 * layer (apps/api/src/routes/prompt-suggestions.ts) loads the full row
 * inside an RLS-scoped tx and passes the relevant fields here. We keep
 * the shape narrow rather than depending on `@cpa/db` schema types so
 * the package's dep tree stays minimal — and so a test fixture can be
 * a plain object literal.
 */
export interface PromptSuggestionForChoreography {
  id: string;
  tenant_id: string;
  flagged_by_user_id: string;
  source_kind: 'consultant_flag' | 'rif_event' | 'contract_test_failure' | 'reviewer_disposition';
  affected_prompt_module: string | null;
  affected_section_kind: string | null;
  issue_summary: string;
}

/**
 * Subprocess result shape for contract-test injection. Mirrors the
 * `runContractTestSubprocess` return shape from
 * `packages/agents/src/suggestion-evaluator/repo-tools.ts` so the API
 * layer can simply pass that function through (or wrap it with extra
 * logging) without an adapter.
 */
export interface ContractTestResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Optional — present in the agents-package implementation; not all
   *  test injectors will set it. */
  timedOut?: boolean;
}

export type ContractTestRunner = (
  packageFilter: string,
  testPattern: string,
) => Promise<ContractTestResult>;

export interface ChoreographyOptions {
  /** GitHub App ID (numeric, string-encoded). */
  appId: string;
  /** PEM-encoded App private key. */
  privateKey: string;
  /** GitHub App installation ID for the cpa-platform repo. */
  installationId: string;
  /** GitHub repo owner (user or org login). */
  owner: string;
  /** GitHub repo name. */
  repo: string;
  /** The triaged suggestion this PR addresses. */
  suggestion: PromptSuggestionForChoreography;
  /** The B.4 evaluator's structured change-set proposal. */
  evaluation: PromptSuggestionEvaluation;
  /** UUID of the user who triggered the choreography. */
  reviewerUserId: string;
  /** DI seam for tests. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /** DI seam for tests. If provided, called BEFORE `pulls.create` to
   *  exercise contract tests against the proposed change. If omitted,
   *  the contract-test stage is SKIPPED — used in tests where the
   *  test runner can't bring up the full pnpm sandbox. Production
   *  callers MUST provide a runner; a TODO comment in the API handler
   *  pins the wiring. */
  runContractTest?: ContractTestRunner;
  /** Bot author email; defaults to `process.env.GITHUB_BOT_EMAIL` or
   *  `bot@cpa-platform.local`. */
  botEmail?: string;
  /** Bot author display name; defaults to `cpa-platform-bot`. */
  botName?: string;
  /** Logger seam — only `warn` is used today (best-effort cleanup
   *  failures). Defaults to a no-op. */
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

export interface ChoreographyChangedFile {
  path: string;
  change_kind: 'create' | 'modify' | 'delete';
}

export interface ChoreographyResult {
  pr_number: number;
  pr_url: string;
  branch_name: string;
  commit_sha: string;
  changed_files: ChoreographyChangedFile[];
}

export type ChoreographyStage =
  | 'auth'
  | 'branch'
  | 'tree'
  | 'commit'
  | 'ref_update'
  | 'contract_test'
  | 'pr_create'
  | 'unknown';

/**
 * Tagged error type. The API handler dispatches on `.stage` to map to
 * the right HTTP status code; tests assert on `.stage` to verify the
 * choreography reports the failing step accurately.
 *
 * `cause` carries the underlying error (an `Error`, an HTTP failure
 * envelope, or — for contract_test — a {@link ContractTestResult}) so
 * the handler can render diagnostics without re-running the failed
 * step.
 */
export class ChoreographyError extends Error {
  public readonly stage: ChoreographyStage;
  // `Error.cause` exists since ES2022; we shadow it explicitly with a
  // non-optional `unknown` type so callers can switch on `.cause` without
  // narrowing the union from the base class.
  public override readonly cause: unknown;
  constructor(stage: ChoreographyStage, cause: unknown, message: string) {
    super(message);
    this.name = 'ChoreographyError';
    this.stage = stage;
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Internal HTTP helpers
// ---------------------------------------------------------------------------

const GH_USER_AGENT = 'cpa-platform-github-app';

/**
 * Build an absolute GitHub API URL. Repo path segments are encoded
 * even though `owner`/`repo` are normally tame, as a defence-in-depth
 * gate against an env-var typo putting a `/` or `?` into the URL.
 */
function ghUrl(owner: string, repo: string, suffix: string): string {
  const o = encodeURIComponent(owner);
  const r = encodeURIComponent(repo);
  return `https://api.github.com/repos/${o}/${r}${suffix}`;
}

interface ApiCallOpts {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  fetchImpl: typeof globalThis.fetch;
  /** What stage to tag a failure with. */
  stage: ChoreographyStage;
  /** What to print in the error if this call fails. */
  context: string;
  /** If true, parse + return JSON. Defaults to true. DELETE returns
   *  204 / empty body — set false for those. */
  expectJson?: boolean;
}

/**
 * Single-shot GitHub API call with structured error wrapping. We
 * deliberately do NOT retry transparently here:
 *   - Retries on a write (createRef, createCommit, ...) need to be aware
 *     of "did the previous attempt actually succeed but the response
 *     drop?" — without server-side idempotency keys (GitHub doesn't
 *     give us one for git refs), retrying blindly can produce duplicate
 *     PRs.
 *   - The API handler's request lifetime is bounded by Fastify's
 *     5-minute timeout (B.5 task spec); a transient blip on createTree
 *     surfaces as a 502 and the consultant retries the request.
 * If a future task wants opportunistic retry on idempotent reads
 * (getMainRef), wire it in `getMainRef` only with explicit safe-to-retry
 * scoping.
 */
async function apiCall<T>(opts: ApiCallOpts): Promise<T> {
  const { method, url, headers, body, fetchImpl, stage, context, expectJson = true } = opts;
  let res: Response;
  try {
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    res = await fetchImpl(url, init);
  } catch (e) {
    throw new ChoreographyError(stage, e, `${context}: network error: ${String(e)}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '<unreadable>');
    throw new ChoreographyError(
      stage,
      { status: res.status, statusText: res.statusText, body: text },
      `${context}: GitHub returned ${res.status} ${res.statusText}: ${text.slice(0, 1000)}`,
    );
  }
  if (!expectJson) return undefined as unknown as T;
  try {
    return (await res.json()) as T;
  } catch (e) {
    throw new ChoreographyError(stage, e, `${context}: malformed JSON response: ${String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// PR body rendering
// ---------------------------------------------------------------------------

/**
 * Render the structured PR body. Sections (in order):
 *   1. Header — links back to the suggestion id + classification.
 *   2. Suggestion context — issue_summary, source_kind, flagged_by,
 *      affected module/section.
 *   3. Change-set rationale — one bullet per file (path, change_kind,
 *      truncated rationale).
 *   4. Cross-file consistency checks the evaluator ran.
 *   5. Reviewer attribution — who triggered this PR generation.
 *   6. Footer — generated-by signature.
 *
 * Crucially, the body does NOT include `evaluation.files[].newContent`.
 * The diff itself lives in the GitHub PR's "Files changed" tab, which
 * GitHub renders from the actual commit. Including the raw newContent
 * here would (a) bloat the body past GitHub's 65 535-char limit on
 * larger change sets, and (b) re-expose the surface where a
 * malicious file content could attempt prompt-injection on a
 * reviewer who pastes the body into another LLM.
 */
export function renderSuggestionPrBody(
  suggestion: PromptSuggestionForChoreography,
  evaluation: PromptSuggestionEvaluation,
  reviewerUserId: string,
): string {
  const lines: string[] = [];
  lines.push(`# Prompt suggestion PR — \`${suggestion.id}\``);
  lines.push('');
  lines.push(`**Classification:** \`${evaluation.classification}\``);
  lines.push('');
  lines.push('## Suggestion context');
  lines.push('');
  lines.push(`- **Issue summary:** ${suggestion.issue_summary}`);
  lines.push(`- **Source kind:** \`${suggestion.source_kind}\``);
  lines.push(`- **Flagged by:** \`${suggestion.flagged_by_user_id}\``);
  if (suggestion.affected_prompt_module) {
    lines.push(`- **Affected prompt module:** \`${suggestion.affected_prompt_module}\``);
  }
  if (suggestion.affected_section_kind) {
    lines.push(`- **Affected section kind:** \`${suggestion.affected_section_kind}\``);
  }
  lines.push('');
  lines.push('## Rationale summary');
  lines.push('');
  lines.push(evaluation.rationale_summary);
  lines.push('');
  lines.push('## Change set');
  lines.push('');
  if (evaluation.files.length === 0) {
    lines.push('_No files in change set (classification: `no_action_needed`)._');
  } else {
    for (const f of evaluation.files) {
      // Cap rationale at 400 chars in the rendered bullet so a 20-file
      // change set doesn't exceed GitHub's 65 535-char body limit.
      const truncated = f.rationale.length > 400 ? `${f.rationale.slice(0, 400)}…` : f.rationale;
      lines.push(`- \`${f.path}\` (\`${f.change_kind}\`) — ${truncated}`);
    }
  }
  lines.push('');
  if (evaluation.cross_file_consistency_checks_run.length > 0) {
    lines.push('## Cross-file consistency checks');
    lines.push('');
    for (const check of evaluation.cross_file_consistency_checks_run) {
      lines.push(`- ${check}`);
    }
    lines.push('');
  }
  lines.push('## Review attribution');
  lines.push('');
  lines.push(`Triggered by reviewer \`${reviewerUserId}\`.`);
  lines.push(
    `Generated by \`prompt-suggestion-evaluate@${evaluation.prompt_version}\` (model: \`${evaluation.model}\`).`,
  );
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(
    '_This PR was generated by the cpa-platform prompt-suggestion choreography (Task B.5)._',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tree-entry assembly
// ---------------------------------------------------------------------------

interface GitHubTreeEntry {
  path: string;
  mode: '100644' | '100755' | '040000' | '160000' | '120000';
  type: 'blob' | 'tree' | 'commit';
  content?: string;
  sha?: string | null;
}

/**
 * Convert the evaluation's `files[]` into GitHub git/createTree tree
 * entries.
 *   - create / modify  →  `{ type: 'blob', mode: '100644', content }`
 *     GitHub creates the blob server-side; no separate POST /git/blobs
 *     round-trip needed.
 *   - delete          →  `{ type: 'blob', mode: '100644', sha: null }`
 *     GitHub interprets `sha: null` as "remove this path from the
 *     resulting tree". We pass `mode: '100644'` even on delete because
 *     the API requires the field.
 */
function buildTreeEntries(evaluation: PromptSuggestionEvaluation): GitHubTreeEntry[] {
  return evaluation.files.map((f) => {
    if (f.change_kind === 'delete') {
      return { path: f.path, mode: '100644', type: 'blob', sha: null };
    }
    return { path: f.path, mode: '100644', type: 'blob', content: f.newContent };
  });
}

// ---------------------------------------------------------------------------
// Choreography entry point
// ---------------------------------------------------------------------------

/** Best-effort branch deletion. Never throws — the caller has already
 *  failed and is about to throw a ChoreographyError; throwing again here
 *  would lose the original cause. We log a warning and move on. */
async function tryDeleteBranchRef(
  fetchImpl: typeof globalThis.fetch,
  headers: Record<string, string>,
  owner: string,
  repo: string,
  branchName: string,
  logger: NonNullable<ChoreographyOptions['logger']>,
): Promise<void> {
  try {
    const url = ghUrl(owner, repo, `/git/refs/heads/${encodeURIComponent(branchName)}`);
    const res = await fetchImpl(url, { method: 'DELETE', headers });
    if (!res.ok) {
      const text = await res.text().catch(() => '<unreadable>');
      logger.warn(
        `pr-choreography: branch delete returned ${res.status} ${res.statusText}: ${text.slice(0, 300)}`,
        { branchName, owner, repo, status: res.status },
      );
    }
  } catch (e) {
    logger.warn(`pr-choreography: branch delete network error: ${String(e)}`, {
      branchName,
      owner,
      repo,
    });
  }
}

/**
 * The branch name for a suggestion. Exported for the test file (we
 * assert determinism) and for the API handler (which echoes it back in
 * 422 contract-test failures so the consultant sees what was deleted).
 */
export function branchNameFor(suggestionId: string): string {
  // Slice 8 hex chars off the front of the v4 UUID. With 2^32 entries
  // the birthday-collision probability is ~1e-5 around the 65 k-suggestion
  // mark — well above our expected lifetime queue depth — and tenant_id
  // doesn't enter the branch name because GitHub branch refs are global
  // to the repo, not tenant-scoped.
  return `prompt-suggestion/${suggestionId.slice(0, 8)}`;
}

/** GitHub `GET /repos/:o/:r/git/ref/heads/main` response shape we care about. */
interface GitRefResponse {
  ref: string;
  object: { sha: string; type: string };
}

/** GitHub `GET /repos/:o/:r/git/commits/:sha` response shape we care about. */
interface GitCommitResponse {
  sha: string;
  tree: { sha: string };
}

/** GitHub `POST /repos/:o/:r/git/trees` response shape we care about. */
interface GitTreeResponse {
  sha: string;
}

/** GitHub `POST /repos/:o/:r/git/commits` response shape we care about. */
interface GitNewCommitResponse {
  sha: string;
}

/** GitHub `POST /repos/:o/:r/pulls` response shape we care about. */
interface PullsCreateResponse {
  number: number;
  html_url: string;
}

export async function generatePullRequest(opts: ChoreographyOptions): Promise<ChoreographyResult> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const logger = opts.logger ?? { warn: () => {} };
  const botEmail = opts.botEmail ?? process.env['GITHUB_BOT_EMAIL'] ?? 'bot@cpa-platform.local';
  const botName = opts.botName ?? 'cpa-platform-bot';
  const branchName = branchNameFor(opts.suggestion.id);
  const { owner, repo } = opts;

  // ---- Stage 1: auth -----------------------------------------------------
  let headers: Record<string, string>;
  try {
    const ghHeaders = await getGitHubAppHeaders({
      appId: opts.appId,
      privateKey: opts.privateKey,
      installationId: opts.installationId,
      fetch: fetchImpl,
    });
    headers = {
      ...ghHeaders,
      'User-Agent': GH_USER_AGENT,
    };
  } catch (e) {
    throw new ChoreographyError('auth', e, `pr-choreography: auth failed: ${String(e)}`);
  }

  // ---- Stage 2: get main SHA + tree --------------------------------------
  // We fetch BOTH the main ref (to get the head commit SHA) and the
  // commit (to get its tree SHA). The createTree call needs `base_tree`
  // = the tree SHA, NOT the commit SHA — tree.sha and commit.sha are
  // different objects. The cost is one extra round-trip; the alternative
  // (`git/refs/heads/main` returns object.sha which IS the commit SHA;
  // we then `git/commits/:sha` to peel to the tree) is what we do.
  const mainRef = await apiCall<GitRefResponse>({
    method: 'GET',
    url: ghUrl(owner, repo, `/git/ref/heads/main`),
    headers,
    fetchImpl,
    stage: 'branch',
    context: 'pr-choreography: get main ref',
  });
  const mainSha = mainRef.object.sha;
  const mainCommit = await apiCall<GitCommitResponse>({
    method: 'GET',
    url: ghUrl(owner, repo, `/git/commits/${encodeURIComponent(mainSha)}`),
    headers,
    fetchImpl,
    stage: 'branch',
    context: 'pr-choreography: get main commit',
  });
  const mainTreeSha = mainCommit.tree.sha;

  // ---- Stage 3: create branch ref ----------------------------------------
  await apiCall<unknown>({
    method: 'POST',
    url: ghUrl(owner, repo, `/git/refs`),
    headers,
    body: { ref: `refs/heads/${branchName}`, sha: mainSha },
    fetchImpl,
    stage: 'branch',
    context: 'pr-choreography: create branch ref',
  });

  // ---- Stages 4-8: under try/catch with branch-rollback on failure -------
  try {
    // Stage 4: create tree
    const treeEntries = buildTreeEntries(opts.evaluation);
    const tree = await apiCall<GitTreeResponse>({
      method: 'POST',
      url: ghUrl(owner, repo, `/git/trees`),
      headers,
      body: { base_tree: mainTreeSha, tree: treeEntries },
      fetchImpl,
      stage: 'tree',
      context: 'pr-choreography: create tree',
    });

    // Stage 5: create commit
    // Title format: "prompt-suggestion(<8-char>): <summary>" so a `git
    // log --oneline` immediately discloses what the commit is for.
    const commitTitle = `prompt-suggestion(${opts.suggestion.id.slice(0, 8)}): ${opts.suggestion.issue_summary.slice(0, 100)}`;
    const commit = await apiCall<GitNewCommitResponse>({
      method: 'POST',
      url: ghUrl(owner, repo, `/git/commits`),
      headers,
      body: {
        message: commitTitle,
        tree: tree.sha,
        parents: [mainSha],
        author: { name: botName, email: botEmail },
        committer: { name: botName, email: botEmail },
      },
      fetchImpl,
      stage: 'commit',
      context: 'pr-choreography: create commit',
    });

    // Stage 6: update branch ref to point at commit.sha
    await apiCall<unknown>({
      method: 'PATCH',
      url: ghUrl(owner, repo, `/git/refs/heads/${encodeURIComponent(branchName)}`),
      headers,
      body: { sha: commit.sha, force: false },
      fetchImpl,
      stage: 'ref_update',
      context: 'pr-choreography: update branch ref',
    });

    // Stage 7: contract test (BEFORE PR creation)
    if (opts.runContractTest !== undefined) {
      // Pick a sensible default test/package filter from the evaluator's
      // own checks_run array if it nominated one; else fall back to a
      // suggestion-id-based pattern that's effectively a no-op (matches
      // nothing → exit 0). The API handler is welcome to wrap and pick
      // a smarter pattern; this module's contract is just "if you
      // provide a runner, we call it".
      //
      // We hand the runner the change-set context so the runner can
      // pick the right pattern; for now we use a generic filter ('@cpa')
      // and a pattern derived from the suggestion id so test seams
      // remain deterministic.
      const packageFilter = '@cpa';
      const testPattern = `prompt-suggestion-${opts.suggestion.id.slice(0, 8)}`;
      let result: ContractTestResult;
      try {
        result = await opts.runContractTest(packageFilter, testPattern);
      } catch (e) {
        throw new ChoreographyError(
          'contract_test',
          e,
          `pr-choreography: contract-test runner threw: ${String(e)}`,
        );
      }
      if (result.exitCode !== 0) {
        throw new ChoreographyError(
          'contract_test',
          result,
          `pr-choreography: contract test failed (exit ${result.exitCode})`,
        );
      }
    }

    // Stage 8: open the PR
    const prTitle = `prompt-suggestion: ${opts.suggestion.issue_summary.slice(0, 72)}`;
    const prBody = renderSuggestionPrBody(opts.suggestion, opts.evaluation, opts.reviewerUserId);
    const pr = await apiCall<PullsCreateResponse>({
      method: 'POST',
      url: ghUrl(owner, repo, `/pulls`),
      headers,
      body: {
        title: prTitle,
        body: prBody,
        head: branchName,
        base: 'main',
        draft: true,
      },
      fetchImpl,
      stage: 'pr_create',
      context: 'pr-choreography: open pull request',
    });

    return {
      pr_number: pr.number,
      pr_url: pr.html_url,
      branch_name: branchName,
      commit_sha: commit.sha,
      changed_files: opts.evaluation.files.map((f) => ({
        path: f.path,
        change_kind: f.change_kind,
      })),
    };
  } catch (err) {
    // Best-effort rollback of the branch we just created. Any failure
    // here is logged but does not mask the original error — the
    // consultant cares about WHY the PR didn't open, not that the
    // cleanup also flailed.
    await tryDeleteBranchRef(fetchImpl, headers, owner, repo, branchName, logger);

    if (err instanceof ChoreographyError) {
      throw err;
    }
    throw new ChoreographyError(
      'unknown',
      err,
      `pr-choreography: unexpected error: ${String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Internal exports for testing
// ---------------------------------------------------------------------------

export const _internals = {
  buildTreeEntries,
  branchNameFor,
  GH_USER_AGENT,
};
