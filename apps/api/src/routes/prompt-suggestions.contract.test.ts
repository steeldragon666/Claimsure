/**
 * P7 Theme B Task B.8 — prompt-suggestion CONTRACT tests.
 *
 * Integration-boundary tests covering the four spec'd areas of Theme B:
 *
 *   1. Module wiring     — B.4 evaluator output composes cleanly into B.5
 *                           choreography input (no field-name drift between
 *                           the agent's tool-use schema and the GitHub
 *                           choreography options).
 *   2. B.5 choreography  — mocked-fetch happy path verifies the createRef
 *                           → createTree → createCommit → updateRef →
 *                           createPR sequence, AND the contract-test-fail
 *                           rollback path verifies the branch DELETE
 *                           happens with no PR opened.
 *   3. B.6 webhook       — round trip `pr_drafted` → `pr_merged`,
 *                           idempotent redelivery, and the `unknown-pr`
 *                           anomaly. Asserted at the API surface
 *                           (HTTP injection through buildApp), mirroring
 *                           how the wider B.6 test does it.
 *   4. Three-way parity  — for `source_kind`, `status`,
 *                           `triage_classification`, and `disposition`:
 *                           SQL CHECK constraint values from migration
 *                           0038 ↔ `@cpa/db` const arrays ↔ inline Zod
 *                           enums in `prompt-suggestions.ts` (exposed
 *                           via `_internals`).
 *
 * Why "contract" and not "end-to-end":
 * Mirrors the structure of `apps/api/src/routes/multi-cycle.contract.test.ts`
 * (Theme A's contract test). DB-touching tests (the parity SQL probe and
 * the B.6 round-trip) are gated on `dbAvailable` via `skipIfNoDb` (matches
 * `prompt-suggestions.test.ts`); the GitHub-side tests use mocked `fetch`
 * (matches `pr-choreography.test.ts`). No live GitHub. No live Anthropic
 * — the B.4 evaluator's output is fixture-built, never invoked.
 *
 * Test-name prefix `B.8:` for grep-friendly filtering against the wider
 * suite's other prefixes (`A.7:`, etc.).
 */

import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { generateKeyPairSync } from 'node:crypto';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../app.js';
import {
  generatePullRequest,
  ChoreographyError,
  type ChoreographyOptions,
  type ContractTestResult,
  type PromptSuggestionForChoreography,
} from '@cpa/integrations/github-app';
import type { PromptSuggestionEvaluation } from '@cpa/agents';
import {
  PROMPT_SUGGESTION_SOURCE_KINDS,
  PROMPT_SUGGESTION_STATUSES,
  PROMPT_SUGGESTION_TRIAGE_CLASSIFICATIONS,
  PROMPT_SUGGESTION_REVIEW_DISPOSITIONS,
} from '@cpa/db/schema';
import { _internals } from './prompt-suggestions.js';

// =============================================================================
// Fixtures + harness — UUID prefix `b800` keeps fixtures disjoint from other
// contract test files' tenants (multi-cycle.contract.test.ts uses `a700`,
// prompt-suggestions.test.ts uses `b300`, webhooks/github.test.ts uses
// `b610`). Webhook secret is set in `before()` so the route's HMAC verify
// path matches the signature we compute below.
// =============================================================================

const TENANT_A = '00000000-0000-4000-8000-0000000b8001';
const ADMIN_USER = '00000000-0000-4000-8000-0000000b8010';

const HMAC_SECRET = 'b8-contract-webhook-secret-fixture';

let dbAvailable = false;

const cleanup = async (): Promise<void> => {
  try {
    await privilegedSql`DELETE FROM prompt_suggestion_pr WHERE tenant_id = ${TENANT_A}`;
    await privilegedSql`DELETE FROM prompt_suggestion_review WHERE tenant_id = ${TENANT_A}`;
    await privilegedSql`DELETE FROM prompt_suggestion WHERE tenant_id = ${TENANT_A}`;
    await privilegedSql`DELETE FROM tenant_user WHERE tenant_id = ${TENANT_A}`;
    await sql`DELETE FROM "user" WHERE id = ${ADMIN_USER}`;
    await sql`DELETE FROM tenant WHERE id = ${TENANT_A}`;
  } catch {
    // ignore — DB unreachable, cleanup is a no-op.
  }
};

before(async () => {
  process.env['GITHUB_WEBHOOK_SECRET'] = HMAC_SECRET;
  try {
    await privilegedSql`SELECT 1`;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    return;
  }
  await cleanup();
  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT_A}, 'Firm B8 Contract', 'firm-b8-contract', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${ADMIN_USER}, 'b8-admin@example.com', 'microsoft',
                    'microsoft:b8-admin', 'B.8 Admin')`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT_A}, ${ADMIN_USER}, 'admin', true)`;
});

after(async () => {
  if (dbAvailable) await cleanup();
  try {
    await sql.end();
    await privilegedSql.end();
  } catch {
    // ignore
  }
});

const skipIfNoDb = (t: { skip: (msg?: string) => void }): boolean => {
  if (!dbAvailable) {
    t.skip('Postgres not reachable — DB-gated test skipped');
    return true;
  }
  return false;
};

// =============================================================================
// Mock-fetch harness — mirrors pr-choreography.test.ts's pattern verbatim.
// Each scripted action matches by URL substring (and optional method); the
// mock fails loudly on an unmatched call so a regression that adds a stage
// without updating the fixture surfaces immediately.
// =============================================================================

interface ScriptedAction {
  match: string;
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  ok?: boolean;
  status?: number;
  statusText?: string;
  body?: unknown;
}

interface CapturedCall {
  url: string;
  method: string;
  body: unknown;
}

function makeFetchMock(actions: ScriptedAction[]): {
  fetch: typeof globalThis.fetch;
  calls: CapturedCall[];
} {
  const remaining = [...actions];
  const calls: CapturedCall[] = [];
  const fetchImpl = mock.fn((url: unknown, init: unknown) => {
    const u = String(url);
    const m = (init as { method?: string } | undefined)?.method ?? 'GET';
    let parsedBody: unknown;
    const rawBody = (init as { body?: string } | undefined)?.body;
    if (typeof rawBody === 'string') {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        parsedBody = rawBody;
      }
    }
    calls.push({ url: u, method: m, body: parsedBody });

    const idx = remaining.findIndex(
      (a) => u.includes(a.match) && (a.method === undefined || a.method === m),
    );
    if (idx === -1) {
      throw new Error(`fetch-mock: unmatched ${m} ${u}`);
    }
    const action = remaining.splice(idx, 1)[0]!;
    const ok = action.ok ?? true;
    const status = action.status ?? 200;
    const statusText = action.statusText ?? 'OK';
    return Promise.resolve({
      ok,
      status,
      statusText,
      json: () => Promise.resolve(action.body ?? {}),
      text: () =>
        Promise.resolve(
          typeof action.body === 'string' ? action.body : JSON.stringify(action.body ?? ''),
        ),
    } as unknown as Response);
  });
  return { fetch: fetchImpl, calls };
}

// Module-level keypair fixture — see installation-token.test.ts /
// pr-choreography.test.ts. Reused across tests so we pay the keygen cost
// once.
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { format: 'pem', type: 'spki' },
  privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
});

const SUGGESTION_ID = 'b8000000-0000-4000-8000-000000000001';

function makeSuggestionForChoreography(): PromptSuggestionForChoreography {
  return {
    id: SUGGESTION_ID,
    tenant_id: TENANT_A,
    flagged_by_user_id: ADMIN_USER,
    source_kind: 'consultant_flag',
    affected_prompt_module: 'classifier-expenditure@1.0.0',
    affected_section_kind: null,
    issue_summary: 'B.8 contract test fixture: model conflates core vs supporting expenditure.',
  };
}

function makeEvaluation(): PromptSuggestionEvaluation {
  return {
    suggestion_id: SUGGESTION_ID,
    classification: 'prompt_change',
    files: [
      {
        path: 'packages/agents/src/classifier-expenditure/prompts/classify-expenditure@1.0.0.ts',
        change_kind: 'modify',
        rationale: 'Tighten the decision tree for the borderline edge case per consultant flag.',
        diff_preview: '@@ -1,1 +1,1 @@\n-old\n+new\n',
        newContent: 'export const SYSTEM_PROMPT = "tightened";\n',
      },
    ],
    cross_file_consistency_checks_run: ['verified all callers of classify-expenditure compile'],
    rationale_summary:
      'Consultant flagged that classify-expenditure conflates core vs supporting on edge cases; tightened the decision tree to disambiguate.',
    prompt_version: '1.0.0',
    model: 'claude-opus-4-7',
  };
}

function happyPathScript(): ScriptedAction[] {
  return [
    {
      match: '/app/installations/',
      method: 'POST',
      body: {
        token: 'tok_test',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    },
    {
      match: '/git/ref/heads/main',
      method: 'GET',
      body: { ref: 'refs/heads/main', object: { sha: 'mainsha', type: 'commit' } },
    },
    {
      match: '/git/commits/mainsha',
      method: 'GET',
      body: { sha: 'mainsha', tree: { sha: 'maintreesha' } },
    },
    { match: '/git/refs', method: 'POST', body: {} },
    { match: '/git/trees', method: 'POST', body: { sha: 'newtreesha' } },
    { match: '/git/commits', method: 'POST', body: { sha: 'newcommitsha' } },
    { match: '/git/refs/heads/', method: 'PATCH', body: {} },
    {
      match: '/pulls',
      method: 'POST',
      body: { number: 880042, html_url: 'https://github.com/aaron/cpa-platform/pull/880042' },
    },
  ];
}

// The installation-token module caches tokens by installationId for the
// duration of the cached `expires_at`. Two contract tests in this file
// each script an auth fetch; if both used `installationId: 'inst-1'`,
// the second test's cached token would short-circuit the auth call and
// the scripted auth action would go unconsumed (and the `calls[]` index
// assertions would shift). Each call site below picks a distinct
// installationId derived from the test's purpose so the cache stays
// disjoint without needing access to the (private) `_clearTokenCache`
// helper.
function baseChoreographyOpts(
  fetchImpl: typeof globalThis.fetch,
  overrides: Partial<ChoreographyOptions> = {},
): ChoreographyOptions {
  return {
    appId: '111',
    privateKey,
    installationId: 'inst-b8-default',
    owner: 'aaron',
    repo: 'cpa-platform',
    suggestion: makeSuggestionForChoreography(),
    evaluation: makeEvaluation(),
    reviewerUserId: ADMIN_USER,
    fetch: fetchImpl,
    ...overrides,
  };
}

// =============================================================================
// Test 1 — Module-wiring contract: B.4 evaluator output composes cleanly into
//          B.5 choreography input.
//
// `PromptSuggestionEvaluation` (the parsed B.4 tool-use envelope) is the
// *exact* shape `ChoreographyOptions.evaluation` expects. There is NO
// translation layer between these modules — the API handler in
// `prompt-suggestions.ts` literally passes the evaluation through without
// reshaping. This contract pins that invariant: if a future B.4 schema
// rename (e.g. `files[]` → `file_changes[]`) lands without an aligned B.5
// update, the typecheck would catch it at build time and this assertion
// catches it at test time on the parsed payload's structural fields.
// =============================================================================

test('B.8: B.4 PromptSuggestionEvaluation composes into B.5 ChoreographyOptions without translation', () => {
  const evaluation = makeEvaluation();
  const suggestion = makeSuggestionForChoreography();

  // Compose into ChoreographyOptions. If the field names drift between the
  // two modules' types, this assignment fails to typecheck.
  const opts: ChoreographyOptions = {
    appId: 'noop',
    privateKey: 'noop',
    installationId: 'noop',
    owner: 'aaron',
    repo: 'cpa-platform',
    suggestion,
    evaluation,
    reviewerUserId: ADMIN_USER,
    // No fetch — we never invoke generatePullRequest in this test.
  };

  // Structural sanity. These fields are the load-bearing ones the
  // choreography reads; the contract is they exist on B.4's output.
  assert.equal(opts.evaluation.suggestion_id, SUGGESTION_ID);
  assert.equal(opts.evaluation.classification, 'prompt_change');
  assert.equal(opts.evaluation.files.length, 1);
  const file = opts.evaluation.files[0]!;
  // The `change_kind` discriminant the choreography switches on:
  assert.ok(['create', 'modify', 'delete'].includes(file.change_kind));
  // The `newContent` field the choreography hands to GitHub's tree API:
  assert.equal(typeof file.newContent, 'string');
  // `path`, `rationale`, `diff_preview` round-trip:
  assert.equal(typeof file.path, 'string');
  assert.equal(typeof file.rationale, 'string');
  assert.equal(typeof file.diff_preview, 'string');
});

// =============================================================================
// Test 2 — B.5 choreography happy path: createRef → createTree →
//          createCommit → updateRef → createPR (with the auth + getRef +
//          getCommit prelude that all real choreography calls do).
// =============================================================================

test('B.8: B.5 choreography — mocked happy path runs createRef → createTree → createCommit → updateRef → createPR', async () => {
  const harness = makeFetchMock(happyPathScript());
  const result = await generatePullRequest(
    baseChoreographyOpts(harness.fetch, { installationId: 'inst-b8-happy' }),
  );

  // Result shape sanity (exhaustive happy-path coverage lives in
  // pr-choreography.test.ts; here we only pin the contract surface).
  assert.equal(result.pr_number, 880042);
  assert.match(result.branch_name, /^prompt-suggestion\//);
  assert.equal(result.commit_sha, 'newcommitsha');

  // 8 calls total: 1 auth + 7 choreography stages. Order matters — the
  // choreography MUST hit GitHub's API in this exact sequence or the
  // atomic-or-rollback semantics break.
  assert.equal(harness.calls.length, 8);
  // Auth (installation token exchange)
  assert.match(harness.calls[0]!.url, /\/app\/installations\//);
  // getMainRef
  assert.equal(harness.calls[1]!.method, 'GET');
  assert.match(harness.calls[1]!.url, /\/git\/ref\/heads\/main$/);
  // getMainCommit (peel ref → tree.sha)
  assert.equal(harness.calls[2]!.method, 'GET');
  assert.match(harness.calls[2]!.url, /\/git\/commits\/mainsha$/);
  // createRef (the rollback-protected branch)
  assert.equal(harness.calls[3]!.method, 'POST');
  assert.match(harness.calls[3]!.url, /\/git\/refs$/);
  // createTree
  assert.equal(harness.calls[4]!.method, 'POST');
  assert.match(harness.calls[4]!.url, /\/git\/trees$/);
  // createCommit
  assert.equal(harness.calls[5]!.method, 'POST');
  assert.match(harness.calls[5]!.url, /\/git\/commits$/);
  // updateRef (fast-forward branch to commit.sha)
  assert.equal(harness.calls[6]!.method, 'PATCH');
  assert.match(harness.calls[6]!.url, /\/git\/refs\/heads\/prompt-suggestion%2F/);
  // createPR
  assert.equal(harness.calls[7]!.method, 'POST');
  assert.match(harness.calls[7]!.url, /\/pulls$/);

  // Crucially: NO DELETE call in the happy path. The branch survives.
  assert.equal(harness.calls.filter((c) => c.method === 'DELETE').length, 0);
});

// =============================================================================
// Test 3 — B.5 choreography rollback contract: contract-test failure
//          (subprocess exitCode !== 0) must trigger branch DELETE and
//          MUST NOT call POST /pulls.
// =============================================================================

test('B.8: B.5 choreography — contract-test failure triggers branch DELETE and skips createPR', async () => {
  // Same prelude as happy path through updateRef, then a DELETE response
  // for the rollback. NO scripted /pulls action — if the choreography
  // tries to call createPR despite the contract-test failure, the mock
  // throws and the test fails loudly.
  const harness = makeFetchMock([
    {
      match: '/app/installations/',
      method: 'POST',
      body: {
        token: 'tok_test',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    },
    {
      match: '/git/ref/heads/main',
      method: 'GET',
      body: { ref: 'refs/heads/main', object: { sha: 'mainsha', type: 'commit' } },
    },
    {
      match: '/git/commits/mainsha',
      method: 'GET',
      body: { sha: 'mainsha', tree: { sha: 'maintreesha' } },
    },
    { match: '/git/refs', method: 'POST', body: {} },
    { match: '/git/trees', method: 'POST', body: { sha: 'newtreesha' } },
    { match: '/git/commits', method: 'POST', body: { sha: 'newcommitsha' } },
    { match: '/git/refs/heads/', method: 'PATCH', body: {} },
    // The rollback DELETE — the only path-method-pair the choreography
    // is allowed to invoke after the contract-test fails.
    { match: '/git/refs/heads/', method: 'DELETE', body: '', status: 204 },
  ]);
  const runContractTest = mock.fn(
    (): Promise<ContractTestResult> =>
      Promise.resolve({
        exitCode: 1,
        stdout: 'B.8 contract test simulated failure',
        stderr: 'AssertionError: simulated',
      }),
  );

  await assert.rejects(
    () =>
      generatePullRequest(
        baseChoreographyOpts(harness.fetch, {
          runContractTest,
          installationId: 'inst-b8-rollback',
        }),
      ),
    (err: unknown) => {
      assert.ok(err instanceof ChoreographyError);
      assert.equal(err.stage, 'contract_test');
      return true;
    },
  );

  // Branch was deleted (rollback semantics).
  const deletes = harness.calls.filter((c) => c.method === 'DELETE');
  assert.equal(deletes.length, 1, 'rollback must DELETE the branch ref exactly once');
  assert.match(deletes[0]!.url, /\/git\/refs\/heads\/prompt-suggestion%2F/);

  // PR was NOT opened.
  const pulls = harness.calls.filter((c) => c.url.includes('/pulls'));
  assert.equal(pulls.length, 0, 'createPR must not be invoked after contract-test failure');
});

// =============================================================================
// Test 4 — B.5 + B.6 round trip: choreography lands a `pr_drafted` row;
//          the webhook handler then flips it to `pr_merged`. Asserted at
//          the API surface (HTTP injection through buildApp), not by
//          calling _internals helpers — the contract is the externally
//          visible behaviour.
// =============================================================================

test('B.8: B.5 + B.6 round trip — pr_drafted row → pull_request.merged webhook → pr_merged', async (t) => {
  if (skipIfNoDb(t)) return;

  // Stand-in for the choreography: directly seed a `pr_drafted` parent +
  // a `prompt_suggestion_pr` row, mirroring what the API handler does
  // after `generatePullRequest()` returns. This isolates the B.6 webhook
  // contract: given a row in this state, GitHub's `pull_request.merged`
  // delivery flips it to `pr_merged`.
  const suggestionId = crypto.randomUUID();
  const prId = crypto.randomUUID();
  const prNumber = 8800100;

  await privilegedSql`
    INSERT INTO prompt_suggestion (
      tenant_id, id, flagged_by_user_id, source_kind, source_payload,
      issue_summary, status, triage_classification
    ) VALUES (
      ${TENANT_A}, ${suggestionId}, ${ADMIN_USER}, 'consultant_flag',
      ${'{}'}::jsonb,
      'B.8 round-trip suggestion seed', 'pr_drafted',
      'prompt_change'
    )
  `;
  await privilegedSql`
    INSERT INTO prompt_suggestion_pr (
      tenant_id, id, suggestion_id, github_pr_number, github_pr_url,
      branch_name, changed_files
    ) VALUES (
      ${TENANT_A}, ${prId}, ${suggestionId},
      ${prNumber}, ${'https://github.com/cpa/repo/pull/' + prNumber},
      ${'prompt-suggestion/' + suggestionId.slice(0, 8)},
      ${'[]'}::jsonb
    )
  `;

  const body = JSON.stringify({
    action: 'closed',
    pull_request: {
      number: prNumber,
      merged: true,
      merged_at: '2026-05-04T13:30:00Z',
      merge_commit_sha: 'b8roundtripsha',
      state: 'closed',
      html_url: `https://github.com/cpa/repo/pull/${prNumber}`,
    },
    repository: { full_name: 'cpa/repo' },
    installation: { id: 12345 },
  });
  const sig = 'sha256=' + crypto.createHmac('sha256', HMAC_SECRET).update(body).digest('hex');

  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/github',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'pull_request',
      'x-hub-signature-256': sig,
    },
    payload: body,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json<{ action: string }>().action, 'merged');

  // Parent suggestion flipped to pr_merged + resolved_at populated.
  const sugAfter = await privilegedSql<{ status: string; resolved_at: Date | null }[]>`
    SELECT status, resolved_at FROM prompt_suggestion WHERE id = ${suggestionId}
  `;
  assert.equal(sugAfter[0]?.status, 'pr_merged');
  assert.ok(sugAfter[0]?.resolved_at, 'resolved_at must be populated after merge');

  // Child PR row got merged_at + merge_commit_sha.
  const prAfter = await privilegedSql<
    { merged_at: Date | null; merge_commit_sha: string | null }[]
  >`
    SELECT merged_at, merge_commit_sha FROM prompt_suggestion_pr WHERE id = ${prId}
  `;
  assert.ok(prAfter[0]?.merged_at);
  assert.equal(prAfter[0]?.merge_commit_sha, 'b8roundtripsha');

  await app.close();
});

// =============================================================================
// Test 5 — B.6 webhook idempotency: the SAME payload delivered twice
//          flips the row exactly once. Second delivery returns
//          `action: 'already-merged'` AND parent's `resolved_at` is
//          unchanged (proving no second UPDATE ran).
// =============================================================================

test('B.8: B.6 webhook redelivery — idempotent, second pull_request.merged returns already-merged', async (t) => {
  if (skipIfNoDb(t)) return;

  const suggestionId = crypto.randomUUID();
  const prId = crypto.randomUUID();
  const prNumber = 8800200;

  await privilegedSql`
    INSERT INTO prompt_suggestion (
      tenant_id, id, flagged_by_user_id, source_kind, source_payload,
      issue_summary, status, triage_classification
    ) VALUES (
      ${TENANT_A}, ${suggestionId}, ${ADMIN_USER}, 'consultant_flag',
      ${'{}'}::jsonb,
      'B.8 idempotency suggestion seed', 'pr_drafted',
      'prompt_change'
    )
  `;
  await privilegedSql`
    INSERT INTO prompt_suggestion_pr (
      tenant_id, id, suggestion_id, github_pr_number, github_pr_url,
      branch_name, changed_files
    ) VALUES (
      ${TENANT_A}, ${prId}, ${suggestionId},
      ${prNumber}, ${'https://github.com/cpa/repo/pull/' + prNumber},
      ${'prompt-suggestion/' + suggestionId.slice(0, 8)},
      ${'[]'}::jsonb
    )
  `;

  const body = JSON.stringify({
    action: 'closed',
    pull_request: {
      number: prNumber,
      merged: true,
      merged_at: '2026-05-04T14:00:00Z',
      merge_commit_sha: 'b8idempsha',
      state: 'closed',
      html_url: `https://github.com/cpa/repo/pull/${prNumber}`,
    },
    repository: { full_name: 'cpa/repo' },
    installation: { id: 12345 },
  });
  const sig = 'sha256=' + crypto.createHmac('sha256', HMAC_SECRET).update(body).digest('hex');
  const headers = {
    'content-type': 'application/json',
    'x-github-event': 'pull_request',
    'x-hub-signature-256': sig,
  };

  const app = buildApp();

  // First delivery — flips to pr_merged.
  const first = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/github',
    headers,
    payload: body,
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json<{ action: string }>().action, 'merged');

  const sugAfterFirst = await privilegedSql<{ resolved_at: Date | null }[]>`
    SELECT resolved_at FROM prompt_suggestion WHERE id = ${suggestionId}
  `;
  const firstResolvedAt = sugAfterFirst[0]?.resolved_at;
  assert.ok(firstResolvedAt);

  // Second delivery — IDENTICAL payload + signature. MUST NOT double-update.
  const second = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/github',
    headers,
    payload: body,
  });
  assert.equal(second.statusCode, 200);
  assert.equal(
    second.json<{ action: string }>().action,
    'already-merged',
    'second delivery of the same payload must short-circuit with already-merged',
  );

  // resolved_at unchanged across the redelivery — confirms no second UPDATE.
  const sugAfterSecond = await privilegedSql<{ resolved_at: Date | null }[]>`
    SELECT resolved_at FROM prompt_suggestion WHERE id = ${suggestionId}
  `;
  const secondResolvedAt = sugAfterSecond[0]?.resolved_at;
  assert.ok(secondResolvedAt);
  // Compare ms-since-epoch (postgres-js returns Date; either side may be a
  // string in some environments, so normalise via Number(new Date(x))).
  assert.equal(
    Number(new Date(firstResolvedAt as Date | string)),
    Number(new Date(secondResolvedAt as Date | string)),
    'resolved_at must be byte-stable across redelivery (no second UPDATE issued)',
  );

  await app.close();
});

// =============================================================================
// Test 6 — B.6 webhook anomaly: a delivery for a `github_pr_number` not
//          present in the DB MUST 200 with `action: 'unknown-pr'` (NOT
//          404 — 404 makes GitHub retry indefinitely).
// =============================================================================

test('B.8: B.6 webhook — unknown github_pr_number returns 200 with action=unknown-pr', async (t) => {
  if (skipIfNoDb(t)) return;

  // A PR number no test seeds. The choreography never opened a row for
  // it, so the webhook receiver's privileged lookup misses; the contract
  // is "200 + unknown-pr" (so GitHub stops retrying), not 404.
  const prNumber = 8800999;
  const body = JSON.stringify({
    action: 'closed',
    pull_request: {
      number: prNumber,
      merged: true,
      merged_at: '2026-05-04T15:00:00Z',
      merge_commit_sha: 'unused',
      state: 'closed',
      html_url: `https://github.com/cpa/repo/pull/${prNumber}`,
    },
    repository: { full_name: 'cpa/repo' },
    installation: { id: 12345 },
  });
  const sig = 'sha256=' + crypto.createHmac('sha256', HMAC_SECRET).update(body).digest('hex');

  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/github',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'pull_request',
      'x-hub-signature-256': sig,
    },
    payload: body,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json<{ action: string }>().action, 'unknown-pr');
  await app.close();
});

// =============================================================================
// Three-way parity tests. Each compares THREE sources of truth for one
// enum:
//   1. SQL CHECK constraint values from migration 0038 (regex-extract via
//      pg_get_constraintdef in pg_catalog).
//   2. `@cpa/db` const array (the drizzle schema's source of truth).
//   3. Inline Zod enum from `apps/api/src/routes/prompt-suggestions.ts`,
//      exposed via `_internals` (the API-layer source of truth — Theme B
//      did NOT promote these to `@cpa/schemas` per B.3's "inline Zod"
//      pattern; the contract is therefore inline-Zod ↔ db-const ↔
//      SQL CHECK).
//
// Comparison is set-equality on the sorted arrays, ratcheting both
// directions: "every db value is in the SQL CHECK and the Zod enum" AND
// "every SQL CHECK value is in the db const and the Zod enum". This
// catches drift in either direction (a stray Zod literal that was never
// added to SQL is a defect; a stray SQL literal that was never added to
// the Zod enum is also a defect).
//
// All four tests are DB-gated (the SQL CHECK leg requires Postgres);
// without DB they skip cleanly. The Zod ↔ db-const half remains green
// either way (covered transitively by the migration sketch test +
// runtime imports).
// =============================================================================

const extractCheckValues = (constraintDef: string): string[] =>
  (constraintDef.match(/'([a-z_]+)'/g) ?? []).map((s) => s.slice(1, -1));

test('B.8: three-way parity — source_kind (SQL CHECK ↔ db const ↔ inline Zod)', async (t) => {
  if (skipIfNoDb(t)) return;

  const constraintRow = await privilegedSql<{ pg_get_constraintdef: string }[]>`
    SELECT pg_get_constraintdef(oid) AS pg_get_constraintdef
      FROM pg_constraint
     WHERE conname = 'prompt_suggestion_source_kind_valid'
       AND conrelid = 'prompt_suggestion'::regclass
  `;
  assert.equal(constraintRow.length, 1, 'source_kind CHECK constraint must exist');
  const sqlValues = extractCheckValues(constraintRow[0]!.pg_get_constraintdef);

  const dbConst = [...PROMPT_SUGGESTION_SOURCE_KINDS].sort();
  // Read the Zod enum's values via the parsed schema's _def. Zod v3
  // surfaces enum values at `_def.values` for `z.enum([...])`. We extract
  // them from the route's _internals.SOURCE_KINDS (the const array
  // backing the Zod enum) — matching the inline-Zod pattern in
  // prompt-suggestions.ts where the const drives the enum.
  const zodValues = [..._internals.SOURCE_KINDS].sort();
  const sqlSorted = [...sqlValues].sort();

  assert.deepEqual(dbConst, zodValues, 'db const ↔ inline Zod mismatch (source_kind)');
  assert.deepEqual(dbConst, sqlSorted, 'db const ↔ SQL CHECK mismatch (source_kind)');
  assert.deepEqual(zodValues, sqlSorted, 'inline Zod ↔ SQL CHECK mismatch (source_kind)');
});

test('B.8: three-way parity — status (SQL CHECK ↔ db const ↔ inline Zod)', async (t) => {
  if (skipIfNoDb(t)) return;

  const constraintRow = await privilegedSql<{ pg_get_constraintdef: string }[]>`
    SELECT pg_get_constraintdef(oid) AS pg_get_constraintdef
      FROM pg_constraint
     WHERE conname = 'prompt_suggestion_status_valid'
       AND conrelid = 'prompt_suggestion'::regclass
  `;
  assert.equal(constraintRow.length, 1, 'status CHECK constraint must exist');
  const sqlValues = extractCheckValues(constraintRow[0]!.pg_get_constraintdef);

  const dbConst = [...PROMPT_SUGGESTION_STATUSES].sort();
  const zodValues = [..._internals.STATUSES].sort();
  const sqlSorted = [...sqlValues].sort();

  assert.deepEqual(dbConst, zodValues, 'db const ↔ inline Zod mismatch (status)');
  assert.deepEqual(dbConst, sqlSorted, 'db const ↔ SQL CHECK mismatch (status)');
  assert.deepEqual(zodValues, sqlSorted, 'inline Zod ↔ SQL CHECK mismatch (status)');
});

test('B.8: three-way parity — triage_classification (SQL CHECK ↔ db const ↔ inline Zod)', async (t) => {
  if (skipIfNoDb(t)) return;

  const constraintRow = await privilegedSql<{ pg_get_constraintdef: string }[]>`
    SELECT pg_get_constraintdef(oid) AS pg_get_constraintdef
      FROM pg_constraint
     WHERE conname = 'prompt_suggestion_triage_classification_valid'
       AND conrelid = 'prompt_suggestion'::regclass
  `;
  assert.equal(constraintRow.length, 1, 'triage_classification CHECK constraint must exist');
  const sqlValues = extractCheckValues(constraintRow[0]!.pg_get_constraintdef);

  const dbConst = [...PROMPT_SUGGESTION_TRIAGE_CLASSIFICATIONS].sort();
  const zodValues = [..._internals.TRIAGE_CLASSIFICATIONS].sort();
  const sqlSorted = [...sqlValues].sort();

  assert.deepEqual(dbConst, zodValues, 'db const ↔ inline Zod mismatch (triage_classification)');
  assert.deepEqual(dbConst, sqlSorted, 'db const ↔ SQL CHECK mismatch (triage_classification)');
  assert.deepEqual(zodValues, sqlSorted, 'inline Zod ↔ SQL CHECK mismatch (triage_classification)');
});

test('B.8: three-way parity — disposition (SQL CHECK ↔ db const ↔ inline Zod)', async (t) => {
  if (skipIfNoDb(t)) return;

  const constraintRow = await privilegedSql<{ pg_get_constraintdef: string }[]>`
    SELECT pg_get_constraintdef(oid) AS pg_get_constraintdef
      FROM pg_constraint
     WHERE conname = 'prompt_suggestion_review_disposition_valid'
       AND conrelid = 'prompt_suggestion_review'::regclass
  `;
  assert.equal(constraintRow.length, 1, 'disposition CHECK constraint must exist');
  const sqlValues = extractCheckValues(constraintRow[0]!.pg_get_constraintdef);

  const dbConst = [...PROMPT_SUGGESTION_REVIEW_DISPOSITIONS].sort();
  const zodValues = [..._internals.REVIEW_DISPOSITIONS].sort();
  const sqlSorted = [...sqlValues].sort();

  assert.deepEqual(dbConst, zodValues, 'db const ↔ inline Zod mismatch (disposition)');
  assert.deepEqual(dbConst, sqlSorted, 'db const ↔ SQL CHECK mismatch (disposition)');
  assert.deepEqual(zodValues, sqlSorted, 'inline Zod ↔ SQL CHECK mismatch (disposition)');
});
