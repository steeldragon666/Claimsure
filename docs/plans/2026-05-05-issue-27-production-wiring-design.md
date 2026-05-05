# Issue #27 — Production wiring of suggestion-evaluator + contract-test runner

**Status:** Design approved 2026-05-05. Implementation plan to follow.
**Closes:** GitHub issue #27 ("P7 B.5.1 — wire production suggestion-evaluator + contract-test runner into server.ts (C1)")
**Effort:** 6–10h
**Author:** Aaron + Claude Code (interactive brainstorm)

## Context

PR #25 (Theme B Phase 1) shipped the entire prompt-suggestion-queue pipeline — schemas, REST surface, GitHub App choreography, webhook receiver, web UI — but `apps/api/src/server.ts` calls `buildApp()` with no `promptSuggestions` deps. The handler at `prompt-suggestions.ts:829` returns `503 evaluator_not_configured` for every authenticated request. The web app's "Generate PR" button is feature-flagged off (`NEXT_PUBLIC_FEATURE_GENERATE_PR`, default false) until production wiring lands.

This design closes that gap. It builds the production evaluator function (which doesn't exist yet — only types, tools, and the system prompt do), wires it through `server.ts` together with a real contract-test runner, and flips the feature flag default to on.

## Architecture

```
HTTP request to POST /v1/suggestions/:id/generate-pr
        │
        ▼
  apps/api/src/routes/prompt-suggestions.ts handler  (existing — unchanged)
        │   uses deps.evaluate, deps.choreograph, deps.runContractTest
        ▼
  apps/api/src/server.ts  (CHANGED — wires production deps)
        │
        ├── deps.evaluate ────────────► packages/agents/src/suggestion-evaluator/evaluate.ts   (NEW)
        │                                  │  Anthropic SDK + existing runtime/anthropic-client
        │                                  │  + existing runtime/tool-use.ts loop
        │                                  │  + existing repo-tools (read-only)
        │                                  │  + existing SYSTEM_PROMPT
        │                                  └─► returns PromptSuggestionEvaluation
        │
        ├── deps.choreograph ─────────► packages/integrations/src/github-app/pr-choreography.ts (existing)
        │                                  │  generatePullRequest()
        │
        └── deps.runContractTest ─────► apps/api/src/lib/contract-test-runner.ts   (NEW)
                                            │  signature: (changeSet, packageFilter, testPattern) → ContractTestResult
                                            │  1. mkdtemp() unique dir under os.tmpdir()
                                            │  2. git worktree add <tempDir> origin/main
                                            │  3. apply changeSet[].newContent to <tempDir>/<path>
                                            │  4. spawn pnpm in <tempDir>: --filter <pkg> test --test-name-pattern <pattern>
                                            │  5. capture stdout/stderr/exitCode/timedOut
                                            │  6. finally: git worktree remove --force <tempDir>
```

**Two new files** (`evaluate.ts` in agents, `contract-test-runner.ts` in api/lib).
**Two modified files** (`server.ts` for wiring, `pr-choreography.ts` for the breaking signature change to `ContractTestRunner`).
**One web-app change** (flip the feature-flag predicate to default-on).

**Why `contract-test-runner.ts` lives in `apps/api/src/lib/` and not in `packages/agents/`:** the runner's job is to prepare a worktree and dispatch a subprocess — that's API-layer concern (deployment topology). The agents package stays focused on "what to call Anthropic with"; deployment-specific orchestration sits outside.

**Concurrency:** unique tempdir per call (`mkdtemp` returns guaranteed-unique paths). Multiple concurrent generate-PR runs cannot collide on filesystem state.

## Components

### 1. `packages/agents/src/suggestion-evaluator/evaluate.ts` (NEW, ~150 LOC)

```ts
export interface EvaluateInput {
  suggestion: PromptSuggestionForChoreography;
  repoRoot: string;
  // DI seams for tests + observability:
  anthropic?: Anthropic;             // defaults to runtime/anthropic-client.getClient()
  model?: string;                    // defaults to 'claude-opus-4-7' (or whatever the SYSTEM_PROMPT pins)
  maxTurns?: number;                 // defaults to 12 (cap on tool-use loop iterations)
  signal?: AbortSignal;              // for the 5-min handler timeout
}

export async function evaluate(input: EvaluateInput): Promise<PromptSuggestionEvaluation>;
```

Builds the Anthropic messages array with `SYSTEM_PROMPT` + suggestion context. Runs the tool-use loop using `runtime/tool-use.ts` (existing) — dispatches read-only repo tools. Parses the final text response as JSON matching `PromptSuggestionEvaluation`. Validates the response shape (Zod) before returning. Throws structured errors:

- `EvaluatorConfigError` (no API key) → caller maps to 503
- `EvaluatorUpstreamError` (Anthropic 5xx / rate-limit / timeout) → caller maps to 502
- `AbortError` (signal fired) → caller surfaces as 502/aborted
- `EvaluatorLoopExhaustedError` (hit `maxTurns`) → 502/loop_exhausted
- `EvaluatorParseError` (final text not valid JSON, or Zod validation fails) → 502/parse_failed

### 2. `apps/api/src/lib/contract-test-runner.ts` (NEW, ~120 LOC)

```ts
export type ContractTestRunner = (
  changeSet: ChoreographyChangedFileWithContent[],
  packageFilter: string,
  testPattern: string,
) => Promise<ContractTestResult>;

export const buildContractTestRunner = (opts: {
  repoRoot: string;          // e.g. process.cwd()
  baseRef?: string;          // defaults to 'origin/main'
  timeoutMs?: number;        // defaults to 5 * 60 * 1000 (5 min)
  logger?: { info, warn };
  pnpmCommand?: string;      // DI seam for tests; defaults to 'pnpm'
}): ContractTestRunner;
```

The runner is a closure factory — `buildContractTestRunner({ repoRoot })` returns a `ContractTestRunner`. This lets `server.ts` decide repoRoot once at startup. Cleanup is in `finally` with swallowed errors so a single failed cleanup never masks the actual test result.

Lifecycle per call:

1. `mkdtemp(join(tmpdir(), 'cpa-eval-'))` → unique tempDir
2. `git worktree add --detach <tempDir> origin/main`
3. For each `f` in `changeSet`:
   - if `change_kind === 'delete'`: `rm <tempDir>/<f.path>`
   - else: `mkdir -p dirname` + `writeFile <tempDir>/<f.path> f.newContent`
4. `spawn pnpm --filter <packageFilter> test -- --test-name-pattern <testPattern>` with `cwd: tempDir`, capturing stdout/stderr, with `timeoutMs` enforced via `setTimeout` + `child.kill('SIGKILL')`
5. `finally`: `git worktree remove --force <tempDir>`; `rm -rf <tempDir>` (best-effort, swallowed errors)

### 3. `apps/api/src/server.ts` (MODIFIED, +30 LOC)

```ts
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
```

Stays minimal. All complexity is delegated to the new modules.

### 4. `packages/integrations/src/github-app/pr-choreography.ts` (MODIFIED, breaking)

`ContractTestRunner` signature changes from `(packageFilter, testPattern) => Promise<...>` to `(changeSet, packageFilter, testPattern) => Promise<...>`. `runContractTest` becomes **required** in `ChoreographyOptions` (per code-reviewer's I3 from PR #25). Tests using mocks add the new arg + `runContractTest` field. Estimated ripple: ~5 test files.

### 5. `apps/web/src/app/suggestions/_components/suggestion-detail.tsx` (MODIFIED, 1 line)

Change the predicate from "default off" to "default on, opt-out":

```ts
const FEATURE_GENERATE_PR = process.env['NEXT_PUBLIC_FEATURE_GENERATE_PR'] !== 'false';
```

Default-on means production users see the button without env-config wrangling. Setting `NEXT_PUBLIC_FEATURE_GENERATE_PR=false` in dev is the explicit kill-switch for the rare case (e.g., GitHub App outage).

## Data flow

The happy path, end-to-end, stage by stage with latency budget:

| Stage | Component | Latency | Notes |
|---|---|---|---|
| 1 | Auth + DB checks (existing) | <50ms | Role gate, uuid shape, suggestion lookup, status gate, env presence |
| 2 | Evaluator | **30–120s** | Anthropic + tool-use loop, max 12 turns. Largest budget consumer. |
| 3 | Choreography Git+HTTP | ~5–15s | createRef → tree → commit → updateRef |
| 4 | Contract-test runner | **20–90s** | mkdtemp + worktree + apply changes + pnpm test + cleanup. Variable on package size. |
| 5 | PR creation (if test passes) | ~1–3s | `pulls.create` |
| 6 | DB writes (`prompt_suggestion_pr` insert + parent flip) | <100ms | Single tx; RLS-scoped |
| **Total** | | **~3.5 min worst case** | Well under the 5-min handler timeout |

## Error handling

### Evaluator failures (`deps.evaluate` throws)

| Cause | HTTP returned | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` not set | **503** `evaluator_not_configured` | First-call detection inside `evaluate()` |
| Anthropic 5xx / rate limit / timeout | **502** `evaluator_failed` | Existing path at handler line 847 |
| AbortSignal fires (5-min handler timeout) | **502** `aborted` | |
| Tool-use loop hits `maxTurns` (12) | **502** `loop_exhausted` | |
| Final text not valid JSON / Zod validation fails | **502** `parse_failed` | Raw response snippet logged for triage |
| Tool returned an error to the model | (none — loop continues) | Tool errors are normal `tool_result.is_error=true` |

### Contract-test runner failures (`deps.runContractTest` throws or returns non-zero)

| Cause | HTTP returned | Notes |
|---|---|---|
| `git worktree add` fails | **422** `contract_test_failed` | Setup error in `detail` |
| `writeFile` fails | **422** | Disk full / perm — same path |
| pnpm subprocess exits non-zero (real test failure) | **422** `contract_test_failed` | Choreography rolls back branch; structured `detail: { exitCode, stdout, stderr }` |
| pnpm subprocess hits `timeoutMs` (default 5 min) | **422** `timed_out` | SIGKILL + cleanup + structured detail |
| Cleanup fails (worktree-remove or rmdir) | (none — logged warn only) | Doesn't affect response |

### `runContractTest` becoming required (signature/type ripple)

| File | Change |
|---|---|
| `pr-choreography.ts:148-182` | Drop `?` on `runContractTest` |
| `pr-choreography.ts:608-639` | Drop `if (opts.runContractTest !== undefined)` guard |
| `pr-choreography.test.ts` (~5 tests) | Update each invocation to provide trivial `runContractTest` stub |
| `prompt-suggestions.test.ts` `happyDeps()` | Update mock signature `(pkg, pat) → (changes, pkg, pat)` |
| `prompt-suggestions.contract.test.ts` | Update mock signature |

### Observability

Structured logs added (no production logging exists for the evaluator yet):

- `evaluate()` INFO on entry: `{ suggestion_id, model, max_turns }`
- `evaluate()` INFO on exit: `{ suggestion_id, turns_used, total_tokens, latency_ms }`
- `evaluate()` ERROR on throw: `{ suggestion_id, error_class, error_message, raw_response_snippet }`
- `contract-test-runner` INFO on completion: `{ suggestion_id, exit_code, latency_ms, timed_out, stdout_bytes, stderr_bytes }`

All logs route through Fastify's `req.log` (passed via runner factory `opts.logger`) so they get the request-id correlation.

## Testing

Three new unit-level test files (CI-safe — no Anthropic, no GitHub, no Postgres required):

### 1. `packages/agents/src/suggestion-evaluator/evaluate.test.ts` (NEW, ~250 LOC)

DI seam takes `anthropic?: Anthropic` so tests inject a fake.

| Test | Asserts |
|---|---|
| Happy path: model returns final JSON in one turn | Returns parsed `PromptSuggestionEvaluation`; turns_used=1 |
| Tool-use turn → final answer (multi-turn) | Each turn dispatches the requested tool; loop terminates on `stop_reason='end_turn'` |
| Loop hits `maxTurns` cap | Throws `EvaluatorLoopExhaustedError` |
| Final response not valid JSON | Throws `EvaluatorParseError` with raw_snippet |
| Final response valid JSON but Zod validation fails | Throws `EvaluatorParseError` |
| Anthropic SDK throws 5xx | Throws `EvaluatorUpstreamError`; original error chained as `cause` |
| AbortSignal fires mid-turn | Throws `AbortError`; partial state not retained |
| Tool returns error to model | Loop continues; tool error is `tool_result.is_error=true` |

### 2. `apps/api/src/lib/contract-test-runner.test.ts` (NEW, ~180 LOC)

Requires Git but not Postgres/Anthropic/GitHub. Uses a temp git repo seeded by test setup. **Stubbed pnpm**: tiny shell script (or fake binary) that echoes "ok" and exits 0/1, passed via `pnpmCommand` DI seam.

| Test | Asserts |
|---|---|
| Happy path: changeSet writes files; pnpm test exits 0 | Returns `{ exitCode: 0, ... }`; worktree cleaned up |
| pnpm test exits non-zero | Returns `{ exitCode: 1, ... }`; worktree cleaned up |
| Subprocess hits timeoutMs | Returns `{ timedOut: true, exitCode: -1 }`; worktree cleaned up; subprocess SIGKILLed |
| `git worktree add` fails (bad baseRef) | Throws; cleanup attempted |
| `change_kind: 'delete'` removes the file | File absent in worktree before pnpm runs |
| Concurrent calls use distinct tempdirs | No filesystem race; both succeed |
| Cleanup failure is swallowed + logged | Test result still returned correctly |

### 3. `apps/api/src/server.test.ts` (NEW, ~80 LOC) — wiring smoke test

Spins up app via `buildApp({ promptSuggestions: { evaluate, choreograph, runContractTest, env } })` with all four deps stubbed; asserts a request to a non-existent endpoint returns 404 (proves the app booted). Catches typo-level wiring errors.

### Existing-test updates

| File | Change | LOC |
|---|---|---|
| `packages/integrations/src/github-app/pr-choreography.test.ts` | Update 5 invocations: signature change `(pkg, pat) → (changes, pkg, pat)`; provide trivial `runContractTest` stub | ~25 |
| `apps/api/src/routes/prompt-suggestions.test.ts` | Update `happyDeps()` runner mock signature; update 2 contract-test failure tests | ~15 |
| `apps/api/src/routes/prompt-suggestions.contract.test.ts` | Same | ~10 |

### What we DON'T add (deferred)

- Real Anthropic integration test → separate PR with a smoke flag (manual run only)
- Real GitHub App E2E test → manual staging deploy verification (issue #27 step 3)
- Stress test for concurrent worktree creation → not in scope

## Out of scope for this PR

Per code-reviewer's PR #25 follow-up issues:

- **#28 (C2)** — Promote enums + Zod schemas to `@cpa/schemas`
- **#29 (I6)** — `triage_notes` column or remove the wire field
- **#30 (I2)** — Reconciler parent-status divergence

These remain open; this PR doesn't touch them.

## Acceptance criteria

- [ ] `apps/api/src/server.ts` constructs `buildApp({ promptSuggestions: {...} })` with real `evaluate`, `choreograph`, `runContractTest`
- [ ] `packages/agents/src/suggestion-evaluator/evaluate.ts` exists and exports `evaluate()` matching `PromptSuggestionEvaluation` contract
- [ ] `apps/api/src/lib/contract-test-runner.ts` exists and exports `buildContractTestRunner()`
- [ ] `ContractTestRunner` signature updated to take `changeSet` as first arg; `runContractTest` is required in `ChoreographyOptions`
- [ ] All ~50 existing tests still pass (signature ripple resolved)
- [ ] 3 new test files (`evaluate.test.ts`, `contract-test-runner.test.ts`, `server.test.ts`) pass
- [ ] Web app feature flag predicate flipped to default-on
- [ ] PR description notes follow-ups (real-Anthropic smoke test, staging E2E) as deferred
