import { test, after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sql, privilegedSql } from '@cpa/db/client';
import type { getGitHubAppHeaders } from '@cpa/integrations/github-app';
import { reconcilePromptSuggestionPrs } from './reconcile-prompt-suggestion-prs.js';

/**
 * P7 Theme B Task B.6 reconciler tests.
 *
 * Same DB-gating pattern as apps/api/src/routes/webhooks/github.test.ts:
 * probe Postgres in `before()`, skip live-DB tests if unreachable. The
 * reconciler is mostly an integration concern — its branching logic is
 * "does GitHub say merged? → flip locally" — so the tests focus on the
 * end-to-end flow with a stubbed `fetch`.
 */

const TENANT_A = '00000000-0000-4000-8000-0000000b6201';
const ADMIN_USER = '00000000-0000-4000-8000-0000000b6210';

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
    // ignore
  }
};

before(async () => {
  try {
    await privilegedSql`SELECT 1`;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    return;
  }
  await cleanup();
  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT_A}, 'Firm Recon-A', 'firm-recon-a', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${ADMIN_USER}, 'recon-admin@example.com', 'microsoft', 'microsoft:recon-admin', 'Recon Admin')`;
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

const FAKE_ENV = {
  GITHUB_APP_ID: '111',
  GITHUB_APP_PRIVATE_KEY: 'fake-priv-key',
  GITHUB_APP_INSTALLATION_ID: '222',
  GITHUB_APP_OWNER: 'cpa',
  GITHUB_APP_REPO: 'repo',
};

const FAKE_HEADERS = {
  Authorization: 'Bearer fake-installation-token',
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

// Typed as the same shape as the real `getGitHubAppHeaders` so the
// reconciler can accept it without any `as never` widening.
const stubGetHeaders: typeof getGitHubAppHeaders = () => Promise.resolve(FAKE_HEADERS);

/**
 * Build a fetch stub that returns canned PR-state JSON for whatever
 * `pulls/<num>` URL the reconciler asks about.
 *
 * The reconciler invokes fetch as `fetch(url, init)` with `url` as a
 * string — we type the stub narrowly to `(string, RequestInit?) =>
 * Promise<Response>` and cast to `typeof globalThis.fetch` at the call
 * site. That keeps the body free of unsafe-any operations on the
 * lib.dom RequestInfo union (which eslint flags as an `error`-typed
 * any-equivalent on this build).
 */
type FetchStub = (url: string, init?: RequestInit) => Promise<Response>;

const buildFetchStub = (
  prStates: Record<
    number,
    { merged: boolean; merged_at: string | null; merge_commit_sha: string | null }
  >,
): typeof globalThis.fetch => {
  const stub: FetchStub = (url) => {
    const m = url.match(/\/pulls\/(\d+)$/);
    if (!m) {
      return Promise.resolve(new Response('not found', { status: 404 }));
    }
    const num = Number(m[1]);
    const state = prStates[num];
    if (!state) {
      return Promise.resolve(
        new Response(JSON.stringify({ message: 'Not Found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          number: num,
          merged: state.merged,
          merged_at: state.merged_at,
          merge_commit_sha: state.merge_commit_sha,
          state: 'closed',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  };
  return stub as unknown as typeof globalThis.fetch;
};

const seedPr = async (opts: {
  github_pr_number: number;
  /** Offset in ms applied to created_at (negative = older than now). */
  ageMs: number;
  parentStatus?: 'pr_drafted' | 'triaged';
  merged_at?: string | null;
}): Promise<{ suggestion_id: string; pr_id: string }> => {
  const suggestionId = crypto.randomUUID();
  const prId = crypto.randomUUID();
  const createdAtMs = Date.now() + opts.ageMs;
  await privilegedSql`
    INSERT INTO prompt_suggestion (
      tenant_id, id, flagged_by_user_id, source_kind, source_payload,
      issue_summary, status, triage_classification
    ) VALUES (
      ${TENANT_A}, ${suggestionId}, ${ADMIN_USER}, 'consultant_flag',
      ${'{}'}::jsonb,
      'Reconciler test seed', ${opts.parentStatus ?? 'pr_drafted'},
      'prompt_change'
    )
  `;
  await privilegedSql`
    INSERT INTO prompt_suggestion_pr (
      tenant_id, id, suggestion_id, github_pr_number, github_pr_url,
      branch_name, changed_files, created_at, merged_at
    ) VALUES (
      ${TENANT_A}, ${prId}, ${suggestionId},
      ${opts.github_pr_number}, ${'https://github.com/cpa/repo/pull/' + opts.github_pr_number},
      ${'cpa-bot/recon-' + suggestionId.slice(0, 8)},
      ${'[]'}::jsonb,
      to_timestamp(${createdAtMs / 1000}),
      ${opts.merged_at ?? null}::timestamptz
    )
  `;
  return { suggestion_id: suggestionId, pr_id: prId };
};

// ===========================================================================
// Unit-level — no DB, no fixture: just verifies env-validation throws.
// ===========================================================================

describe('reconcilePromptSuggestionPrs: env validation', () => {
  test('throws when required env vars are missing', async () => {
    // Build a partial env bag that's deliberately missing required keys
    // and feed it through the same checked path the CLI uses. We type-
    // launder via a partial (PARTIAL_ENV) so this stays a runtime check
    // rather than a compile-time short-circuit.
    type ReconcilerEnvKey =
      | 'GITHUB_APP_ID'
      | 'GITHUB_APP_PRIVATE_KEY'
      | 'GITHUB_APP_INSTALLATION_ID'
      | 'GITHUB_APP_OWNER'
      | 'GITHUB_APP_REPO';
    const PARTIAL_ENV = { GITHUB_APP_ID: 'x' } as Partial<Record<ReconcilerEnvKey, string>> &
      Record<ReconcilerEnvKey, string>;
    await assert.rejects(
      () => reconcilePromptSuggestionPrs({ env: PARTIAL_ENV }),
      /missing required env vars/,
    );
  });
});

// ===========================================================================
// DB-gated.
// ===========================================================================

test('reconciler picks up an unmerged row whose GitHub state shows merged', async (t) => {
  if (skipIfNoDb(t)) return;
  // Seed an OLD unmerged row (created 10 min ago, past the 5-min grace window).
  const tenMinAgoMs = -10 * 60 * 1000;
  const seeded = await seedPr({ github_pr_number: 7001, ageMs: tenMinAgoMs });

  const fetchStub = buildFetchStub({
    7001: {
      merged: true,
      merged_at: '2026-05-04T13:30:00Z',
      merge_commit_sha: 'recon-sha-7001',
    },
  });

  const summary = await reconcilePromptSuggestionPrs({
    env: FAKE_ENV,
    fetch: fetchStub,
    getHeaders: stubGetHeaders,
  });

  assert.equal(summary.candidates >= 1, true);
  assert.equal(summary.reconciled >= 1, true);

  // Confirm DB state.
  const pr = await privilegedSql<{ merged_at: Date | null; merge_commit_sha: string | null }[]>`
    SELECT merged_at, merge_commit_sha FROM prompt_suggestion_pr WHERE id = ${seeded.pr_id}
  `;
  assert.ok(pr[0]?.merged_at);
  assert.equal(pr[0]?.merge_commit_sha, 'recon-sha-7001');

  const sug = await privilegedSql<{ status: string; resolved_at: Date | null }[]>`
    SELECT status, resolved_at FROM prompt_suggestion WHERE id = ${seeded.suggestion_id}
  `;
  assert.equal(sug[0]?.status, 'pr_merged');
  assert.ok(sug[0]?.resolved_at);
});

test('reconciler skips rows inside the grace window', async (t) => {
  if (skipIfNoDb(t)) return;
  // Seed a young row (created 1 min ago — well inside the 5-min window).
  const oneMinAgoMs = -60 * 1000;
  const seeded = await seedPr({ github_pr_number: 7002, ageMs: oneMinAgoMs });

  const fetchStub = buildFetchStub({
    7002: { merged: true, merged_at: '2026-05-04T13:30:00Z', merge_commit_sha: 's' },
  });

  const summary = await reconcilePromptSuggestionPrs({
    env: FAKE_ENV,
    fetch: fetchStub,
    getHeaders: stubGetHeaders,
  });

  // The young row must NOT be among candidates (the SQL filter excludes it).
  // Other tests in this file may have left rows behind, so we only check the
  // specific row we just seeded.
  const pr = await privilegedSql<{ merged_at: Date | null }[]>`
    SELECT merged_at FROM prompt_suggestion_pr WHERE id = ${seeded.pr_id}
  `;
  assert.equal(pr[0]?.merged_at, null);
  // And summary.reconciled count for THIS run shouldn't include our young row.
  // (We can't assert summary === 0 because another test's seed may also be
  // counted; but we CAN assert that our young row stayed unmerged.)
  assert.ok(summary); // reach a use site for `summary` so eslint doesn't complain
});

test('reconciler is idempotent — running twice does nothing on the second pass', async (t) => {
  if (skipIfNoDb(t)) return;
  const tenMinAgoMs = -10 * 60 * 1000;
  const seeded = await seedPr({ github_pr_number: 7003, ageMs: tenMinAgoMs });

  const fetchStub = buildFetchStub({
    7003: { merged: true, merged_at: '2026-05-04T14:00:00Z', merge_commit_sha: 'idem-sha' },
  });

  const first = await reconcilePromptSuggestionPrs({
    env: FAKE_ENV,
    fetch: fetchStub,
    getHeaders: stubGetHeaders,
  });
  // First pass should have flipped this row.
  assert.equal(first.reconciled >= 1, true);

  // Capture resolved_at for stability check.
  const sugAfterFirst = await privilegedSql<{ resolved_at: Date | null }[]>`
    SELECT resolved_at FROM prompt_suggestion WHERE id = ${seeded.suggestion_id}
  `;
  const firstResolvedAt = sugAfterFirst[0]?.resolved_at;
  assert.ok(firstResolvedAt);

  // Second pass: the row is now merged_at IS NOT NULL so the SQL filter
  // excludes it; this row should NOT appear among candidates again.
  const second = await reconcilePromptSuggestionPrs({
    env: FAKE_ENV,
    fetch: fetchStub,
    getHeaders: stubGetHeaders,
  });
  // We don't strictly assert second.candidates === 0 (other tests may still
  // have rows in the unreconciled queue). What we assert is that THIS
  // suggestion's resolved_at is unchanged.
  const sugAfterSecond = await privilegedSql<{ resolved_at: Date | null }[]>`
    SELECT resolved_at FROM prompt_suggestion WHERE id = ${seeded.suggestion_id}
  `;
  const secondResolvedAt = sugAfterSecond[0]?.resolved_at;
  assert.ok(secondResolvedAt);
  assert.equal(secondResolvedAt.getTime(), firstResolvedAt.getTime());
  assert.ok(second);
});

test('reconciler skips rows whose GitHub state is unmerged', async (t) => {
  if (skipIfNoDb(t)) return;
  const tenMinAgoMs = -10 * 60 * 1000;
  const seeded = await seedPr({ github_pr_number: 7004, ageMs: tenMinAgoMs });

  const fetchStub = buildFetchStub({
    7004: { merged: false, merged_at: null, merge_commit_sha: null },
  });

  const summary = await reconcilePromptSuggestionPrs({
    env: FAKE_ENV,
    fetch: fetchStub,
    getHeaders: stubGetHeaders,
  });
  assert.equal(summary.skipped_unmerged_on_github >= 1, true);

  // Row should remain unmerged in our DB.
  const pr = await privilegedSql<{ merged_at: Date | null }[]>`
    SELECT merged_at FROM prompt_suggestion_pr WHERE id = ${seeded.pr_id}
  `;
  assert.equal(pr[0]?.merged_at, null);
});
