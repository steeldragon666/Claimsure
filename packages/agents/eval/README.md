# Agent eval framework

This directory contains the offline-eval harness for the three P6 agents:

- **Agent A** — `expenditure-classifier/` (Haiku): scores
  `(decision, statutory_anchor)` against hand-curated cases.
- **Agent B** — `register-synthesizer/` (Sonnet): scores cluster count and
  per-cluster Jaccard overlap of `clustered_event_ids`.
- **Agent C** — `narrative-drafter/` (Sonnet, streaming): scores structural
  validity of the segment tree (claim citations are in-scope, every section
  has the minimum claim density).

The framework consists of:

- `run.ts` — shared streaming runner. Reads NDJSON from a `goldenPath`, calls
  `runOne(input)`, scores via a caller-supplied `score(output, expected, input)`,
  emits one JSON line per case to stdout, and writes a Markdown summary to
  stderr.
- `scoring.ts` — pure helpers: `f1Score`, `jaccardSimilarity`,
  `categoryAccuracy`, `validateNarrativeStructure`. No I/O, no Anthropic
  dependency, fully unit-testable.
- `<agent>/run.ts` — per-agent driver that composes the framework with the
  agent factory (`makeExpenditureClassifier`, `makeRegisterSynthesizer`,
  `streamNarrativeDraft`).
- `<agent>/golden.ndjson` — hand-written placeholder cases (Task 7.1).
  **Production datasets are deferred to Task 7.2** (see below).

## Running an eval

Each per-agent runner is invoked via a top-level pnpm script:

```bash
# Single agent
pnpm --filter @cpa/agents eval:expenditure
pnpm --filter @cpa/agents eval:register
pnpm --filter @cpa/agents eval:narrative

# All three in sequence
pnpm --filter @cpa/agents eval:all
```

Output:

- **stdout**: one JSON object per case (`{agent, case_id, score, passed, …}`).
  Pipe to `jq` or capture for offline diffing against a baseline.
- **stderr**: a Markdown summary table + a one-line `agent: passed/total` summary.
- **exit code**: 0 if all cases passed, 1 if any case failed. Suitable for
  drop-in CI use.

## Required environment

- `EVAL_ANTHROPIC_API_KEY` — REQUIRED unless the agent factory has been
  forced to a stub via `EXPENDITURE_CLASSIFIER_IMPL=stub`,
  `ACTIVITY_REGISTER_SYNTHESIZER_IMPL=stub`, or
  `NARRATIVE_DRAFTER_IMPL=stub`. Each per-agent runner promotes
  `EVAL_ANTHROPIC_API_KEY` to `ANTHROPIC_API_KEY` at startup so the same
  factory plumbing the production worker uses works unchanged.

  We use a separate env var (rather than reusing `ANTHROPIC_API_KEY`) so that
  CI can inject a sandboxed eval-only key with separate cost tracking and
  rate-limit budget.

- `.env` at the workspace root is auto-loaded via
  `tsx --env-file-if-exists=../../.env`.

## Pass-threshold convention

The runner defaults to `passThreshold = 0.7`. Per-agent runners override this
implicitly via their `score` function's `passed` flag:

- **Agent A** (expenditure-classifier): `passed` requires both decision +
  anchor to match AND `eligibility_probability >= expected.min_eligibility_probability`.
  In practice the score is binary 0/0.5/1 — there's no 0.7-region.
- **Agent B** (register-synthesizer): `passed` requires the cluster count to
  fall within `[min, max]` AND every expected cluster to find a synthesized
  cluster with Jaccard ≥ its `min_jaccard`.
- **Agent C** (narrative-drafter): `passed` requires `validateNarrativeStructure`
  to return `valid: true` AND every requested target section to have ≥1
  segment.

The framework's own `passThreshold` (0.7) is the second gate — even if a
score function returns `passed: true`, the score must clear 0.7 to count
as passed. This is a defensive belt-and-braces guard for future score
functions where `passed` might silently drift away from the score.

## Cost estimate per full run

Rough order-of-magnitude estimates assuming the placeholder dataset sizes
in this directory and per-call token usage observed in the implementation
fixtures:

| Agent                  | Model                         | Cases | Est. cost per full run |
| ---------------------- | ----------------------------- | ----- | ---------------------- |
| expenditure-classifier | claude-haiku-4-5              | 5     | ~$0.10                 |
| register-synthesizer   | claude-sonnet-4-5             | 2     | ~$0.30                 |
| narrative-drafter      | claude-sonnet-4-5 (streaming) | 2     | ~$0.50                 |

Totals scale roughly linearly with case count when Task 7.2 grows the
golden datasets to 50 / 10 / 20 cases respectively. The narrative-drafter
cost is dominated by the streaming output budget (8192 tokens default,
multiplied by correction-retry attempts).

## Gap to Task 7.2 — production-quality datasets

The `golden.ndjson` files in this commit are PLACEHOLDERS, NOT a production
dataset. They exist to make the framework end-to-end testable; the criteria
they enforce are minimal (single decision branch per case, vacuous
clustering for synthesizer, single-activity narrative).

**Task 7.2** will replace these with hand-curated production datasets:

- 50 expenditure-classifier cases (the cell-pattern of the IRS Division 355
  enum is small; we want at least 10 cases per `(decision, statutory_anchor)`
  pair plus boundary cases).
- 10 register-synthesizer cases covering small/medium/large project shapes,
  events_truncated edge case, and multi-cluster splits.
- 20 narrative-drafter cases covering happy-path drafts, regenerate-section
  flows, prefill ingestion, and correction-retry exhaustion.

These cases require **R&D consultant review** (Aaron + co-author network) —
they cannot be LLM-generated, because the whole point of a golden dataset
is that it's INDEPENDENT of the model under test. Synthetic data leaks
training-distribution shape into the eval and silently inflates pass rates.

When Task 7.2 lands the dataset format will be locked, the
placeholders here will be deleted, and the framework will pick up the new
files unchanged.

## Adding a new case manually

1. Append a JSON object to the relevant `<agent>/golden.ndjson`. Lines must
   be one-object-per-line (no pretty-printing); blank lines and `// comment`
   lines are ignored by the runner.
2. The `input` shape must match the agent's input type
   (`ExpenditureClassifierInput`, `SynthesizerInput`, or
   `Omit<StreamNarrativeDraftInput, 'abortSignal'>`).
3. The `expected` shape is per-agent and documented inline at the top of
   each `golden.ndjson`.

## Tests

The framework itself is verified by:

- `eval/scoring.test.ts` — branch coverage for every helper.
- `eval/run.test.ts` — smoke test that constructs a fake `runOne` + fake
  `score`, runs the framework against a tmp NDJSON file, and asserts on
  the captured stdout JSON + stderr summary.

Both run under `pnpm --filter @cpa/agents test` alongside the rest of the
package.
