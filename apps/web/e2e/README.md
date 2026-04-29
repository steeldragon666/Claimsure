# E2E tests (Playwright)

This directory holds the Playwright end-to-end suite for `@cpa/web`
(the consultant portal). Specs run against a real dev API (port 3000) +
web (port 5173) — see `playwright.config.ts` for the full setup.

## Running

From the repo root:

```bash
pnpm --filter @cpa/web e2e        # headless Chromium
pnpm --filter @cpa/web e2e:ui     # Playwright UI mode
```

The config auto-starts both servers; pass `CI=1` to disable
`reuseExistingServer`.

## Skipped tests

Any `test.skip(...)` (or `test.describe.skip(...)`) committed to this
directory MUST have:

1. A specific reason in the test body (or a referenced TODO comment)
   that names the underlying problem — not a vague "flaky" or "broken".
2. A tracking mechanism — either an issue link or a re-test trigger
   condition (e.g. "re-test after migration X lands", "re-enable when
   B9 emission is wired up").
3. A re-test date or commit SHA — so a future engineer can verify
   whether the skip is still warranted.

### History — the "zombie skip" lesson

A9 (commit `f111458`) re-enabled `chain-verification.spec.ts`, which had
been skipped since 2026-04-27 with a TODO citing three canonicalisation
hypotheses. By the time A9 ran, all three hypotheses had been disproven
by unit tests — the actual root cause had been silently fixed in
commits `5a7eb82`, `6fbc9d8`, and `ebd4a52`, but the e2e was never
re-tried after those landed. The skip became a load-bearing monument
to a problem that no longer existed.

The lesson: a `test.skip` without a re-test trigger is technical debt
that masks regressions. Always pair the skip with a mechanism that
forces re-evaluation when the underlying fix lands — otherwise the
skip outlives the bug it was tracking and quietly hides whatever
breaks next in the same code path.
