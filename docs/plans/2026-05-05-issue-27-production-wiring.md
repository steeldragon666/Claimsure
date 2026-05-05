# Issue #27 — Production wiring of suggestion-evaluator + contract-test runner — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire the production suggestion-evaluator (real Anthropic-driven) and a worktree-based contract-test runner into `apps/api/src/server.ts`, so `POST /v1/suggestions/:id/generate-pr` actually creates a draft PR end-to-end (instead of returning `503 evaluator_not_configured`). Flip the web-app feature flag default to on. Make `runContractTest` required at the type level.

**Architecture:** Two new files (`evaluate.ts` in agents, `contract-test-runner.ts` in api/lib). Two modified files (`server.ts` for wiring, `pr-choreography.ts` for the breaking signature change). One web-app flip. Three new test files plus minor updates to ~3 existing test files.

**Tech Stack:** TypeScript, Node.js, `@anthropic-ai/sdk@0.32.x`, Fastify, postgres-js, Vitest-not-applicable / `node:test` via `tsx --test`, pnpm workspaces, Git (for `git worktree add`).

**Worktree:** `C:/Users/Aaron/cpa-platform-worktrees/p7b.5` on branch `p7b.5/production-wiring`.

**Reference design:** [`docs/plans/2026-05-05-issue-27-production-wiring-design.md`](2026-05-05-issue-27-production-wiring-design.md).

**Reference issue:** GitHub #27.

---

## Pre-flight checks (do these once, before Task 1)

**1.** Confirm worktree is the current cwd:

```bash
pwd
# expect: C:/Users/Aaron/cpa-platform-worktrees/p7b.5
```

**2.** Confirm baseline typecheck still passes:

```bash
pnpm typecheck
# expect: "Tasks: 20 successful, 20 total"
```

**3.** Read the design doc thoroughly. The plan below will reference sections by name, not duplicate them.

**4.** Read the existing files you'll be touching, in this order, before writing any code:

- `packages/agents/src/runtime/anthropic-client.ts` — see how the Anthropic client is constructed
- `packages/agents/src/runtime/tool-use.ts` — see how the tool-use loop works (multi-turn `tool_use → tool_result → continue`)
- `packages/agents/src/suggestion-evaluator/types.ts` — confirm `PromptSuggestionForChoreography` and `PromptSuggestionEvaluation` shapes
- `packages/agents/src/suggestion-evaluator/repo-tools.ts` — confirm `repoTools`, `dispatchRepoTool`, and the existing `runContractTestSubprocess` function
- `packages/integrations/src/github-app/pr-choreography.ts` (lines 127-200, 600-650) — current `ContractTestRunner` shape, current contract-test stage logic
- `apps/api/src/routes/prompt-suggestions.ts` (lines 800-900) — handler error map, how it consumes `deps.evaluate`, `deps.choreograph`, `deps.runContractTest`

**5.** If Docker / Postgres is up locally, run the existing test suite to confirm clean baseline. If Docker is down, that's acceptable — DB-touching tests skip cleanly via `skipIfNoDb`. Either way, capture the baseline test count for comparison after each task:

```bash
pnpm test 2>&1 | tail -30
```

---

## Task 1: Stand up `evaluate.ts` skeleton + types (no Anthropic call yet)

**Why first:** establishes the public API + DI seams + error class hierarchy. Subsequent tasks fill in the call logic.

**Files:**

- Create: `packages/agents/src/suggestion-evaluator/evaluate.ts`
- Modify: `packages/agents/src/suggestion-evaluator/index.ts` (add `export * from './evaluate.js';`)
- Test: `packages/agents/src/suggestion-evaluator/evaluate.test.ts`

**Step 1: Write the failing test**

Create `evaluate.test.ts` with ONE test that just imports the public API and asserts the exported error classes exist. The test will fail at import time because the file doesn't exist yet.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluate,
  EvaluatorConfigError,
  EvaluatorUpstreamError,
  EvaluatorParseError,
  EvaluatorLoopExhaustedError,
  type EvaluateInput,
} from './evaluate.js';

test('evaluate.ts: exports the expected public API', () => {
  assert.equal(typeof evaluate, 'function');
  assert.equal(typeof EvaluatorConfigError, 'function');
  assert.equal(typeof EvaluatorUpstreamError, 'function');
  assert.equal(typeof EvaluatorParseError, 'function');
  assert.equal(typeof EvaluatorLoopExhaustedError, 'function');
  // EvaluateInput is a type-only export; presence is checked at compile time
});
```

**Step 2: Run test to verify it fails**

```bash
cd packages/agents
pnpm exec tsx --test src/suggestion-evaluator/evaluate.test.ts 2>&1 | tail -10
```

Expected: ERROR — `Cannot find module './evaluate.js'` (the file doesn't exist).

**Step 3: Write minimal implementation**

Create `packages/agents/src/suggestion-evaluator/evaluate.ts`:

```ts
import type Anthropic from '@anthropic-ai/sdk';
import type { PromptSuggestionForChoreography } from '@cpa/integrations/github-app';
import type { PromptSuggestionEvaluation } from './types.js';

export interface EvaluateInput {
  suggestion: PromptSuggestionForChoreography;
  repoRoot: string;
  /** DI seam — defaults to a lazy `getAnthropicClient()` from runtime/anthropic-client.ts. */
  anthropic?: Anthropic;
  /** Defaults to `'claude-opus-4-7'`. */
  model?: string;
  /** Cap on tool-use loop iterations. Defaults to 12. */
  maxTurns?: number;
  /** AbortSignal so the 5-min handler timeout can interrupt the call. */
  signal?: AbortSignal;
}

/**
 * Production evaluator: takes a prompt-suggestion + repo root, runs the
 * Anthropic-driven tool-use loop with the SYSTEM_PROMPT and read-only
 * repo tools, returns the proposed change set.
 *
 * The handler at apps/api/src/routes/prompt-suggestions.ts:739 calls
 * this through the `deps.evaluate` injection point; production wiring
 * lives in apps/api/src/server.ts.
 *
 * Throws structured errors so the handler error map (line 845-870)
 * can produce the right HTTP code + structured detail.
 */
export async function evaluate(input: EvaluateInput): Promise<PromptSuggestionEvaluation> {
  // Skeleton — implementation lands in Task 2
  throw new Error('evaluate(): not yet implemented (Task 2 of issue #27 plan)');
}

export class EvaluatorConfigError extends Error {
  override readonly name = 'EvaluatorConfigError';
}
export class EvaluatorUpstreamError extends Error {
  override readonly name = 'EvaluatorUpstreamError';
}
export class EvaluatorParseError extends Error {
  override readonly name = 'EvaluatorParseError';
  /** First 500 chars of the unparseable response, for triage. */
  rawSnippet: string;
  constructor(message: string, rawSnippet: string) {
    super(message);
    this.rawSnippet = rawSnippet;
  }
}
export class EvaluatorLoopExhaustedError extends Error {
  override readonly name = 'EvaluatorLoopExhaustedError';
  turnsUsed: number;
  constructor(message: string, turnsUsed: number) {
    super(message);
    this.turnsUsed = turnsUsed;
  }
}
```

Then add the barrel export to `packages/agents/src/suggestion-evaluator/index.ts`:

```ts
export {
  evaluate,
  EvaluatorConfigError,
  EvaluatorUpstreamError,
  EvaluatorParseError,
  EvaluatorLoopExhaustedError,
  type EvaluateInput,
} from './evaluate.js';
```

(Place this near the other exports, before the side-effect prompt-registration import.)

**Step 4: Run test to verify it passes**

```bash
cd packages/agents
pnpm exec tsx --test src/suggestion-evaluator/evaluate.test.ts 2>&1 | tail -10
```

Expected: `# pass 1`.

**Step 5: Typecheck**

```bash
cd ../..
pnpm typecheck 2>&1 | tail -5
```

Expected: 20/20 successful.

**Step 6: Commit**

```bash
git add packages/agents/src/suggestion-evaluator/evaluate.ts packages/agents/src/suggestion-evaluator/evaluate.test.ts packages/agents/src/suggestion-evaluator/index.ts
git commit -m "feat(agents): suggestion-evaluator/evaluate.ts skeleton + error classes

Public API + DI seams + error class hierarchy for the production
evaluator. evaluate() itself throws \"not yet implemented\" — the
Anthropic-driven tool-use loop lands in Task 2 of issue #27 plan.

Refs: docs/plans/2026-05-05-issue-27-production-wiring-design.md"
```

---

## Task 2: Wire the Anthropic tool-use loop inside `evaluate()`

**Why:** This is the core of the evaluator. After this, `evaluate()` is functional with a stubbed Anthropic client.

**Files:**

- Modify: `packages/agents/src/suggestion-evaluator/evaluate.ts`
- Modify: `packages/agents/src/suggestion-evaluator/evaluate.test.ts`

**Step 1: Read the existing tool-use helper**

Re-read `packages/agents/src/runtime/tool-use.ts`. Identify whether it exports a generic `runToolUseLoop` (or similar) function. If yes, we'll call it. If it's a low-level helper that only handles a single turn, we'll write a small loop in `evaluate()` using the Anthropic SDK directly.

**Step 2: Write failing tests covering the loop**

Add to `evaluate.test.ts` (use `node:test` with a fake Anthropic client passed via the `anthropic` DI seam):

```ts
test('evaluate: happy path — model returns final JSON in one turn', async () => {
  const fakeAnthropic = mockAnthropicReturning({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          suggestion_id: 'abc',
          classification: 'prompt_change',
          files: [{
            path: 'packages/agents/src/classifier-expenditure/prompts/x.ts',
            change_kind: 'modify',
            rationale: 'tighten the decision tree',
            diff_preview: '@@ ... @@',
            newContent: 'export const X = "y";\n',
          }],
          cross_file_consistency_checks_run: ['ran subprocess test'],
          rationale_summary: 'consultant flagged misclassification',
          prompt_version: '1.0.0',
          model: 'claude-opus-4-7',
        }),
      },
    ],
    stop_reason: 'end_turn',
  });
  const result = await evaluate({
    suggestion: makeSuggestion(),
    repoRoot: '/tmp/fake',
    anthropic: fakeAnthropic,
  });
  assert.equal(result.suggestion_id, 'abc');
  assert.equal(result.files.length, 1);
});

test('evaluate: tool-use turn → final answer (multi-turn)', async () => {
  // First call: stop_reason='tool_use', requests readFile
  // Second call: stop_reason='end_turn', returns final JSON
  const fakeAnthropic = mockAnthropicSequence([
    { content: [{ type: 'tool_use', id: 't1', name: 'readFile', input: { path: 'a.ts' } }], stop_reason: 'tool_use' },
    { content: [{ type: 'text', text: validEvaluationJson() }], stop_reason: 'end_turn' },
  ]);
  const result = await evaluate({ suggestion: makeSuggestion(), repoRoot: process.cwd(), anthropic: fakeAnthropic });
  assert.ok(result.files);
});

test('evaluate: loop hits maxTurns cap', async () => {
  // Anthropic always returns stop_reason='tool_use'; loop should exhaust at maxTurns=2
  const fakeAnthropic = mockAnthropicAlwaysToolUse();
  await assert.rejects(
    () => evaluate({ suggestion: makeSuggestion(), repoRoot: process.cwd(), anthropic: fakeAnthropic, maxTurns: 2 }),
    (err: unknown) => err instanceof EvaluatorLoopExhaustedError && err.turnsUsed === 2,
  );
});

test('evaluate: final response not valid JSON throws EvaluatorParseError', async () => {
  const fakeAnthropic = mockAnthropicReturning({
    content: [{ type: 'text', text: 'this is not JSON' }],
    stop_reason: 'end_turn',
  });
  await assert.rejects(
    () => evaluate({ suggestion: makeSuggestion(), repoRoot: process.cwd(), anthropic: fakeAnthropic }),
    (err: unknown) => err instanceof EvaluatorParseError && err.rawSnippet.includes('not JSON'),
  );
});

test('evaluate: AbortSignal fires throws AbortError', async () => {
  const ac = new AbortController();
  const fakeAnthropic = mockAnthropicSlow(); // resolves after 1s
  setTimeout(() => ac.abort(), 10);
  await assert.rejects(
    () => evaluate({ suggestion: makeSuggestion(), repoRoot: process.cwd(), anthropic: fakeAnthropic, signal: ac.signal }),
    (err: unknown) => (err as Error).name === 'AbortError',
  );
});

test('evaluate: Anthropic SDK throws 5xx → EvaluatorUpstreamError', async () => {
  const fakeAnthropic = mockAnthropicThrowing(new Error('Internal Server Error'));
  await assert.rejects(
    () => evaluate({ suggestion: makeSuggestion(), repoRoot: process.cwd(), anthropic: fakeAnthropic }),
    (err: unknown) => err instanceof EvaluatorUpstreamError,
  );
});

test('evaluate: missing API key (no anthropic + no env) → EvaluatorConfigError', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  await assert.rejects(
    () => evaluate({ suggestion: makeSuggestion(), repoRoot: process.cwd() }),
    (err: unknown) => err instanceof EvaluatorConfigError,
  );
});
```

Add a small `mockAnthropic*` helper section near the top of the test file. These mocks return a partially-shaped object matching what `evaluate()` consumes — they don't need to be a full `Anthropic` SDK shape; just have a `messages.create()` method.

**Step 3: Run tests to verify they fail**

```bash
cd packages/agents
pnpm exec tsx --test src/suggestion-evaluator/evaluate.test.ts 2>&1 | tail -20
```

Expected: 7 failures (all 7 new tests fail because `evaluate()` still throws "not yet implemented"). The existing API-export test from Task 1 should still pass.

**Step 4: Implement the loop**

Replace the body of `evaluate()` in `evaluate.ts`. Pseudocode:

```ts
export async function evaluate(input: EvaluateInput): Promise<PromptSuggestionEvaluation> {
  const startedAt = Date.now();
  const anthropic = input.anthropic ?? getAnthropicClient(); // throws EvaluatorConfigError if no env key
  const model = input.model ?? 'claude-opus-4-7';
  const maxTurns = input.maxTurns ?? 12;

  // Build initial messages array — system prompt + user message describing
  // the suggestion. Pull SYSTEM_PROMPT from the prompts module.
  const systemPrompt = SYSTEM_PROMPT;
  const initialUserMessage = renderSuggestionContext(input.suggestion);
  const messages: Anthropic.Messages.MessageParam[] = [
    { role: 'user', content: initialUserMessage },
  ];

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (input.signal?.aborted) throw input.signal.reason ?? new DOMException('Aborted', 'AbortError');

    let response: Anthropic.Messages.Message;
    try {
      response = await anthropic.messages.create({
        model,
        system: systemPrompt,
        messages,
        tools: anthropicToolDefinitions(),
        max_tokens: 8192,
      }, { signal: input.signal });
    } catch (err) {
      // Distinguish abort from upstream error
      if ((err as Error)?.name === 'AbortError') throw err;
      throw new EvaluatorUpstreamError(
        `Anthropic call failed at turn ${turn}: ${(err as Error).message}`,
        { cause: err },
      );
    }

    if (response.stop_reason === 'tool_use') {
      // Append assistant turn + tool_result blocks for each tool_use in the response
      messages.push({ role: 'assistant', content: response.content });
      const toolResults = await Promise.all(
        response.content
          .filter((block): block is Anthropic.Messages.ToolUseBlock => block.type === 'tool_use')
          .map(async (block) => {
            try {
              const result = await dispatchRepoTool(block.name, block.input, { repoRoot: input.repoRoot });
              return { type: 'tool_result' as const, tool_use_id: block.id, content: JSON.stringify(result) };
            } catch (toolErr) {
              return {
                type: 'tool_result' as const,
                tool_use_id: block.id,
                content: (toolErr as Error).message,
                is_error: true,
              };
            }
          }),
      );
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // stop_reason === 'end_turn' (or similar) — extract final text and parse
    const finalText = response.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(finalText);
    } catch {
      throw new EvaluatorParseError(
        `Final response is not valid JSON after ${turn} turns`,
        finalText.slice(0, 500),
      );
    }
    const validation = PromptSuggestionEvaluationSchema.safeParse(parsed);
    if (!validation.success) {
      throw new EvaluatorParseError(
        `Final response failed Zod validation: ${validation.error.message}`,
        finalText.slice(0, 500),
      );
    }
    return validation.data;
  }

  throw new EvaluatorLoopExhaustedError(
    `Evaluator did not produce a final answer within ${maxTurns} turns`,
    maxTurns,
  );
}
```

Helpers needed (write inline or in helper file):

- `getAnthropicClient()` — wraps `runtime/anthropic-client.ts`; throws `EvaluatorConfigError` if key missing
- `renderSuggestionContext(s: PromptSuggestionForChoreography): string` — formats the suggestion as the initial user message
- `anthropicToolDefinitions()` — converts the existing `repoTools` registry into the Anthropic Tools schema shape
- `PromptSuggestionEvaluationSchema` — Zod schema matching the response contract; can live in `types.ts` if not already there

**Step 5: Run tests to verify they pass**

```bash
cd packages/agents
pnpm exec tsx --test src/suggestion-evaluator/evaluate.test.ts 2>&1 | tail -25
```

Expected: 8 passes (1 from Task 1 + 7 from Task 2).

**Step 6: Typecheck + lint**

```bash
cd ../..
pnpm typecheck 2>&1 | tail -5
pnpm --filter @cpa/agents lint 2>&1 | tail -5
```

Expected: typecheck 20/20 successful; lint clean.

**Step 7: Commit**

```bash
git add packages/agents/src/suggestion-evaluator/evaluate.ts packages/agents/src/suggestion-evaluator/evaluate.test.ts packages/agents/src/suggestion-evaluator/types.ts
git commit -m "feat(agents): suggestion-evaluator runs Anthropic tool-use loop

Implements the multi-turn loop: tool_use → dispatchRepoTool → tool_result
→ continue, terminating on stop_reason=end_turn. Caps at maxTurns (default
12) to bound cost and tail latency.

Final text is parsed as JSON and validated against the Zod schema for
PromptSuggestionEvaluation. Parse failures throw EvaluatorParseError
with the first 500 chars of the response for triage.

7 unit tests cover happy-path single-turn, multi-turn, loop exhaustion,
parse error, abort, upstream 5xx, and missing API key. All use a
stubbed Anthropic client via the DI seam — no real Anthropic calls
in CI.

Refs: issue #27 Task 2 of plan."
```

---

## Task 3: Stand up `contract-test-runner.ts` skeleton + types

**Why:** Same TDD pattern — get the public API + DI seams right before implementing the worktree mechanics.

**Files:**

- Create: `apps/api/src/lib/contract-test-runner.ts`
- Test: `apps/api/src/lib/contract-test-runner.test.ts`

**Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildContractTestRunner } from './contract-test-runner.js';

test('contract-test-runner: buildContractTestRunner returns a function', () => {
  const runner = buildContractTestRunner({ repoRoot: '/tmp/fake' });
  assert.equal(typeof runner, 'function');
});
```

**Step 2: Run to verify failure**

```bash
cd apps/api
pnpm exec tsx --test src/lib/contract-test-runner.test.ts 2>&1 | tail -10
```

Expected: `Cannot find module './contract-test-runner.js'`.

**Step 3: Write minimal implementation**

Create `apps/api/src/lib/contract-test-runner.ts`:

```ts
import type { ChoreographyChangedFile, ContractTestResult } from '@cpa/integrations/github-app';

/**
 * Test-injection seam for the contract-test stage of the GitHub App PR
 * choreography. Production wiring lives in apps/api/src/server.ts; tests
 * provide a trivial stub.
 *
 * The runner takes the change-set (file paths + new content) directly,
 * so it doesn't need to know about Git remotes or the GitHub branch
 * the choreography just pushed to.
 */
export interface ChoreographyChangedFileWithContent extends ChoreographyChangedFile {
  newContent?: string; // present for create/modify, absent for delete
}

export type ContractTestRunner = (
  changeSet: ChoreographyChangedFileWithContent[],
  packageFilter: string,
  testPattern: string,
) => Promise<ContractTestResult>;

export interface BuildContractTestRunnerOptions {
  /** Repo root for the `git worktree add` command. */
  repoRoot: string;
  /** Defaults to 'origin/main'. */
  baseRef?: string;
  /** Hard cap on the pnpm subprocess. Defaults to 5 minutes. */
  timeoutMs?: number;
  /** Logger for structured info/warn lines. Defaults to a no-op. */
  logger?: { info: (msg: string, meta?: Record<string, unknown>) => void; warn: (msg: string, meta?: Record<string, unknown>) => void };
  /** DI seam — defaults to 'pnpm'. Tests can pass a stub script. */
  pnpmCommand?: string;
}

export function buildContractTestRunner(opts: BuildContractTestRunnerOptions): ContractTestRunner {
  // Skeleton — implementation lands in Task 4
  return async () => {
    throw new Error('contract-test-runner: not yet implemented (Task 4 of issue #27 plan)');
  };
}
```

**Step 4: Run to verify pass**

```bash
cd apps/api
pnpm exec tsx --test src/lib/contract-test-runner.test.ts 2>&1 | tail -5
```

Expected: `# pass 1`.

**Step 5: Typecheck**

```bash
cd ../..
pnpm typecheck 2>&1 | tail -3
```

Expected: 20/20 successful.

**Step 6: Commit**

```bash
git add apps/api/src/lib/contract-test-runner.ts apps/api/src/lib/contract-test-runner.test.ts
git commit -m "feat(api): contract-test-runner skeleton + types

ContractTestRunner type takes the change-set as first arg (vs the
prior signature that took only packageFilter + testPattern). The new
signature lets the runner materialize proposed changes locally without
re-fetching from GitHub. Implementation lands in Task 4.

Refs: issue #27 Task 3 of plan."
```

---

## Task 4: Implement contract-test-runner worktree mechanics

**Files:**

- Modify: `apps/api/src/lib/contract-test-runner.ts`
- Modify: `apps/api/src/lib/contract-test-runner.test.ts`

**Step 1: Add failing tests**

Add to the test file. For the pnpm DI seam, write a tiny shell-script stub at test setup time:

```ts
import { writeFile, mkdir, mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

let TEST_REPO: string;

before(async () => {
  // Create a tiny git repo we can worktree from
  TEST_REPO = await mkdtemp(join(tmpdir(), 'cpa-eval-test-repo-'));
  await execFileP('git', ['init', '-q'], { cwd: TEST_REPO });
  await execFileP('git', ['config', 'user.email', 'test@example.com'], { cwd: TEST_REPO });
  await execFileP('git', ['config', 'user.name', 'Test'], { cwd: TEST_REPO });
  await writeFile(join(TEST_REPO, 'README.md'), '# test\n');
  await execFileP('git', ['add', 'README.md'], { cwd: TEST_REPO });
  await execFileP('git', ['commit', '-q', '-m', 'init'], { cwd: TEST_REPO });
  await execFileP('git', ['branch', '-m', 'main'], { cwd: TEST_REPO }); // ensure main is the branch name
});

after(async () => {
  await rm(TEST_REPO, { recursive: true, force: true });
});

test('runner: happy path — applies changeSet, runs stubbed pnpm, exits 0', async () => {
  // Stub pnpm: a script that echoes "ok" and exits 0
  const stubPnpm = await makeStubPnpm({ exitCode: 0, stdout: 'ok', stderr: '' });
  const runner = buildContractTestRunner({ repoRoot: TEST_REPO, baseRef: 'main', pnpmCommand: stubPnpm });
  const result = await runner(
    [{ path: 'NEW.md', change_kind: 'create', newContent: 'hello\n' }],
    '@cpa',
    'some-pattern',
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), 'ok');
});

test('runner: pnpm test exits non-zero', async () => {
  const stubPnpm = await makeStubPnpm({ exitCode: 1, stdout: '', stderr: 'failure' });
  const runner = buildContractTestRunner({ repoRoot: TEST_REPO, baseRef: 'main', pnpmCommand: stubPnpm });
  const result = await runner(
    [{ path: 'a.ts', change_kind: 'create', newContent: 'export const x = 1;\n' }],
    '@cpa',
    'pattern',
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /failure/);
});

test('runner: subprocess hits timeoutMs', async () => {
  const stubPnpm = await makeStubPnpm({ sleep_ms: 5000, exitCode: 0 });
  const runner = buildContractTestRunner({ repoRoot: TEST_REPO, baseRef: 'main', pnpmCommand: stubPnpm, timeoutMs: 100 });
  const result = await runner([], '@cpa', 'pattern');
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, -1);
});

test('runner: bad baseRef → throws + cleanup attempted', async () => {
  const stubPnpm = await makeStubPnpm({ exitCode: 0 });
  const runner = buildContractTestRunner({ repoRoot: TEST_REPO, baseRef: 'nonexistent-branch', pnpmCommand: stubPnpm });
  await assert.rejects(() => runner([], '@cpa', 'pattern'));
});

test('runner: change_kind=delete removes file', async () => {
  // Pre-seed an existing README in main; runner deletes it; assert it's absent
  // (Use a tracker that records the worktree contents at pnpm-spawn time.)
  const tracker = makeFsTracker();
  const stubPnpm = await makeStubPnpmWithSnapshot({ exitCode: 0 }, tracker);
  const runner = buildContractTestRunner({ repoRoot: TEST_REPO, baseRef: 'main', pnpmCommand: stubPnpm });
  await runner([{ path: 'README.md', change_kind: 'delete' }], '@cpa', 'pattern');
  assert.equal(tracker.fileExists('README.md'), false);
});

test('runner: concurrent calls use distinct tempdirs', async () => {
  const stubPnpm = await makeStubPnpm({ sleep_ms: 200, exitCode: 0 });
  const runner = buildContractTestRunner({ repoRoot: TEST_REPO, baseRef: 'main', pnpmCommand: stubPnpm });
  const [r1, r2] = await Promise.all([
    runner([{ path: 'a.ts', change_kind: 'create', newContent: 'a' }], '@cpa', 'p1'),
    runner([{ path: 'b.ts', change_kind: 'create', newContent: 'b' }], '@cpa', 'p2'),
  ]);
  assert.equal(r1.exitCode, 0);
  assert.equal(r2.exitCode, 0);
});

test('runner: cleanup failure swallowed + logged', async () => {
  const warns: string[] = [];
  const logger = { info: () => {}, warn: (m: string) => warns.push(m) };
  // Make worktree-remove fail by removing the .git dir mid-run (or by using a stub git)
  // Simplest: rely on cleanup catching errors; just verify no exception escapes and result returns.
  const stubPnpm = await makeStubPnpm({ exitCode: 0 });
  const runner = buildContractTestRunner({ repoRoot: TEST_REPO, baseRef: 'main', pnpmCommand: stubPnpm, logger });
  const result = await runner([], '@cpa', 'pattern');
  assert.equal(result.exitCode, 0);
  // (warn may or may not fire depending on timing — main assertion is "no throw")
});
```

**Step 2: Run to verify failures**

```bash
cd apps/api
pnpm exec tsx --test src/lib/contract-test-runner.test.ts 2>&1 | tail -25
```

Expected: 7 failures, 1 pass (the API-export test from Task 3).

**Step 3: Implement**

Replace the `buildContractTestRunner()` body. Pseudocode:

```ts
export function buildContractTestRunner(opts: BuildContractTestRunnerOptions): ContractTestRunner {
  const baseRef = opts.baseRef ?? 'origin/main';
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  const pnpmCommand = opts.pnpmCommand ?? 'pnpm';
  const logger = opts.logger ?? { info: () => {}, warn: () => {} };

  return async (changeSet, packageFilter, testPattern) => {
    const startedAt = Date.now();
    const dir = await mkdtemp(join(tmpdir(), 'cpa-eval-'));
    try {
      // 1. Create worktree at baseRef
      await execFileP('git', ['worktree', 'add', '--detach', dir, baseRef], { cwd: opts.repoRoot });

      // 2. Apply changeSet
      for (const f of changeSet) {
        const filePath = join(dir, f.path);
        if (f.change_kind === 'delete') {
          await rm(filePath, { force: true });
        } else {
          await mkdir(dirname(filePath), { recursive: true });
          await writeFile(filePath, f.newContent ?? '');
        }
      }

      // 3. Spawn pnpm subprocess
      const result = await runPnpm({
        pnpmCommand, cwd: dir, packageFilter, testPattern, timeoutMs,
      });

      logger.info('contract-test-runner: completed', {
        exitCode: result.exitCode, latencyMs: Date.now() - startedAt,
        timedOut: result.timedOut,
        stdoutBytes: Buffer.byteLength(result.stdout),
        stderrBytes: Buffer.byteLength(result.stderr),
      });
      return result;
    } finally {
      // 4. Cleanup
      try {
        await execFileP('git', ['worktree', 'remove', '--force', dir], { cwd: opts.repoRoot });
      } catch (err) {
        logger.warn('contract-test-runner: worktree-remove failed', { error: (err as Error).message });
      }
      try {
        await rm(dir, { recursive: true, force: true });
      } catch (err) {
        logger.warn('contract-test-runner: rm failed', { error: (err as Error).message });
      }
    }
  };
}

async function runPnpm(args: {...}): Promise<ContractTestResult> {
  // spawn pnpmCommand with --filter packageFilter test -- --test-name-pattern testPattern
  // capture stdout/stderr, enforce timeoutMs via setTimeout + child.kill('SIGKILL')
  // return { exitCode, stdout, stderr, timedOut }
}
```

Implement `runPnpm` carefully — it must handle SIGKILL on timeout AND drain stdout/stderr after kill, otherwise the promise can hang.

**Step 4: Run tests to verify they pass**

```bash
cd apps/api
pnpm exec tsx --test src/lib/contract-test-runner.test.ts 2>&1 | tail -20
```

Expected: 8 passes (1 from Task 3 + 7 new).

**Step 5: Typecheck + lint**

```bash
cd ../..
pnpm typecheck 2>&1 | tail -3
pnpm --filter @cpa/api lint 2>&1 | tail -3
```

**Step 6: Commit**

```bash
git add apps/api/src/lib/contract-test-runner.ts apps/api/src/lib/contract-test-runner.test.ts
git commit -m "feat(api): worktree-based contract-test runner

Materializes the proposed change-set into a fresh git worktree at
baseRef, runs the pnpm test subprocess with a configurable
test-name-pattern, captures stdout/stderr/exitCode/timedOut, and
cleans up the worktree in a finally block (errors swallowed +
logged).

7 unit tests via a stubbed pnpm command (DI seam) and an in-test
git repo. Covers happy path, exit non-zero, timeout SIGKILL, bad
baseRef, change_kind=delete, concurrent calls (distinct tempdirs),
and cleanup-failure swallow.

Refs: issue #27 Task 4 of plan."
```

---

## Task 5: Update `ContractTestRunner` signature in pr-choreography (the breaking change)

**Why:** Now that the new runner exists, lift its signature into the choreography. This is the I3 fix — runner becomes required.

**Files:**

- Modify: `packages/integrations/src/github-app/pr-choreography.ts` (lines 134-200, 600-650)
- Modify: `packages/integrations/src/github-app/pr-choreography.test.ts` (~5 invocations)
- Modify: `apps/api/src/routes/prompt-suggestions.test.ts` (`happyDeps()` + ~2 contract-test failure tests)
- Modify: `apps/api/src/routes/prompt-suggestions.contract.test.ts` (~1 mock signature update)

**Step 1: Update the type and choreography body**

In `pr-choreography.ts`:

```ts
// ContractTestRunner — signature now takes change-set as first arg
export type ContractTestRunner = (
  changeSet: ChoreographyChangedFileWithContent[],
  packageFilter: string,
  testPattern: string,
) => Promise<ContractTestResult>;

// ChoreographyChangedFileWithContent — exported here for cross-package consumption
export interface ChoreographyChangedFileWithContent extends ChoreographyChangedFile {
  newContent?: string;
}

// In ChoreographyOptions: drop the `?` to make it required
runContractTest: ContractTestRunner;
```

In the contract-test stage (around line 608), drop the `if (opts.runContractTest !== undefined)` guard and pass the change-set:

```ts
// Stage 7: contract test (BEFORE PR creation) — REQUIRED in production wiring
const changeSet: ChoreographyChangedFileWithContent[] = opts.evaluation.files.map((f) => ({
  path: f.path,
  change_kind: f.change_kind,
  newContent: f.newContent, // undefined for delete, present for create/modify
}));
const packageFilter = '@cpa';
const testPattern = `prompt-suggestion-${opts.suggestion.id.slice(0, 8)}`;
const result = await opts.runContractTest(changeSet, packageFilter, testPattern);
// ... rest unchanged: if exitCode !== 0 then rollback + throw
```

**Step 2: Update tests**

- `pr-choreography.test.ts`: each `generatePullRequest({...})` invocation now MUST include `runContractTest: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })`. The signature change means the mock fn type updates from `(pkg, pat) => ...` to `(changes, pkg, pat) => ...`.
- `prompt-suggestions.test.ts`: `happyDeps()` returns a `runContractTest` field. Update its function signature.
- `prompt-suggestions.contract.test.ts`: Same type update.

**Step 3: Typecheck + run all affected tests**

```bash
pnpm typecheck 2>&1 | tail -5
# expect: 20/20 successful

cd packages/integrations
pnpm exec tsx --test src/github-app/pr-choreography.test.ts 2>&1 | tail -5
# expect: all tests still pass

cd ../../apps/api
pnpm exec tsx --test src/routes/prompt-suggestions.test.ts 2>&1 | tail -5
pnpm exec tsx --test src/routes/prompt-suggestions.contract.test.ts 2>&1 | tail -5
# expect: all pass
```

**Step 4: Commit**

```bash
git add packages/integrations/src/github-app/pr-choreography.ts packages/integrations/src/github-app/pr-choreography.test.ts apps/api/src/routes/prompt-suggestions.test.ts apps/api/src/routes/prompt-suggestions.contract.test.ts
git commit -m "feat(integrations,api): runContractTest required + new signature

Per code-reviewer's I3 from PR #25: runContractTest is now required
in ChoreographyOptions, and its signature takes the change-set as
first arg so the runner can materialize proposed changes locally
without re-fetching from GitHub.

Updated all test mocks (pr-choreography.test.ts ×5, prompt-suggestions
.test.ts happyDeps + 2 contract-test scenarios, prompt-suggestions
.contract.test.ts ×1) to provide a trivial runContractTest stub.

Refs: issue #27 Task 5 of plan."
```

---

## Task 6: Wire `server.ts` + flip the feature flag

**Files:**

- Modify: `apps/api/src/server.ts`
- Modify: `apps/web/src/app/suggestions/_components/suggestion-detail.tsx` (1 line)
- Test: `apps/api/src/server.test.ts` (NEW)

**Step 1: Write the smoke test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from './app.js';

test('buildApp accepts production deps shape (smoke wiring test)', async () => {
  const app = buildApp({
    promptSuggestions: {
      evaluate: () => Promise.resolve({} as never),
      choreograph: () => Promise.resolve({} as never),
      runContractTest: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
    },
  });
  await app.ready();
  // Hitting an unknown route should return 404 (proves app booted)
  const res = await app.inject({ method: 'GET', url: '/__nope__' });
  assert.equal(res.statusCode, 404);
  await app.close();
});
```

**Step 2: Run it (should pass — nothing under test changed)**

```bash
cd apps/api
pnpm exec tsx --test src/server.test.ts 2>&1 | tail -5
```

Expected: `# pass 1`. If it fails, the type signature in `app.ts:111` doesn't match what we're passing — fix and retry.

**Step 3: Update `server.ts`**

```ts
import { sdk } from './tracer-init.js';
import { buildApp } from './app.js';
import { evaluate as defaultEvaluate } from '@cpa/agents/suggestion-evaluator';
import { generatePullRequest } from '@cpa/integrations/github-app';
import { buildContractTestRunner } from './lib/contract-test-runner.js';

const repoRoot = process.env.REPO_ROOT ?? process.cwd();

const app = buildApp({
  promptSuggestions: {
    evaluate: (input) => defaultEvaluate({ suggestion: input.suggestion, repoRoot: input.repoRoot }),
    choreograph: (opts) => generatePullRequest(opts),
    runContractTest: buildContractTestRunner({ repoRoot, logger: app.log }),
  },
});

// ... rest unchanged
```

**Step 4: Flip the feature flag**

In `apps/web/src/app/suggestions/_components/suggestion-detail.tsx`, change the predicate:

```ts
// BEFORE:
const FEATURE_GENERATE_PR = process.env['NEXT_PUBLIC_FEATURE_GENERATE_PR'] === 'true';
// AFTER:
const FEATURE_GENERATE_PR = process.env['NEXT_PUBLIC_FEATURE_GENERATE_PR'] !== 'false';
```

Update the comment block above the constant to reflect the new default.

**Step 5: Typecheck + run smoke test**

```bash
cd ../..
pnpm typecheck 2>&1 | tail -3
# expect: 20/20 successful

cd apps/api
pnpm exec tsx --test src/server.test.ts 2>&1 | tail -5
# expect: # pass 1
```

**Step 6: Commit**

```bash
git add apps/api/src/server.ts apps/api/src/server.test.ts apps/web/src/app/suggestions/_components/suggestion-detail.tsx
git commit -m "feat(api,web): wire production evaluator + flip Generate-PR feature flag

server.ts now constructs buildApp() with real defaultEvaluate (Anthropic
+ tool-use loop) and a worktree-based contract-test runner — closing the
dead-code gap from PR #25's Phase 1.

Web app feature-flag predicate flipped to default-on
(NEXT_PUBLIC_FEATURE_GENERATE_PR=false is the explicit kill-switch).

apps/api/src/server.test.ts (new) is a minimal smoke wiring test that
catches typo-level dep-shape errors at app boot.

Closes #27."
```

---

## Task 7: Run the full test suite + open PR

**Step 1: Full test suite (locally if Docker is up; otherwise CI catches DB tests)**

```bash
pnpm typecheck 2>&1 | tail -3
pnpm test 2>&1 | tail -15
```

Confirm:
- typecheck 20/20 successful
- All previously-passing tests still pass
- 3 new test files pass: `evaluate.test.ts` (8 tests), `contract-test-runner.test.ts` (8 tests), `server.test.ts` (1 test)

**Step 2: Push branch + open PR**

```bash
git push -u origin p7b.5/production-wiring
gh pr create --repo steeldragon666/cpa-platform --base main --head p7b.5/production-wiring \
  --title "feat(p7b.5): production wiring of suggestion-evaluator + contract-test runner" \
  --body "$(cat <<'EOF'
## Summary

Closes the dead-code gap from PR #25's Phase 1 — the Generate-PR endpoint
now actually creates draft PRs end-to-end instead of returning
`503 evaluator_not_configured`.

Closes #27.

## Changes

| File | Change |
|---|---|
| `packages/agents/src/suggestion-evaluator/evaluate.ts` | NEW — production evaluator using Anthropic + existing tool-use loop |
| `packages/agents/src/suggestion-evaluator/evaluate.test.ts` | NEW — 8 unit tests with stubbed Anthropic client |
| `apps/api/src/lib/contract-test-runner.ts` | NEW — worktree-based contract-test runner |
| `apps/api/src/lib/contract-test-runner.test.ts` | NEW — 8 unit tests with stubbed pnpm + in-test git repo |
| `apps/api/src/server.ts` | MODIFIED — wires production deps |
| `apps/api/src/server.test.ts` | NEW — smoke wiring test |
| `packages/integrations/src/github-app/pr-choreography.ts` | MODIFIED — `runContractTest` required + signature change (per I3) |
| `packages/integrations/src/github-app/pr-choreography.test.ts` | MODIFIED — 5 mock invocations updated |
| `apps/api/src/routes/prompt-suggestions.test.ts` | MODIFIED — `happyDeps()` updated for new signature |
| `apps/api/src/routes/prompt-suggestions.contract.test.ts` | MODIFIED — same |
| `apps/web/src/app/suggestions/_components/suggestion-detail.tsx` | MODIFIED — feature flag flipped to default-on |

## Design

[`docs/plans/2026-05-05-issue-27-production-wiring-design.md`](https://github.com/steeldragon666/cpa-platform/blob/main/docs/plans/2026-05-05-issue-27-production-wiring-design.md) (committed to main on 2026-05-05).

## Out of scope (deferred)

- Real-Anthropic smoke test (manual run, env-gated) — separate PR
- Staging GitHub App E2E test — manual after deploy
- Stress test for concurrent worktree creation

## Test plan

- [ ] CI passes
- [ ] Manual: enable `NEXT_PUBLIC_FEATURE_GENERATE_PR=true` in dev (or just run on this branch — flag now defaults on); flag a suggestion → triage → click Generate PR → verify a draft PR appears in the cpa-platform repo with sensible content

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

**Step 3: Watch CI**

CI takes ~10 min. If green, the PR is ready for human review + merge.

If failures appear in tests we authored, fix and push. If failures are unrelated (e.g., another P-C class one-off transient absorbed by retry), confirm via the retry log message.

---

## What we DON'T do in this plan

- Don't add a real-Anthropic CI integration test — that burns credits per run
- Don't deploy to staging from this PR — manual step after merge
- Don't rewrite `runContractTestSubprocess` in `repo-tools.ts` — that's the agent-tool-call path, separate from the API-layer `contract-test-runner.ts`
- Don't touch the other Phase 2 issues (#28 schemas, #29 triage_notes, #30 reconciler) — those land separately

## Rollback notes

If we need to revert this PR after merge:

- `git revert <merge-sha>` would un-wire the deps, leaving server.ts back at `buildApp()` and the handler back to returning 503.
- The web-app feature flag flip is part of the same revert — Generate-PR button would hide again.
- No DB migrations are introduced, so no migration rollback needed.
- `runContractTest` becoming required is the only "breaking" element; if the revert is clean (full PR), all callers get the optional version back.
