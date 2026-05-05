# CI Test Isolation Implementation Plan (PR-A)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate cross-package test state pollution and `findOrCreateUser` concurrency flakes — the structural fix half of the test-isolation work. PR-B (delete `nick-fields/retry@v3`) is paperwork after the observation window and not part of this plan.

**Architecture:** Two structural changes:
1. `pg_advisory_xact_lock` keyed on `(primary_idp, external_id)` in `findOrCreateUser` — serializes concurrent same-user calls at the postgres layer, eliminating the pg-pool scheduling artefact.
2. `--concurrency=1` on turbo's test step in CI — eliminates cross-package state pollution by running one package at a time. Within a package, `tsx --test` already runs sequentially, so this fully removes concurrent DB writes against the shared CI postgres.

**Tech Stack:** TypeScript, postgres-js (`@cpa/db/client`), tsx test runner, turbo, GitHub Actions, postgres advisory locks.

**Design reference:** `docs/plans/2026-05-05-ci-test-isolation-design.md`

**Worktree / branch:** `C:\Users\Aaron\cpa-platform-worktrees\test-isolation` on `chore/test-isolation` branched from `origin/main`.

**Scope adjustment from design:** The design said "Same change to the e2e job's test step." Investigation revealed `ci.yml:185` runs `pnpm --filter @cpa/web exec playwright test` — Playwright directly, not turbo. The e2e job also uses its own postgres service per-job (lines 124-136), so it doesn't share DB state with the `ci` job. **The e2e job is not changed in PR-A.** Documented as a footnote in the comment-block update.

---

## Task 1: Add concurrency stress tests for `findOrCreateUser`

These are written *before* the impl change so the file diff for Task 2 is small and focused. Both new tests are expected to PASS without the lock (the impl is already mostly race-safe via `ON CONFLICT` + email-unique recovery), but they document the property the lock will enforce deterministically and exercise the lock under stress.

**Files:**
- Modify: `packages/auth/src/users.test.ts:75` (insert two new tests after line 75, before `'findOrCreateUser: bumps last_login_at on existing user'` at line 77)

### Step 1: Insert the 5x concurrent stress test

Open `packages/auth/src/users.test.ts`. After line 75 (closing brace of the existing `concurrent calls for same external_id` test) and before line 77 (the `bumps last_login_at` test), insert this block:

```ts
test('findOrCreateUser: 5 concurrent same-external_id calls all resolve to same user', async () => {
  // Higher-concurrency variant of the 2-call race test above. Exercises
  // the pg_advisory_xact_lock under heavier contention.
  const RACE_5X_EXTERNAL_ID = 'microsoft:test-t6-race-5x-oid';
  try {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        findOrCreateUser({
          primaryIdp: 'microsoft',
          externalId: RACE_5X_EXTERNAL_ID,
          email: 'race5x@example.com',
          displayName: null,
        }),
      ),
    );
    const uniqueIds = new Set(results.map((r) => r.id));
    assert.equal(uniqueIds.size, 1, 'all 5 calls return same user_id');
  } finally {
    await sql`DELETE FROM "user" WHERE external_id = ${RACE_5X_EXTERNAL_ID}`;
  }
});

test('findOrCreateUser: different external_ids parallelize (advisory lock keys differ)', async () => {
  // Verifies the advisory lock doesn't over-serialize: different
  // (primary_idp, external_id) pairs hash to different lock keys, so
  // concurrent logins for unrelated users still parallelize. We can't
  // measure parallelism in a unit test, but we CAN prove correctness
  // under different-key concurrency, which is the property the lock
  // claims to preserve.
  const PARALLEL_A = 'microsoft:test-t6-parallel-a-oid';
  const PARALLEL_B = 'microsoft:test-t6-parallel-b-oid';
  try {
    const results = await Promise.all([
      findOrCreateUser({
        primaryIdp: 'microsoft',
        externalId: PARALLEL_A,
        email: 'parallel-a@example.com',
        displayName: null,
      }),
      findOrCreateUser({
        primaryIdp: 'microsoft',
        externalId: PARALLEL_B,
        email: 'parallel-b@example.com',
        displayName: null,
      }),
    ]);
    assert.notEqual(results[0]!.id, results[1]!.id, 'different external_ids → different user_ids');
    assert.equal(results[0]!.externalId, PARALLEL_A);
    assert.equal(results[1]!.externalId, PARALLEL_B);
  } finally {
    await sql`DELETE FROM "user" WHERE external_id IN (${PARALLEL_A}, ${PARALLEL_B})`;
  }
});
```

### Step 2: Run the auth test suite to verify both new tests pass

```bash
cd C:/Users/Aaron/cpa-platform-worktrees/test-isolation
pnpm --filter @cpa/auth build
pnpm --filter @cpa/auth test
```

**Expected:**
- All existing tests pass.
- The two new tests pass (they should — the impl is already mostly race-safe).
- Total test count grows by 2.

If either new test fails on a clean local DB, **stop and investigate** — the test or impl may already be broken. Report findings before proceeding.

### Step 3: Run typecheck on the auth package

```bash
pnpm --filter @cpa/auth typecheck
```

**Expected:** Clean exit (no TS errors).

### Step 4: Commit the new tests

```bash
git add packages/auth/src/users.test.ts
git commit -m "test(auth): add 5x concurrency + parallelize tests for findOrCreateUser

Adds two tests that document the properties the upcoming pg_advisory_xact_lock
will enforce deterministically:
- 5 concurrent same-external_id calls all resolve to same user_id (stress)
- Concurrent calls with different external_ids return different user_ids
  (lock doesn't over-serialize)

Both tests pass against the existing impl thanks to ON CONFLICT + email-unique
recovery, but their behavior becomes deterministic (not pg-pool-dependent)
once the advisory lock lands in the next commit."
```

---

## Task 2: Wrap `findOrCreateUser` in `sql.begin` with `pg_advisory_xact_lock`

The structural fix. Tests from Task 1 must continue to pass.

**Files:**
- Modify: `packages/auth/src/users.ts:68-102`

### Step 1: Replace the `findOrCreateUser` impl

In `packages/auth/src/users.ts`, replace the existing function body (lines 68-102) with this version. Note: only the wrapping changes — the inner `INSERT/ON CONFLICT` and email-unique recovery logic is preserved verbatim, just using `tx` instead of `sql`.

```ts
export async function findOrCreateUser(input: FindOrCreateUserInput): Promise<UserRow> {
  return await sql.begin(async (tx) => {
    // Serialize concurrent same-user logins at the DB layer.
    //
    // hashtext() is deterministic and produces a 32-bit int. Collisions
    // across different (primary_idp, external_id) pairs are harmless: the
    // worst case is two unrelated logins serialize on the same lock key
    // momentarily — no correctness impact, only a tiny throughput penalty
    // for that pair.
    //
    // Why advisory lock instead of relying on ON CONFLICT alone: the
    // existing impl has TWO unique constraints to handle (primary_idp +
    // external_id, AND user_email_unique). Under pg-pool scheduling
    // pressure the email-unique recovery branch occasionally surfaces,
    // and intermittently the recovery query sees state that confuses it.
    // The advisory lock makes only ONE caller per (idp, external_id)
    // active at a time, eliminating the pg-pool-dependent timing entirely.
    //
    // pg_advisory_xact_lock is xact-scoped: postgres releases the lock
    // automatically at COMMIT or ROLLBACK. There is no manual release path.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`${input.primaryIdp}:${input.externalId}`}))`;

    const newId = crypto.randomUUID();
    try {
      const rows = await tx<UserRow[]>`
        INSERT INTO "user" (id, email, display_name, primary_idp, external_id, last_login_at)
        VALUES (${newId}, ${input.email}, ${input.displayName}, ${input.primaryIdp}, ${input.externalId}, NOW())
        ON CONFLICT (primary_idp, external_id) WHERE deleted_at IS NULL
        DO UPDATE SET last_login_at = NOW()
        RETURNING id, email, display_name AS "displayName", primary_idp AS "primaryIdp", external_id AS "externalId"
      `;
      if (!rows[0]) throw new Error('findOrCreateUser: INSERT/ON CONFLICT did not return a row');
      return rows[0];
    } catch (err) {
      if (!isEmailUniqueViolation(err)) throw err;
      // Lost the race on user_email_unique. The other concurrent caller's
      // row is already committed; UPDATE-RETURNING produces the same end
      // state as the lucky-path ON CONFLICT branch (bump last_login_at +
      // return row).
      const recovered = await tx<UserRow[]>`
        UPDATE "user"
           SET last_login_at = NOW()
         WHERE primary_idp = ${input.primaryIdp}
           AND external_id = ${input.externalId}
           AND deleted_at IS NULL
        RETURNING id, email, display_name AS "displayName", primary_idp AS "primaryIdp", external_id AS "externalId"
      `;
      if (!recovered[0]) {
        // No matching (primary_idp, external_id) row → the email collision
        // is between two DIFFERENT users, not a race. Real integrity
        // violation; re-throw the original error.
        throw err;
      }
      return recovered[0];
    }
  });
}
```

### Step 2: Update the JSDoc above `findOrCreateUser`

The existing JSDoc (lines 32-67) describes the race-safety reasoning but predates the advisory lock. Add a paragraph at the bottom of the JSDoc (just before the `export async function findOrCreateUser` line) noting the lock:

In `packages/auth/src/users.ts`, find the JSDoc comment ending at line 67 (`*/` just above `export async function`). Add this paragraph just before that closing `*/`:

```
 *
 * Concurrency: wrapped in `sql.begin` with `pg_advisory_xact_lock(hashtext(...))`
 * keyed on `(primary_idp, external_id)`. Concurrent same-user logins are
 * serialized at the DB layer, eliminating the pg-pool scheduling artefact
 * that previously caused intermittent flakes (see
 * docs/plans/2026-05-05-ci-test-isolation-design.md). Different external_ids
 * hash to different lock keys → still parallelize.
```

### Step 3: Run the auth test suite

```bash
pnpm --filter @cpa/auth build
pnpm --filter @cpa/auth test
```

**Expected:**
- All tests pass, including the existing `concurrent calls for same external_id`, the new `5 concurrent same-external_id`, the new `different external_ids parallelize`, and all surrounding tests (`creates new user`, `finds existing`, `bumps last_login_at`, etc.).
- No new test count change.

If anything fails: read the error carefully. The most likely cause is a syntax slip in the wrap (e.g., `tx` vs `sql` somewhere). Fix and re-run.

### Step 4: Run typecheck and lint

```bash
pnpm --filter @cpa/auth typecheck
pnpm --filter @cpa/auth lint
```

**Expected:** Clean exit on both.

### Step 5: Commit the impl change

```bash
git add packages/auth/src/users.ts
git commit -m "fix(auth): pg_advisory_xact_lock in findOrCreateUser to eliminate concurrent race

Wraps the INSERT/ON CONFLICT + email-unique recovery in sql.begin and
acquires pg_advisory_xact_lock(hashtext('idp:external_id')) at the start
of the transaction. Serializes concurrent same-user logins at the DB
layer, eliminating the pg-pool scheduling artefact that previously
caused the documented flake in ci.yml:84 ('findOrCreateUser concurrent
race').

Lock is xact-scoped — auto-released at COMMIT/ROLLBACK. Different
external_ids hash to different keys, so unrelated logins still
parallelize.

See docs/plans/2026-05-05-ci-test-isolation-design.md for full design."
```

---

## Task 3: Add `--concurrency=1` to CI test step

**Files:**
- Modify: `.github/workflows/ci.yml:107` (the `command:` field inside the `nick-fields/retry@v3` block)
- Modify: `.github/workflows/ci.yml:81-100` (the verbose comment block above the test step)

### Step 1: Change the test command to serialize across packages

In `.github/workflows/ci.yml`, find line 107:

```yaml
          command: pnpm test
```

Change to:

```yaml
          command: pnpm test -- --concurrency=1
```

The `--` separator is required because pnpm passes flags after `--` to the underlying script (turbo). Without it, `--concurrency=1` would be interpreted as a pnpm flag and rejected.

### Step 2: Replace the verbose comment block (lines 81-100)

The existing comment describes the retry mechanism as a "safety net for residual one-off transients" with no clean structural fix. Now we have a structural fix (serialization + advisory lock). Replace lines 81-100 with this updated block:

```yaml
      # Tests run with `turbo run test --concurrency=1` so packages execute
      # one at a time, eliminating cross-package state pollution against the
      # shared CI postgres service. Within a package, `tsx --test` runs
      # sequentially, so this is the only concurrent-write surface that
      # mattered.
      #
      # Previous structural flake sources, all addressed:
      #   - expenditure_line cross-package pollution: fixed by --concurrency=1
      #   - subject-tenants / integrations DELETE one-off noise: fixed by
      #     --concurrency=1 (was cross-package state racing same shared DB)
      #   - findOrCreateUser concurrent race: fixed by pg_advisory_xact_lock
      #     in packages/auth/src/users.ts
      #   - fire-and-forget enqueueExpenditureClassify: fixed by
      #     drainPendingClassifyJobs() in expenditures.test.ts:beforeEach
      #     (PR #31)
      #
      # nick-fields/retry@v3 stays in place for ONE observation window. PR-B
      # (separate follow-up) deletes this block after ≥5 PRs land green with
      # zero retry warnings. The contract after PR-B: tests must pass
      # deterministically on the first run; any future flake is a real bug
      # to investigate, not absorb.
      #
      # Note: the e2e job (below) uses Playwright directly with its own
      # postgres service, so it doesn't share the cross-package issue and
      # is not affected by --concurrency=1.
      #
      # See docs/plans/2026-05-05-ci-test-isolation-design.md for full
      # design and observation-window protocol.
```

### Step 3: Verify the YAML still parses

```bash
cd C:/Users/Aaron/cpa-platform-worktrees/test-isolation
node -e "console.log(require('yaml').parse(require('fs').readFileSync('.github/workflows/ci.yml','utf8')).jobs.ci.steps.find(s => s.name === 'Test'))"
```

If `yaml` isn't installed, alternative:

```bash
python -c "import yaml; print(yaml.safe_load(open('.github/workflows/ci.yml')))" | head -5
```

Or simplest — just visually verify the indentation matches the surrounding block by reading the file. The change should preserve the existing `- name: Test\n  uses: nick-fields/retry@v3\n  with:\n    timeout_minutes: ...` structure.

**Expected:** No parse error. The `command:` field shows the new value.

### Step 4: Commit the CI workflow change

```bash
git add .github/workflows/ci.yml
git commit -m "ci: serialize turbo test execution to eliminate cross-package DB pollution

Adds --concurrency=1 to the test command so turbo runs packages one at a
time. Removes the cross-package concurrent-write surface against the
shared CI postgres service.

Net CI runtime impact: estimated +5-7 minutes (12 packages now serialized
on the critical path instead of overlapping on ~CPU-count parallelism).

The verbose comment block above the test step is rewritten to document
the new contract: --concurrency=1 + pg_advisory_xact_lock are structural
fixes for the previously-documented flakes; nick-fields/retry@v3 stays
PROVISIONALLY for one observation window before PR-B deletes it.

See docs/plans/2026-05-05-ci-test-isolation-design.md for full design."
```

---

## Task 4: Local verification (no code change)

**Files:** none — this task is observation only.

### Step 1: Confirm postgres is running locally with the test schema

```bash
cd C:/Users/Aaron/cpa-platform-worktrees/test-isolation
docker ps --format '{{.Names}}: {{.Status}}' | grep -i postgres
```

If no postgres is running, start one matching the CI service:

```bash
docker run -d --rm --name cpa_test_pg -p 5432:5432 \
  -e POSTGRES_USER=cpa -e POSTGRES_PASSWORD=cpa -e POSTGRES_DB=cpa_dev \
  pgvector/pgvector:0.8.0-pg16
sleep 5
PGPASSWORD=cpa psql -h localhost -U cpa -d cpa_dev -f tools/postgres/init.sql
DATABASE_URL=postgres://cpa:cpa@localhost:5432/cpa_dev pnpm db:migrate
```

### Step 2: Run the full serialized test suite

```bash
DATABASE_URL=postgres://cpa:cpa@localhost:5432/cpa_dev \
DATABASE_URL_APP=postgres://cpa_app:cpa_app_dev_pwd@localhost:5432/cpa_dev \
SESSION_JWT_SECRET="ci-test-32-bytes-of-entropy-padd!" \
CLASSIFIER_IMPL=stub \
TOKEN_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
DOCUSIGN_WEBHOOK_HMAC_SECRET=ci-docusign-webhook-secret \
XERO_ACCOUNTING_CLIENT_ID=ci-test-client-id \
XERO_ACCOUNTING_CLIENT_SECRET=ci-test-client-secret \
XERO_ACCOUNTING_REDIRECT_URI=http://localhost:3000/v1/integrations/xero-accounting/callback \
XERO_IMPL=stub \
pnpm test -- --concurrency=1
```

**Expected:**
- Full test suite passes.
- Output shows packages running one at a time (look for "Running tasks" and notice they finish before the next starts, instead of overlapping).
- Total wall-clock time is longer than the default parallel run.

If any test fails: read the assertion carefully. If it's a test that *previously* relied on cross-package timing, that's the design's failure mode #3 (latent bug exposed by serialization). Fix that test before proceeding.

### Step 3: Note the wall-clock time for PR description

```bash
time DATABASE_URL=... [same env vars] pnpm test -- --concurrency=1
```

Record the `real` time for the PR description (so reviewers see the actual CI time impact, not just an estimate).

### Step 4: Push the branch and open PR-A

```bash
git push -u origin chore/test-isolation
```

Then open the PR via `gh pr create` with the body referencing the design doc and including the local timing data:

```bash
gh pr create --base main --title "chore(ci): structural test-isolation fix (PR-A)" --body "$(cat <<'EOF'
## Summary

PR-A of the two-PR test-isolation plan ([design](docs/plans/2026-05-05-ci-test-isolation-design.md)).

- **Cross-package pollution**: fixed by adding `--concurrency=1` to turbo's test command. Packages now run one at a time, removing the only concurrent-write surface against the shared CI postgres.
- **`findOrCreateUser` concurrent race**: fixed structurally by `pg_advisory_xact_lock(hashtext('idp:external_id'))` inside `sql.begin`. Serializes concurrent same-user logins at the DB layer.

## Local timing

Local serialized run: <FILL IN from Step 3 above>
Compared to default parallel: <FILL IN if you ran a baseline>

## Out of scope

- PR-B (delete `nick-fields/retry@v3`) — separate follow-up after observation window
- e2e job — uses Playwright directly + own postgres service, doesn't share cross-package issue

## Test plan

- [x] @cpa/auth tests all pass locally (incl. 2 new concurrency tests)
- [x] Typecheck + lint clean
- [x] Full `pnpm test -- --concurrency=1` passes locally
- [ ] CI green on first attempt
- [ ] No `::warning::pnpm test failed on attempt 1` on the CI run

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Total estimate

| Task | Effort |
| ---- | ------ |
| 1. Add stress tests | 15-20 min |
| 2. Wrap impl in advisory lock | 20-30 min |
| 3. CI workflow + comment block | 15 min |
| 4. Local verification + push + PR | 20-30 min |
| **PR-A total** | **~1.5 h** |

(The original 6h estimate baked in observation/iteration time. Pure implementation is closer to 1.5h.)

## Out-of-band: PR-B

Not part of this plan. After PR-A merges, observe the next ≥5 PRs for retry warnings (`gh run list --workflow=ci.yml --branch=main --limit 10 --json conclusion`). Once 5 consecutive runs land green with zero retry triggers, open PR-B as a single-commit branch:

```diff
-      - name: Test
-        uses: nick-fields/retry@v3
-        with:
-          timeout_minutes: 15
-          max_attempts: 2
-          retry_on: error
-          command: pnpm test -- --concurrency=1
-          on_retry_command: |
-            echo "::warning::..."
+      - name: Test
+        run: pnpm test -- --concurrency=1
+        timeout-minutes: 15
```

PR-B description should cite the 5 green run URLs as evidence the observation window cleared.
