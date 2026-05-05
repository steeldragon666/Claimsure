# CI Test Isolation Fix — Design

**Date:** 2026-05-05
**Author:** Aaron + Claude (brainstorming session)
**Status:** Approved (all 5 sections)
**Goal:** Eliminate flakes entirely from the `ci` workflow. Remove `nick-fields/retry@v3`. CI runs once, deterministic. Any future flake is a real bug to investigate, not absorb.

## Background

The `ci` workflow has carried a small set of intermittent flakes for several months, documented inline in `.github/workflows/ci.yml:81-100`:

- `findOrCreateUser` concurrent race (impl is correct; failure is a transient pg-pool scheduling artefact under load)
- `subject-tenants 201 + ACL row for consultant caller` (one-off CI noise on ~1 in 10 runs)
- `DELETE /v1/integrations/:provider: archives the row` (one-off CI noise on ~1 in 10 runs)
- `expenditure_line` cross-package state pollution (surfaced today via PR #32: 5 rows visible where 2 expected)

PRs #26 (cleanup) and #31 (`drainPendingClassifyJobs` + retry safety net) chipped at this debt but did not eliminate it. The `nick-fields/retry@v3 max_attempts=2` block currently masks residuals by re-running the test step on first failure.

**Root cause of today's `expenditure_line` flake**: `turbo run test` with default unlimited concurrency runs `@cpa/db:test` and `@cpa/api:test` simultaneously against the *same shared CI Postgres database*. Both packages write to `expenditure_line`. When `rls.test.ts:462` asserts `SELECT * FROM expenditure_line` returns exactly 2 rows (the seed it committed in its `before` hook), it sees 5 instead — three extra rows from concurrent `@cpa/api` test runs. Within a package, `tsx --test` runs sequentially, so cross-package parallelism is the only concurrent-write surface.

**Root cause of `findOrCreateUser` race**: The impl already handles two unique-violation paths (`ON CONFLICT (primary_idp, external_id)` + UPDATE-RETURNING fallback for `user_email_unique` cross-user collisions). The flake comes from `Promise.all([call1, call2])` going through pg-pool to the same DB connection or a recycled one, where pg-pool scheduling intermittently produces an outcome the impl doesn't anticipate. No code-level fix exists without a database-level serialization primitive.

## Architecture

Turbo's default *parallel-package* test execution is the structural cause of cross-package state pollution. Within a package, `tsx --test` already runs sequentially. Forcing turbo to run one package at a time eliminates the only concurrent execution surface — and the only documented residual flake (`findOrCreateUser` concurrent race) is *intentional* in-test concurrency that requires an impl-level fix.

**Two-PR delivery:**

```
                     Today                    +1 day              +1 week (after observation)
                       │                         │                         │
PR-A: Structural fix ──┘                         │                         │
  • turbo --concurrency=1                        │                         │
  • findOrCreateUser advisory-lock impl          │                         │
  • Loud retry warnings                          │                         │
                                                 │                         │
                       observation window ───────┘                         │
                       (≥5 PR runs, 0 retries triggered)                   │
                                                                           │
PR-B: Remove safety net ──────────────────────────────────────────────────┘
  • Delete nick-fields/retry@v3 wrapper
  • Set max_attempts:1 (implicitly — no retry block)
```

**Why this shape:**

- PR-A is **structurally complete** — after it lands, flakes should be impossible-by-design (cross-package pollution: gone via serialization; `findOrCreateUser` race: gone via advisory lock).
- PR-B is the **policy change** — once we have evidence (5+ green runs, no retry warnings) we make the contract official.
- Splitting them lets us *observe* whether structural changes worked before removing the safety net. This honors the elimination goal while pricing in real-world surprises.

**CI runtime impact:**

- PR-A adds ~5-7 min to each CI run (estimate; the 12 packages currently overlap; serializing them lengthens the critical path). Total CI ~22-25 min.
- PR-B is paperwork — no runtime change.

**Out of scope:**

- Per-package DB schemas (rejected — too much complexity for the same outcome).
- Per-test transactional rollback (rejected — doesn't fix cross-package pollution under READ COMMITTED isolation).
- Playwright e2e workflow — separate job, separate flake profile; this design only addresses the `ci` job.

## Components

### PR-A — Structural fix (3 components)

**1. `.github/workflows/ci.yml` line 107**

```diff
-      command: pnpm test
+      command: pnpm test -- --concurrency=1
```

Same change to the `e2e` job's test step (the e2e job already runs serially since it's a single-package Playwright suite, but explicit > implicit). Update the verbose comment block (lines 81-100) to note the new serialization model.

**2. `packages/auth/src/users.ts:68` — `findOrCreateUser` impl**

Wrap in `sql.begin` with an advisory transaction lock keyed on `(primaryIdp, externalId)`:

```ts
return await sql.begin(async (tx) => {
  // Serialize concurrent same-user calls at the DB layer. hashtext is
  // deterministic and 32-bit; collisions across different external_ids
  // are harmless (would just serialize unrelated calls; no correctness
  // impact). Lock auto-releases at tx commit/rollback.
  await tx`SELECT pg_advisory_xact_lock(hashtext(${`${input.primaryIdp}:${input.externalId}`}))`;

  // ... existing INSERT/ON CONFLICT + email-unique recovery logic, but
  // using `tx` instead of `sql`
});
```

**Why this is a real fix:**

- Only one tx per `(idp, external_id)` enters the critical section at a time.
- Eliminates the pg-pool scheduling artefact entirely (no two connections can be racing INSERTs for the same external_id).
- Different external_ids hash differently → still parallelize.
- Email-unique recovery branch is preserved (still needed for cross-user email collisions, which the lock can't prevent).

**Test addition**: Augment `users.test.ts:54` with `Promise.all([call×5])` (instead of just 2) to verify lock-based serialization holds under heavier concurrency. Add a separate `parallelize` test verifying different `external_id`s still produce different `user_id`s.

**3. CI retry observability — verify, don't enhance yet**

The existing `on_retry_command` (`ci.yml:108-111`) already emits `::warning::pnpm test failed on attempt 1; retrying.`. These show up as warnings on the PR check page. We rely on these being visible during the PR-A → PR-B observation window. If during observation we see retries triggered, that's our signal to investigate before PR-B ships.

No change to the retry block itself in PR-A. PR-B is what removes it.

### PR-B — Policy change (1 component)

**`.github/workflows/ci.yml`** — delete the `nick-fields/retry@v3` step wrapper:

```diff
-      - name: Test
-        uses: nick-fields/retry@v3
-        with:
-          timeout_minutes: 15
-          max_attempts: 2
-          retry_on: error
-          command: pnpm test -- --concurrency=1
-          on_retry_command: |
-            echo "::warning::pnpm test failed on attempt 1; retrying."
-            ...
+      - name: Test
+        run: pnpm test -- --concurrency=1
+        timeout-minutes: 15
```

Replace the lines 81-100 comment block with a brief "tests must pass deterministically; cross-package isolation is enforced by `--concurrency=1`" note.

Same edit to the e2e job.

## Data flow

### Flow A: Test execution timeline (the cross-package pollution fix)

**Pre-fix** (today):

```
turbo run test  (default --concurrency=∞, ~CPU-count parallelism)
│
├─ @cpa/db:test ─────── INSERTs into expenditure_line ─┐
│   tests passing                                       │ both packages
├─ @cpa/api:test ───── INSERTs into expenditure_line ──┤ writing to the
│   tests passing                                       │ same table at
└─ @cpa/auth:test ──── reads "user" table              ─┘ the same time
                       │
                       └─> rls.test.ts:462 sees 5 rows where it expected 2 → FAIL
                       └─> retry kicks in → maybe passes, maybe doesn't → red
```

**Post-fix** (PR-A, with `--concurrency=1`):

```
turbo run test --concurrency=1  (one package at a time)
│
├─ @cpa/db:test ─────── completes fully ──→ no temporal overlap
│   tests passing                          (next package starts after this one
│                                          is fully committed)
├─ @cpa/api:test ───── completes fully ──→ similarly
│
└─ @cpa/auth:test ──── completes fully
```

The "no temporal overlap" claim is the key property. Postgres state persists across the whole CI run, but no two packages are ever writing simultaneously, so `SELECT * FROM table` in one test sees only its own package's writes plus prior-package committed writes (deterministic, not racy).

### Flow B: Advisory-lock serialization for `findOrCreateUser`

When two concurrent OIDC logins for the same `(microsoft, oid:abc)` arrive:

```
Caller A                                  Caller B
│                                         │
│ BEGIN                                   │ BEGIN
│ SELECT pg_advisory_xact_lock(           │ SELECT pg_advisory_xact_lock(
│   hashtext('microsoft:oid:abc')) ─────→ │   hashtext('microsoft:oid:abc'))
│ ✓ acquired                              │ ⏸ blocks (waits on A's lock)
│                                         │
│ INSERT ... ON CONFLICT ─→ inserts new   │ ⏸ still waiting
│ RETURNING id=user_X                     │
│                                         │
│ COMMIT (releases lock) ──────────────→  │ ▶ acquires lock
│                                         │ INSERT ... ON CONFLICT ─→ ON CONFLICT branch
│                                         │ UPDATE last_login_at
│                                         │ RETURNING id=user_X (same!)
│                                         │ COMMIT
```

**Key property**: `assert.equal(a.id, b.id)` is now guaranteed by the lock, not by hopeful pg-pool scheduling. Different external_ids hash to different lock keys → still parallelize.

### Flow C: Observation-window signal flow (PR-A → PR-B gate)

```
PR-A merges to main
│
├─→ PR opened against main with PR-A merged
│   ├─ CI runs once (no retry, since --concurrency=1 should make it deterministic)
│   ├─ on success: green check, no retry warning
│   └─ on retry trigger: ::warning::pnpm test failed on attempt 1 surfaces
│       │
│       ├─ Click warning → see test name
│       ├─ Investigate: is this a new flake or a real bug?
│       └─ Block PR-B until resolved
│
├─→ ≥5 PRs land cleanly with zero retry warnings
│
└─→ PR-B (delete retry block) ships
```

**Failure path**: If the observation window surfaces a retry, do not proceed to PR-B. Investigate, fix structurally (or document why it's an acceptable residual), and re-start the observation window.

## Error handling

For this work, "error handling" maps to: **what happens when the design's assumptions don't hold in practice**. Five failure modes worth pre-thinking.

### 1. `--concurrency=1` doesn't fully fix the flake

**Symptom**: PR-A lands, but a test still flakes within a single package.

**Detection**: `nick-fields/retry@v3` is intentionally kept in PR-A; the `::warning::pnpm test failed on attempt 1` shows up on the PR check page.

**Response**:

- The observation gate (≥5 PRs with zero retries) already blocks PR-B.
- For each retry warning, capture the failing test name + run URL and either: (a) fix it structurally (preferred), or (b) document it as a known residual and re-evaluate whether "eliminate" is achievable without other architectural changes.

### 2. Advisory lock causes new issues

**Hash collisions** — `hashtext()` is 32-bit; two unrelated `external_id` values *could* collide and one would block on the other unnecessarily. **Impact**: zero correctness risk, only a tiny throughput penalty for the colliding pair. **Acceptance**: yes, harmless.

**Deadlocks** — `findOrCreateUser` is the only code that takes this advisory key. No other code path acquires it, so no AB/BA cycle is reachable. **Verification**: grep for `pg_advisory_xact_lock` to ensure single use site.

**Lock-not-released bug** — `pg_advisory_xact_lock` is `xact`-scoped: postgres releases it at COMMIT or ROLLBACK regardless of how the tx ends. There's no manual release. **Verification**: review impl to confirm the lock acquisition lives inside `sql.begin(...)`.

### 3. A test relies implicitly on parallel execution

**Symptom**: Some test passes today via timing accident (e.g., a test that races the order of two packages and currently wins). After serialization, that timing changes and the test fails.

**Detection**: PR-A's CI run reveals the failure during the post-fix sweep.

**Response**: The test is a latent bug — fix it. Examples of likely candidates: tests that assume "this row exists because another package's setup committed it" (unlikely but worth scanning).

### 4. PR ordering (RESOLVED)

PR #32 has merged (commit `c3cda43`) before PR-A is opened. No ordering constraint; this work proceeds independently.

### 5. Observation period reveals more flakes than expected

**Symptom**: ≥3 different tests retry across observation PRs, suggesting test debt is broader than just `findOrCreateUser`.

**Response**: Don't ship PR-B. Open a fresh design for "Phase 2 test isolation" — perhaps escalating to per-package DBs (the option we rejected at design-time). The retry mechanism stays as the safety net while we plan.

**Anti-pattern to avoid**: Shipping PR-B because "we said we would" despite signals that elimination isn't truly achieved. The contract is *deterministic*, not *deadline*.

## Testing

The fix touches three test surfaces: the `findOrCreateUser` impl change (unit + concurrency tests), the CI workflow change (verifiable only via running CI), and the observation-window protocol (a process, not code).

### 1. `findOrCreateUser` advisory-lock — automated tests

**Test file**: `packages/auth/src/users.test.ts`

**Existing test (line 54)** — leave as-is, it still passes:

```ts
test('findOrCreateUser: concurrent calls for same external_id resolve to same user', ...);
```

**New test 1** — *higher concurrency to exercise the lock under stress*:

```ts
test('findOrCreateUser: 5 concurrent same-external_id calls all resolve to same user', async () => {
  const RACE_ID = 'microsoft:test-t6-race-5x';
  try {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        findOrCreateUser({
          primaryIdp: 'microsoft',
          externalId: RACE_ID,
          email: 'race5@example.com',
          displayName: null,
        }),
      ),
    );
    const uniqueIds = new Set(results.map((r) => r.id));
    assert.equal(uniqueIds.size, 1, 'all 5 calls return same user_id');
  } finally {
    await sql`DELETE FROM "user" WHERE external_id = ${RACE_ID}`;
  }
});
```

**New test 2** — *verifies the lock doesn't over-serialize*:

```ts
test('findOrCreateUser: different external_ids parallelize (lock keys differ)', async () => {
  const results = await Promise.all([
    findOrCreateUser({
      primaryIdp: 'microsoft',
      externalId: 'parallel-test-A',
      email: 'a@example.com',
      displayName: null,
    }),
    findOrCreateUser({
      primaryIdp: 'microsoft',
      externalId: 'parallel-test-B',
      email: 'b@example.com',
      displayName: null,
    }),
  ]);
  try {
    assert.notEqual(results[0]!.id, results[1]!.id, 'different external_ids → different user_ids');
  } finally {
    await sql`DELETE FROM "user" WHERE external_id IN ('parallel-test-A', 'parallel-test-B')`;
  }
});
```

**Why these tests stay deterministic**: All three concurrency tests rely on the impl being race-free. With the advisory lock, race-freeness is enforced at the DB layer; without it, we depend on pg-pool scheduling (which is what flakes today).

### 2. CI workflow change — verifiable only by running CI

There is no good unit-test-shaped verification for `--concurrency=1`. The truth is: ship PR-A, observe ≥5 PRs, count retry warnings.

**Local verification** (helpful but not authoritative):

```bash
# Simulate CI's serialized run locally
pnpm test -- --concurrency=1
```

If this passes locally on a clean DB, that's a signal — but local DBs don't replay CI's exact race conditions. The real verification is in CI itself.

### 3. Observation window protocol

**Definition of "PR-B-ready"**:

1. PR-A merged to main.
2. ≥5 subsequent PRs land with `ci` job green on first attempt.
3. Zero `::warning::pnpm test failed on attempt 1; retrying.` annotations across those 5 PRs.

**How to count**: `gh run list --workflow=ci.yml --branch=main --limit 10 --json conclusion,headSha` plus inspecting individual run logs for the warning. PR-B's PR description should cite the 5 run URLs as evidence.

**If a single retry surfaces**: Reset the counter. Investigate that flake before continuing.

### 4. PR-B is paperwork — minimal testing

PR-B deletes the retry block and renames the comment. No new behavior — only a contract change. The test for PR-B is whether the next CI run after PR-B merges still goes green.

**Risk mitigation for PR-B**: Land it during a low-PR-traffic window so a surprise red doesn't block multiple in-flight PRs at once.

## Estimates

| Phase   | Effort | Calendar           |
| ------- | ------ | ------------------ |
| PR-A    | ~6h    | 1 day              |
| Observation window | passive  | ~3-5 days (depends on PR cadence) |
| PR-B    | ~1h    | 30 min once observation gate clears |
