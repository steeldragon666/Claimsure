import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  generatePullRequest,
  renderSuggestionPrBody,
  branchNameFor,
  ChoreographyError,
  _internals,
  type ChoreographyOptions,
  type ContractTestResult,
  type PromptSuggestionForChoreography,
} from './pr-choreography.js';
import type { PromptSuggestionEvaluation } from '@cpa/agents';
import { _clearTokenCache } from './installation-token.js';

/**
 * P7 Theme B Task B.5 — PR choreography unit tests.
 *
 * All tests use a mocked `fetch` that records the URL/method/body of
 * each call and returns a scripted Response. We DO NOT call the real
 * GitHub API; the spec says "no real GitHub API calls in tests; pure
 * mocked-fetch unit tests".
 *
 * The fixture pattern: each test seeds an `Action[]` array (the
 * scripted responses, in order), and a `MockFetch` instance dispatches
 * by URL+method to find the matching response. Unmatched requests
 * fail the test loudly so we catch a regression that adds a stage
 * without updating the fixture.
 */

// Module-level keypair fixture — see jwt.test.ts. Reused across tests
// so we pay the keygen cost once.
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { format: 'pem', type: 'spki' },
  privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
});

// ---------------------------------------------------------------------------
// Mock-fetch harness
// ---------------------------------------------------------------------------

interface ScriptedAction {
  /** URL substring to match (covers all our endpoints). */
  match: string;
  /** Optional: HTTP method to also match on. */
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
  remaining: () => ScriptedAction[];
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

    // Find the first matching scripted action
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
  return {
    fetch: fetchImpl,
    calls,
    remaining: () => remaining,
  };
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const SUGGESTION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeffff';

function makeSuggestion(): PromptSuggestionForChoreography {
  return {
    id: SUGGESTION_ID,
    tenant_id: '00000000-0000-4000-8000-000000000001',
    flagged_by_user_id: '00000000-0000-4000-8000-000000000010',
    source_kind: 'consultant_flag',
    affected_prompt_module: 'classify-expenditure@1.0.0',
    affected_section_kind: null,
    issue_summary: 'Model conflates core vs supporting on edge cases',
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
        rationale:
          'Tighten the decision tree for borderline supporting expenditure cases per consultant flag.',
        diff_preview: '@@ -1,3 +1,3 @@\n-old\n+new\n',
        newContent: 'export const SYSTEM_PROMPT = "tightened prompt";\n',
      },
      {
        path: 'packages/agents/src/classifier-expenditure/prompts/classify-expenditure@1.0.0.test.ts',
        change_kind: 'create',
        rationale:
          'Add a regression test pinning the new decision-tree output for the consultant-flagged case.',
        diff_preview: '+ new file',
        newContent: 'import { test } from "node:test"; test("regression", () => {});\n',
      },
    ],
    cross_file_consistency_checks_run: [
      'verified all callers of classify-expenditure compile',
      'ran classify-expenditure tests via subprocess',
    ],
    rationale_summary:
      'Consultant flagged that the model conflates core vs supporting expenditure on edge cases; the prompt decision tree needed tightening and a regression test was added to pin the new behaviour.',
    prompt_version: '1.0.0',
    model: 'claude-opus-4-7',
  };
}

function happyPathScript(): ScriptedAction[] {
  return [
    // Stage 1: auth — installation token exchange
    {
      match: '/app/installations/',
      method: 'POST',
      body: {
        token: 'tok_test',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    },
    // Stage 2: get main ref
    {
      match: '/git/ref/heads/main',
      method: 'GET',
      body: { ref: 'refs/heads/main', object: { sha: 'mainsha123', type: 'commit' } },
    },
    // Stage 2: get main commit (for tree.sha)
    {
      match: '/git/commits/mainsha123',
      method: 'GET',
      body: { sha: 'mainsha123', tree: { sha: 'maintreesha456' } },
    },
    // Stage 3: create branch ref
    { match: '/git/refs', method: 'POST', body: {} },
    // Stage 4: create tree
    { match: '/git/trees', method: 'POST', body: { sha: 'newtreesha789' } },
    // Stage 5: create commit
    { match: '/git/commits', method: 'POST', body: { sha: 'newcommitsha012' } },
    // Stage 6: update branch ref
    { match: '/git/refs/heads/', method: 'PATCH', body: {} },
    // Stage 8: open PR
    {
      match: '/pulls',
      method: 'POST',
      body: { number: 42, html_url: 'https://github.com/aaron/cpa-platform/pull/42' },
    },
  ];
}

function baseOpts(
  fetchImpl: typeof globalThis.fetch,
  overrides: Partial<ChoreographyOptions> = {},
): ChoreographyOptions {
  return {
    appId: '111',
    privateKey,
    installationId: 'inst-1',
    owner: 'aaron',
    repo: 'cpa-platform',
    suggestion: makeSuggestion(),
    evaluation: makeEvaluation(),
    reviewerUserId: '00000000-0000-4000-8000-000000000020',
    fetch: fetchImpl,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Happy-path tests
// ---------------------------------------------------------------------------

test('generatePullRequest: happy path runs auth → branch → tree → commit → ref → PR', async () => {
  _clearTokenCache();
  const harness = makeFetchMock(happyPathScript());
  const result = await generatePullRequest(baseOpts(harness.fetch));

  assert.equal(result.pr_number, 42);
  assert.equal(result.pr_url, 'https://github.com/aaron/cpa-platform/pull/42');
  assert.equal(result.branch_name, `prompt-suggestion/${SUGGESTION_ID.slice(0, 8)}`);
  assert.equal(result.commit_sha, 'newcommitsha012');
  assert.equal(result.changed_files.length, 2);
  assert.equal(result.changed_files[0]?.change_kind, 'modify');
  assert.equal(result.changed_files[1]?.change_kind, 'create');

  // All scripted actions consumed.
  assert.equal(harness.remaining().length, 0);
});

test('generatePullRequest: emits expected sequence of GitHub calls', async () => {
  _clearTokenCache();
  const harness = makeFetchMock(happyPathScript());
  await generatePullRequest(baseOpts(harness.fetch));

  // 8 calls total: 1 auth + 7 choreography stages
  assert.equal(harness.calls.length, 8);
  // Auth + getMainRef + getMainCommit + createRef + createTree + createCommit + updateRef + createPR
  assert.match(harness.calls[0]!.url, /\/app\/installations\//);
  assert.equal(harness.calls[1]!.method, 'GET');
  assert.match(harness.calls[1]!.url, /\/git\/ref\/heads\/main$/);
  assert.equal(harness.calls[2]!.method, 'GET');
  assert.match(harness.calls[2]!.url, /\/git\/commits\/mainsha123$/);
  assert.equal(harness.calls[3]!.method, 'POST');
  assert.match(harness.calls[3]!.url, /\/git\/refs$/);
  assert.equal(harness.calls[4]!.method, 'POST');
  assert.match(harness.calls[4]!.url, /\/git\/trees$/);
  assert.equal(harness.calls[5]!.method, 'POST');
  assert.match(harness.calls[5]!.url, /\/git\/commits$/);
  assert.equal(harness.calls[6]!.method, 'PATCH');
  assert.match(harness.calls[6]!.url, /\/git\/refs\/heads\/prompt-suggestion%2F/);
  assert.equal(harness.calls[7]!.method, 'POST');
  assert.match(harness.calls[7]!.url, /\/pulls$/);
});

test('generatePullRequest: tree-entries include base_tree + delete maps to sha:null', async () => {
  _clearTokenCache();
  const evalWithDelete: PromptSuggestionEvaluation = {
    ...makeEvaluation(),
    files: [
      {
        path: 'packages/agents/src/legacy/old-prompt@0.9.0.ts',
        change_kind: 'delete',
        rationale: 'Retire the legacy prompt module that has been replaced by 1.0.0.',
        diff_preview: '- file removed',
        newContent: '',
      },
    ],
  };

  const harness = makeFetchMock(happyPathScript());
  await generatePullRequest(baseOpts(harness.fetch, { evaluation: evalWithDelete }));
  // createTree call — index 4 in the call list (0=auth, 1=getRef, 2=getCommit, 3=createRef, 4=createTree)
  const treeCall = harness.calls[4]!;
  const body = treeCall.body as { base_tree: string; tree: Array<Record<string, unknown>> };
  assert.equal(body.base_tree, 'maintreesha456');
  assert.equal(body.tree.length, 1);
  assert.equal(body.tree[0]?.['path'], 'packages/agents/src/legacy/old-prompt@0.9.0.ts');
  assert.equal(body.tree[0]?.['sha'], null);
  assert.equal(body.tree[0]?.['mode'], '100644');
  assert.equal(body.tree[0]?.['type'], 'blob');
});

test('generatePullRequest: bot author + committer use default email', async () => {
  _clearTokenCache();
  delete process.env['GITHUB_BOT_EMAIL'];
  const harness = makeFetchMock(happyPathScript());
  await generatePullRequest(baseOpts(harness.fetch));
  const commitCall = harness.calls[5]!;
  const body = commitCall.body as {
    author: { name: string; email: string };
    committer: { name: string; email: string };
  };
  assert.equal(body.author.name, 'cpa-platform-bot');
  assert.equal(body.author.email, 'bot@cpa-platform.local');
  assert.equal(body.committer.name, 'cpa-platform-bot');
  assert.equal(body.committer.email, 'bot@cpa-platform.local');
});

test('generatePullRequest: bot email comes from GITHUB_BOT_EMAIL when set', async () => {
  _clearTokenCache();
  process.env['GITHUB_BOT_EMAIL'] = 'envbot@example.test';
  const harness = makeFetchMock(happyPathScript());
  await generatePullRequest(baseOpts(harness.fetch));
  const commitCall = harness.calls[5]!;
  const body = commitCall.body as { author: { email: string } };
  assert.equal(body.author.email, 'envbot@example.test');
  delete process.env['GITHUB_BOT_EMAIL'];
});

test('generatePullRequest: opts.botEmail overrides env var', async () => {
  _clearTokenCache();
  process.env['GITHUB_BOT_EMAIL'] = 'envbot@example.test';
  const harness = makeFetchMock(happyPathScript());
  await generatePullRequest(baseOpts(harness.fetch, { botEmail: 'optsbot@example.test' }));
  const commitCall = harness.calls[5]!;
  const body = commitCall.body as { author: { email: string } };
  assert.equal(body.author.email, 'optsbot@example.test');
  delete process.env['GITHUB_BOT_EMAIL'];
});

test('generatePullRequest: opens PR as draft', async () => {
  _clearTokenCache();
  const harness = makeFetchMock(happyPathScript());
  await generatePullRequest(baseOpts(harness.fetch));
  const prCall = harness.calls[7]!;
  const body = prCall.body as { draft: boolean; head: string; base: string };
  assert.equal(body.draft, true);
  assert.match(body.head, /^prompt-suggestion\//);
  assert.equal(body.base, 'main');
});

test('generatePullRequest: PR body never includes raw newContent', async () => {
  _clearTokenCache();
  const evalWithSecret: PromptSuggestionEvaluation = {
    ...makeEvaluation(),
    files: [
      {
        path: 'src/foo.ts',
        change_kind: 'modify',
        rationale:
          'Update foo.ts so the consultant flag scenario routes correctly through the validator.',
        diff_preview: '@@ tiny diff @@',
        newContent: 'const SECRET_THAT_SHOULD_NEVER_APPEAR_IN_PR_BODY = "leaked";',
      },
    ],
  };
  const harness = makeFetchMock(happyPathScript());
  await generatePullRequest(baseOpts(harness.fetch, { evaluation: evalWithSecret }));
  const prCall = harness.calls[7]!;
  const body = prCall.body as { body: string };
  assert.ok(
    !body.body.includes('SECRET_THAT_SHOULD_NEVER_APPEAR_IN_PR_BODY'),
    'PR body must not include raw newContent',
  );
  // Path + change_kind + rationale ARE in the body.
  assert.ok(body.body.includes('src/foo.ts'));
  assert.ok(body.body.includes('Update foo.ts'));
});

test('generatePullRequest: contract-test injection runs BEFORE pulls.create', async () => {
  _clearTokenCache();
  let contractTestRanAt = -1;
  let pullsCreateRanAt = -1;
  let counter = 0;
  const harness = makeFetchMock(happyPathScript());
  const wrappedFetch = mock.fn(async (url: unknown, init: unknown) => {
    const u = String(url);
    if (u.includes('/pulls')) {
      pullsCreateRanAt = ++counter;
    }
    return harness.fetch(url as string, init as RequestInit);
  }) as unknown as typeof globalThis.fetch;
  const runContractTest = mock.fn((): Promise<ContractTestResult> => {
    contractTestRanAt = ++counter;
    return Promise.resolve({ exitCode: 0, stdout: 'all green', stderr: '' });
  });
  await generatePullRequest(baseOpts(wrappedFetch, { runContractTest }));
  assert.notEqual(contractTestRanAt, -1);
  assert.notEqual(pullsCreateRanAt, -1);
  assert.ok(
    contractTestRanAt < pullsCreateRanAt,
    `contract test ran at ${contractTestRanAt} but pulls.create ran at ${pullsCreateRanAt}`,
  );
});

// ---------------------------------------------------------------------------
// Failure-path tests — every stage after branch creation must roll back
// ---------------------------------------------------------------------------

test('generatePullRequest: getMainRef failure → no branch created, error tagged auth/branch', async () => {
  _clearTokenCache();
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
      ok: false,
      status: 404,
      body: { message: 'Not Found' },
    },
  ]);
  await assert.rejects(
    () => generatePullRequest(baseOpts(harness.fetch)),
    (err: unknown) => {
      assert.ok(err instanceof ChoreographyError);
      assert.equal(err.stage, 'branch');
      return true;
    },
  );
  // Critically: no createRef was called, so no branch deletion either.
  const branchCalls = harness.calls.filter(
    (c) => c.url.includes('/git/refs') && (c.method === 'POST' || c.method === 'DELETE'),
  );
  assert.equal(branchCalls.length, 0);
});

test('generatePullRequest: createTree failure → branch deleted, stage=tree', async () => {
  _clearTokenCache();
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
      body: { sha: 'mainsha', tree: { sha: 'treesha' } },
    },
    { match: '/git/refs', method: 'POST', body: {} },
    {
      match: '/git/trees',
      method: 'POST',
      ok: false,
      status: 422,
      body: { message: 'tree validation failed' },
    },
    // Rollback: DELETE /git/refs/heads/<branch>
    { match: '/git/refs/heads/', method: 'DELETE', body: '', status: 204 },
  ]);
  await assert.rejects(
    () => generatePullRequest(baseOpts(harness.fetch)),
    (err: unknown) => {
      assert.ok(err instanceof ChoreographyError);
      assert.equal(err.stage, 'tree');
      return true;
    },
  );
  // Verify the DELETE happened.
  const deletes = harness.calls.filter((c) => c.method === 'DELETE');
  assert.equal(deletes.length, 1);
  assert.match(deletes[0]!.url, /\/git\/refs\/heads\//);
});

test('generatePullRequest: createCommit failure → branch deleted, stage=commit', async () => {
  _clearTokenCache();
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
      body: { sha: 'mainsha', tree: { sha: 'treesha' } },
    },
    { match: '/git/refs', method: 'POST', body: {} },
    { match: '/git/trees', method: 'POST', body: { sha: 'newtreesha' } },
    {
      match: '/git/commits',
      method: 'POST',
      ok: false,
      status: 422,
      body: { message: 'commit failed' },
    },
    { match: '/git/refs/heads/', method: 'DELETE', body: '', status: 204 },
  ]);
  await assert.rejects(
    () => generatePullRequest(baseOpts(harness.fetch)),
    (err: unknown) => {
      assert.ok(err instanceof ChoreographyError);
      assert.equal(err.stage, 'commit');
      return true;
    },
  );
  assert.equal(harness.calls.filter((c) => c.method === 'DELETE').length, 1);
});

test('generatePullRequest: updateRef failure → branch deleted, stage=ref_update', async () => {
  _clearTokenCache();
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
      body: { sha: 'mainsha', tree: { sha: 'treesha' } },
    },
    { match: '/git/refs', method: 'POST', body: {} },
    { match: '/git/trees', method: 'POST', body: { sha: 'newtreesha' } },
    { match: '/git/commits', method: 'POST', body: { sha: 'newcommitsha' } },
    {
      match: '/git/refs/heads/',
      method: 'PATCH',
      ok: false,
      status: 422,
      body: { message: 'fast-forward only' },
    },
    { match: '/git/refs/heads/', method: 'DELETE', body: '', status: 204 },
  ]);
  await assert.rejects(
    () => generatePullRequest(baseOpts(harness.fetch)),
    (err: unknown) => {
      assert.ok(err instanceof ChoreographyError);
      assert.equal(err.stage, 'ref_update');
      return true;
    },
  );
  assert.equal(harness.calls.filter((c) => c.method === 'DELETE').length, 1);
});

test('generatePullRequest: contract-test failure → branch deleted, stage=contract_test, error carries stdout/stderr', async () => {
  _clearTokenCache();
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
      body: { sha: 'mainsha', tree: { sha: 'treesha' } },
    },
    { match: '/git/refs', method: 'POST', body: {} },
    { match: '/git/trees', method: 'POST', body: { sha: 'newtreesha' } },
    { match: '/git/commits', method: 'POST', body: { sha: 'newcommitsha' } },
    { match: '/git/refs/heads/', method: 'PATCH', body: {} },
    { match: '/git/refs/heads/', method: 'DELETE', body: '', status: 204 },
  ]);
  const runContractTest = mock.fn(
    (): Promise<ContractTestResult> =>
      Promise.resolve({
        exitCode: 1,
        stdout: 'test foo failed: assertion error',
        stderr: 'AssertionError: expected X to equal Y',
      }),
  );
  await assert.rejects(
    () =>
      generatePullRequest(
        baseOpts(harness.fetch, {
          runContractTest,
        }),
      ),
    (err: unknown) => {
      assert.ok(err instanceof ChoreographyError);
      assert.equal(err.stage, 'contract_test');
      const cause = err.cause as ContractTestResult;
      assert.equal(cause.exitCode, 1);
      assert.match(cause.stdout, /test foo failed/);
      assert.match(cause.stderr, /AssertionError/);
      return true;
    },
  );
  // Verify branch deletion happened, and pulls.create did NOT fire.
  assert.equal(harness.calls.filter((c) => c.method === 'DELETE').length, 1);
  assert.equal(harness.calls.filter((c) => c.url.includes('/pulls')).length, 0);
});

test('generatePullRequest: pulls.create failure → branch deleted, stage=pr_create', async () => {
  _clearTokenCache();
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
      body: { sha: 'mainsha', tree: { sha: 'treesha' } },
    },
    { match: '/git/refs', method: 'POST', body: {} },
    { match: '/git/trees', method: 'POST', body: { sha: 'newtreesha' } },
    { match: '/git/commits', method: 'POST', body: { sha: 'newcommitsha' } },
    { match: '/git/refs/heads/', method: 'PATCH', body: {} },
    {
      match: '/pulls',
      method: 'POST',
      ok: false,
      status: 502,
      body: { message: 'Bad Gateway' },
    },
    { match: '/git/refs/heads/', method: 'DELETE', body: '', status: 204 },
  ]);
  await assert.rejects(
    () => generatePullRequest(baseOpts(harness.fetch)),
    (err: unknown) => {
      assert.ok(err instanceof ChoreographyError);
      assert.equal(err.stage, 'pr_create');
      return true;
    },
  );
  assert.equal(harness.calls.filter((c) => c.method === 'DELETE').length, 1);
});

test('generatePullRequest: branch-delete failure during rollback → original error propagates, warning logged', async () => {
  _clearTokenCache();
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
      body: { sha: 'mainsha', tree: { sha: 'treesha' } },
    },
    { match: '/git/refs', method: 'POST', body: {} },
    {
      match: '/git/trees',
      method: 'POST',
      ok: false,
      status: 422,
      body: { message: 'tree failed' },
    },
    // Rollback DELETE also fails — but we still propagate the ORIGINAL error.
    {
      match: '/git/refs/heads/',
      method: 'DELETE',
      ok: false,
      status: 500,
      body: 'cannot delete',
    },
  ]);
  const warnings: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
  const logger = {
    warn: (msg: string, meta?: Record<string, unknown>) => warnings.push({ msg, meta }),
  };
  await assert.rejects(
    () => generatePullRequest(baseOpts(harness.fetch, { logger })),
    (err: unknown) => {
      assert.ok(err instanceof ChoreographyError);
      // Original error wins, NOT the rollback failure.
      assert.equal(err.stage, 'tree');
      return true;
    },
  );
  // Warning logged about the failed delete.
  assert.ok(warnings.length >= 1);
  assert.ok(warnings.some((w) => /branch delete/.test(w.msg)));
});

// ---------------------------------------------------------------------------
// Determinism / branch-name / idempotency-shape tests
// ---------------------------------------------------------------------------

test('branchNameFor is deterministic for a given suggestion id', () => {
  const id = '12345678-90ab-4cde-8fab-cdef01234567';
  const name1 = branchNameFor(id);
  const name2 = branchNameFor(id);
  assert.equal(name1, name2);
  assert.equal(name1, 'prompt-suggestion/12345678');
});

test('branchNameFor uses suggestion-id prefix → different ids produce different branches', () => {
  const a = branchNameFor('aaaaaaaa-1111-4111-8111-111111111111');
  const b = branchNameFor('bbbbbbbb-2222-4222-8222-222222222222');
  assert.notEqual(a, b);
});

test('_internals.buildTreeEntries: create → blob with content, modify → blob with content, delete → blob with sha:null', () => {
  const entries = _internals.buildTreeEntries({
    suggestion_id: SUGGESTION_ID,
    classification: 'prompt_change',
    files: [
      {
        path: 'a.ts',
        change_kind: 'create',
        rationale: 'create rationale must be at least twenty chars',
        diff_preview: '+',
        newContent: 'a',
      },
      {
        path: 'b.ts',
        change_kind: 'modify',
        rationale: 'modify rationale must be at least twenty chars',
        diff_preview: '~',
        newContent: 'b',
      },
      {
        path: 'c.ts',
        change_kind: 'delete',
        rationale: 'delete rationale must be at least twenty chars',
        diff_preview: '-',
        newContent: '',
      },
    ],
    cross_file_consistency_checks_run: [],
    rationale_summary:
      'Test rationale summary that meets the fifty-character minimum length cap for the rationale_summary field.',
    prompt_version: '1.0.0',
    model: 'test',
  });
  assert.equal(entries.length, 3);
  assert.equal(entries[0]?.content, 'a');
  assert.equal(entries[0]?.sha, undefined);
  assert.equal(entries[1]?.content, 'b');
  assert.equal(entries[2]?.sha, null);
  assert.equal(entries[2]?.content, undefined);
});

// ---------------------------------------------------------------------------
// renderSuggestionPrBody — content + redaction
// ---------------------------------------------------------------------------

test('renderSuggestionPrBody includes suggestion context and reviewer id', () => {
  const body = renderSuggestionPrBody(makeSuggestion(), makeEvaluation(), 'reviewer-uuid-001');
  assert.match(body, /Issue summary/);
  assert.match(body, /Model conflates core vs supporting/);
  assert.match(body, /reviewer-uuid-001/);
  assert.match(body, /classify-expenditure@1\.0\.0/); // file path mention
  assert.match(body, /prompt-suggestion-evaluate@1\.0\.0/);
});

test('renderSuggestionPrBody never contains newContent payloads', () => {
  const evalWithSecret: PromptSuggestionEvaluation = {
    ...makeEvaluation(),
    files: [
      {
        path: 'src/foo.ts',
        change_kind: 'modify',
        rationale: 'A reasonable rationale that is at least twenty characters long.',
        diff_preview: '~',
        newContent: 'CANARY_STRING_DO_NOT_LEAK',
      },
    ],
  };
  const body = renderSuggestionPrBody(makeSuggestion(), evalWithSecret, 'reviewer');
  assert.ok(!body.includes('CANARY_STRING_DO_NOT_LEAK'));
});

test('renderSuggestionPrBody truncates long per-file rationales', () => {
  const longRationale = 'x'.repeat(800);
  const evalWithLong: PromptSuggestionEvaluation = {
    ...makeEvaluation(),
    files: [
      {
        path: 'src/foo.ts',
        change_kind: 'modify',
        rationale: longRationale,
        diff_preview: '~',
        newContent: 'a',
      },
    ],
  };
  const body = renderSuggestionPrBody(makeSuggestion(), evalWithLong, 'reviewer');
  // Truncates to 400 chars + ellipsis.
  assert.match(body, /x{400}…/);
  assert.ok(!body.includes('x'.repeat(401)));
});
