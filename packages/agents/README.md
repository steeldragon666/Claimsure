# @cpa/agents

Runtime + classifier package for AI agents in the cpa-platform. Provides
the shared infrastructure (Anthropic client, prompt registry, OTel
telemetry, idempotency cache, tool-use call helper) plus the first
production agent — the R&D evidence classifier.

This package is internal (`"private": true`) and consumed via pnpm
workspace links by `apps/api`, `apps/web` (server actions only), and
future agent packages.

## Subpath exports

The package is ESM-only with three entry points:

```ts
// Whole-package re-export (runtime + classifier).
import { makeClassifier } from '@cpa/agents';

// Just the runtime (Anthropic client, registry, telemetry, cache, tool-use).
import { withAgentSpan, getPrompt, computeIdempotencyKey } from '@cpa/agents/runtime';

// Just the classifier (factory + interfaces + impls).
import { makeClassifier, StubClassifier, HaikuClassifier } from '@cpa/agents/classifier';
```

Use the narrowest import path that satisfies the call site — `runtime`
when you're only wiring infra, `classifier` when you need a `Classifier`,
the root re-export only for cases that genuinely need both.

## Environment variables

| Variable            | Required                          | Default                          | Notes                                                                                                                                  |
| ------------------- | --------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `CLASSIFIER_IMPL`   | no                                | `haiku` (or `stub` if `CI=true`) | Selects the `Classifier` impl returned by `makeClassifier()`. Honored verbatim if set; unknown values throw at startup.                |
| `ANTHROPIC_API_KEY` | only when `CLASSIFIER_IMPL=haiku` | —                                | Real Anthropic API key. Missing key throws an explanatory error from `getAnthropicClient()` pointing at the stub fallback.             |
| `CLASSIFIER_MODEL`  | no                                | `claude-haiku-4-5`               | Override the Anthropic model id the `HaikuClassifier` calls. Used in tests to pin to a specific snapshot model when SDK defaults move. |

The `factory.ts` resolution order is:

1. `CLASSIFIER_IMPL` is honored verbatim if set.
2. Otherwise, `CI=true` opts into `stub`.
3. Otherwise, defaults to `haiku`.

## Switching impls

### Circuit-breaker (prod)

If Anthropic is degraded or the API key is rate-limited, flip the env
without a deploy:

```sh
# Operator action — prod environment
CLASSIFIER_IMPL=stub
```

Capture continues with the deterministic regex classifier. The default
when no rule matches is `SUPPORTING` at 0.50 confidence, which routes
to Needs Review for human reclassification — never blocks the chain.

### Offline / no-key dev

```sh
# Local dev without an Anthropic key
CLASSIFIER_IMPL=stub pnpm --filter @cpa/agents test
```

The factory test suite exercises both branches explicitly, so flipping
back to `haiku` once a key is set is a one-env-var change.

### CI

`CI=true` is set automatically by GitHub Actions, which means the stub
is selected with no env-var rewrite needed. Keeping CI off the live
model avoids cost-per-PR + flake risk on Anthropic outages. A small
amount of nock-mocked `HaikuClassifier` coverage exists in
`src/classifier/haiku.test.ts` for the live-path contract.

## Adding a new agent

The classifier is the template. To add a second agent (e.g. extractor,
drafter):

1. **Define a versioned prompt** at
   `src/<agent-name>/prompts/<prompt-name>@<semver>.ts`. Use semver
   even for v1.0.0 — versioning is the price of stable cache keys.
   Register via `registerPrompt({ name, version, system, tool })`. The
   filename's version segment must match the `version` field exactly.
2. **Implement the agent class** at
   `src/<agent-name>/<impl>.ts`. Side-effect import the prompt module
   so registration happens before the class is constructed:
   ```ts
   import './prompts/extract@1.0.0.js';
   ```
   The class implements a narrow interface (`Classifier`, `Extractor`,
   etc.) with an `async classify(...)` / `async extract(...)` method
   that returns a typed output including `model`, `prompt_version`,
   `tokens_in`, `tokens_out`.
3. **Add a factory** at `src/<agent-name>/factory.ts` if the agent has
   more than one impl (live + stub). Mirror the
   `CLASSIFIER_IMPL` / `EXTRACTOR_IMPL` pattern for env selection. Throw
   on unknown impl names so misconfiguration fails loudly.
4. **Wire telemetry** by wrapping the call in `withAgentSpan(...)`. Pass
   the agent name + initial attrs; the callback receives a `setAttr`
   helper for late values (token counts, classification result). The
   wrapper records exceptions on the span and sets ERROR status
   automatically, so let errors propagate. Example:
   ```ts
   await withAgentSpan('classify', { prompt_version: 'classify@1.0.0' }, async (setAttr) => {
     const out = await client.classify(input);
     setAttr({ tokens_in: out.tokens_in, tokens_out: out.tokens_out, model: out.model });
     return out;
   });
   ```
5. **Add tests**:
   - Unit test the impl with `nock` mocking `https://api.anthropic.com`.
   - Unit test the factory's env resolution branches.
   - Integration test the cache hit/miss path against a real Postgres
     (`@cpa/db`'s test runner pattern).

The `src/classifier/` directory is the canonical reference — copying
its layout to `src/extractor/` is an explicit pattern, not a
limitation.

## Cost & idempotency

Each agent call is content-addressed by SHA-256 of `prompt_version ||
NUL || raw_input` (see `runtime/idempotency.ts`). Identical inputs
under the same prompt version dedupe to one cache row in
`agent_call_cache`.

- **Key scheme:** SHA-256 over `prompt_version + '\0' + raw_input`
  (UTF-8). Output is 64 lowercase hex chars, enforced at the DB level
  by the `agent_call_cache_idempotency_key_format` CHECK. The `'\0'`
  separator prevents version/input boundary collisions
  (`('classify@1.0', '.0hello')` vs `('classify@1.0.0', 'hello')` would
  otherwise hash identically).
- **First-write-wins:** the insert is
  `ON CONFLICT (idempotency_key) DO NOTHING`. A second classify of the
  same text returns the original cached output, never a surprise
  replacement.
- **No TTL in P2.** Eviction policy lands in P3+ when growth data
  warrants it. Today the row count is bounded by unique-pastes-ever.
- **Content-addressed, not RLS-scoped.** Identical inputs across
  tenants share an entry. The key reveals nothing the requester
  doesn't already know — they pasted the text. No tenant data leaks.

The architectural rationale lives in
[`docs/decisions/0003-event-chain-and-classifier.md`](../../docs/decisions/0003-event-chain-and-classifier.md).

## Testing

```sh
# All unit + integration tests for the package.
pnpm --filter @cpa/agents test

# Just typecheck.
pnpm --filter @cpa/agents typecheck

# Just lint.
pnpm --filter @cpa/agents lint
```

The runner is Node 22's native test runner via `tsx --test`, matching
the repo-wide convention from ADR-0001. Tests live alongside source
(`*.test.ts`).

### Mocking Anthropic with nock

`HaikuClassifier` hits `https://api.anthropic.com/v1/messages` through
the SDK. Tests intercept with `nock`:

```ts
import nock from 'nock';
import { _resetAnthropicClientForTests } from '@cpa/agents/runtime';

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  _resetAnthropicClientForTests();
  nock.cleanAll();
});

test('HaikuClassifier round-trips through Anthropic SDK', async () => {
  nock('https://api.anthropic.com')
    .post('/v1/messages')
    .reply(200, {
      id: 'msg',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5',
      content: [
        {
          type: 'tool_use',
          id: 't',
          name: 'classify_evidence',
          input: {
            kind: 'HYPOTHESIS',
            confidence: 0.9,
            rationale: 'r',
            statutory_anchor: '§355-25(1)(a)',
          },
        },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 200, output_tokens: 50 },
    });

  const c = new HaikuClassifier();
  const out = await c.classify({ raw_text: '...' });
  // assert on out.kind, out.confidence, out.tokens_in, out.tokens_out
});
```

Notes:

- **`_resetAnthropicClientForTests()`** is the test-only escape hatch
  that clears the cached SDK client so the next call rebuilds with the
  current env. Production code never calls this.
- **`nock.cleanAll()`** in `beforeEach` keeps tests independent —
  unmatched interceptors from a prior test don't leak.
- **The `tool_use` content shape** must match the prompt's tool
  definition (`name: 'classify_evidence'`) — a mismatched name
  surfaces as a parse error in `tool-use.ts`.

`StubClassifier` needs no mocking. Its tests exercise the rule-order
contract directly (e.g. "associate-flag wins over time-log when both
match").

## Reference layout

```
packages/agents/src/
├── index.ts                       — re-export runtime + classifier
├── runtime/
│   ├── anthropic-client.ts        — lazy SDK singleton + test reset
│   ├── prompt-registry.ts         — name@version Map
│   ├── telemetry.ts               — withAgentSpan helper
│   ├── idempotency.ts             — computeIdempotencyKey + cache I/O
│   ├── tool-use.ts                — Anthropic tool-use call wrapper
│   ├── types.ts                   — shared types
│   └── index.ts
└── classifier/
    ├── types.ts                   — Classifier interface, EvidenceKind
    ├── factory.ts                 — makeClassifier() env selection
    ├── stub.ts                    — deterministic regex impl
    ├── haiku.ts                   — Anthropic SDK + Haiku impl
    ├── prompts/
    │   └── classify@1.0.0.ts      — system prompt + tool schema
    └── index.ts
```
