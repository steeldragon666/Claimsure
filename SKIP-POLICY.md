# Test skip policy

Any `test.skip(...)`, `describe.skip(...)`, or `it.skip(...)` committed
to this repo MUST carry a comment that includes:

1. A specific reason in the test body (or a referenced TODO) — not
   a vague "flaky" or "broken".
2. A tracking mechanism — either an issue link or a re-test trigger
   condition (e.g. "re-test after migration X lands", "drop when
   EAS artefacts available").
3. A re-test date or commit SHA that anchors the skip in time so a
   future engineer can verify whether it's still warranted.

Applies to every test runner: node:test (apps/api, packages/\*),
Playwright (apps/web/e2e), and Detox (apps/mobile/e2e).

## The "zombie skip" lesson — A9 precedent (f111458)

A9 (commit `f111458`) re-enabled `apps/web/e2e/chain-verification.spec.ts`,
which had been skipped with a TODO citing three canonicalisation
hypotheses. By the time A9 ran, all three had been disproven by unit
tests — the root cause had been silently fixed in `5a7eb82`,
`6fbc9d8`, and `ebd4a52`, but the e2e was never re-tried. The skip
became a load-bearing monument to a problem that no longer existed.

The lesson: a `.skip` without a re-test trigger is technical debt
that masks regressions. Always pair the skip with a mechanism that
forces re-evaluation — otherwise it outlives the bug it was tracking
and quietly hides whatever breaks next in the same code path.
