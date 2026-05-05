import { test, after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../../app.js';
import { _internals } from './github.js';

/**
 * P7 Theme B Task B.6 — GitHub webhook receiver tests.
 *
 * Live-DB tests use the same fixture pattern as prompt-suggestions.test.ts:
 * seed a firm + a suggestion + a pr row, exercise POST /v1/webhooks/github
 * via `app.inject()`, then teardown.
 *
 * Per Task B.6 spec (and matching the rest of the suite): tests probe the
 * connection in `before()` and skip the live-DB branches if the probe
 * fails, leaving the unit-level HMAC / signature-header / payload-shape
 * assertions running unconditionally.
 */

const TENANT_A = '00000000-0000-4000-8000-0000000b6101';
const TENANT_B = '00000000-0000-4000-8000-0000000b6102';
const ADMIN_USER = '00000000-0000-4000-8000-0000000b6110';

const HMAC_SECRET = 'b6-github-webhook-secret-fixture';

let dbAvailable = false;

const cleanup = async (): Promise<void> => {
  try {
    await privilegedSql`DELETE FROM prompt_suggestion_pr WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
    await privilegedSql`DELETE FROM prompt_suggestion_review WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
    await privilegedSql`DELETE FROM prompt_suggestion WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
    await privilegedSql`DELETE FROM tenant_user WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
    await sql`DELETE FROM "user" WHERE id IN (${ADMIN_USER})`;
    await sql`DELETE FROM tenant WHERE id IN (${TENANT_A}, ${TENANT_B})`;
  } catch {
    // ignore — DB unreachable, cleanup is a no-op.
  }
};

before(async () => {
  process.env['GITHUB_WEBHOOK_SECRET'] = HMAC_SECRET;
  try {
    await privilegedSql`SELECT 1`;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    return;
  }
  await cleanup();
  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT_A}, 'Firm GH-A', 'firm-gh-a', 'mixed'),
                   (${TENANT_B}, 'Firm GH-B', 'firm-gh-b', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${ADMIN_USER}, 'gh-admin@example.com', 'microsoft', 'microsoft:gh-admin', 'GH Admin')`;
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

/**
 * Seed a triaged suggestion + a `pr_drafted` parent + a child PR row
 * for a given tenant. Returns the ids the test will reference. Each
 * call generates fresh UUIDs so a single test file can seed multiple
 * suggestions without colliding.
 */
const seedSuggestionWithPr = async (opts: {
  tenant_id: string;
  github_pr_number: number;
  parentStatus?: 'pr_drafted' | 'triaged';
  merged_at?: string | null;
}): Promise<{ suggestion_id: string; pr_id: string }> => {
  const suggestionId = crypto.randomUUID();
  const prId = crypto.randomUUID();
  await privilegedSql`
    INSERT INTO prompt_suggestion (
      tenant_id, id, flagged_by_user_id, source_kind, source_payload,
      issue_summary, status, triage_classification
    ) VALUES (
      ${opts.tenant_id}, ${suggestionId}, ${ADMIN_USER}, 'consultant_flag',
      ${'{}'}::jsonb,
      'B.6 webhook test seed', ${opts.parentStatus ?? 'pr_drafted'},
      'prompt_change'
    )
  `;
  await privilegedSql`
    INSERT INTO prompt_suggestion_pr (
      tenant_id, id, suggestion_id, github_pr_number, github_pr_url,
      branch_name, changed_files, merged_at
    ) VALUES (
      ${opts.tenant_id}, ${prId}, ${suggestionId},
      ${opts.github_pr_number}, ${'https://github.com/cpa/repo/pull/' + opts.github_pr_number},
      ${'cpa-bot/suggestion-' + suggestionId.slice(0, 8)},
      ${'[]'}::jsonb,
      ${opts.merged_at ?? null}::timestamptz
    )
  `;
  return { suggestion_id: suggestionId, pr_id: prId };
};

const sign = (body: string, secret = HMAC_SECRET): string =>
  'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

const closedMergedPayload = (prNumber: number): string =>
  JSON.stringify({
    action: 'closed',
    pull_request: {
      number: prNumber,
      merged: true,
      merged_at: '2026-05-04T13:30:00Z',
      merge_commit_sha: 'abc123deadbeef',
      state: 'closed',
      html_url: `https://github.com/cpa/repo/pull/${prNumber}`,
    },
    repository: { full_name: 'cpa/repo' },
    installation: { id: 12345 },
  });

const closedNotMergedPayload = (prNumber: number): string =>
  JSON.stringify({
    action: 'closed',
    pull_request: {
      number: prNumber,
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      state: 'closed',
      html_url: `https://github.com/cpa/repo/pull/${prNumber}`,
    },
    repository: { full_name: 'cpa/repo' },
    installation: { id: 12345 },
  });

// ===========================================================================
// Unit-level tests — no DB required.
// ===========================================================================

describe('parseSignatureHeader', () => {
  test('extracts hex digest after sha256= prefix', () => {
    const r = _internals.parseSignatureHeader('sha256=deadbeef');
    assert.equal(r, 'deadbeef');
  });
  test('returns null for missing header', () => {
    assert.equal(_internals.parseSignatureHeader(undefined), null);
  });
  test('returns null for non-prefixed header', () => {
    assert.equal(_internals.parseSignatureHeader('deadbeef'), null);
  });
  test('returns null for empty hex after prefix', () => {
    assert.equal(_internals.parseSignatureHeader('sha256='), null);
  });
});

describe('isPullRequestPayload', () => {
  test('accepts a well-shaped payload', () => {
    const ok = _internals.isPullRequestPayload({
      action: 'closed',
      pull_request: { number: 1, merged: true, merge_commit_sha: 'x', merged_at: 'x' },
    });
    assert.equal(ok, true);
  });
  test('rejects missing pull_request', () => {
    const ok = _internals.isPullRequestPayload({ action: 'closed' });
    assert.equal(ok, false);
  });
  test('rejects non-string action', () => {
    const ok = _internals.isPullRequestPayload({
      action: 1,
      pull_request: { number: 1, merged: true },
    });
    assert.equal(ok, false);
  });
  test('rejects non-numeric pull_request.number', () => {
    const ok = _internals.isPullRequestPayload({
      action: 'closed',
      pull_request: { number: '1', merged: true },
    });
    assert.equal(ok, false);
  });
  test('rejects non-boolean pull_request.merged', () => {
    const ok = _internals.isPullRequestPayload({
      action: 'closed',
      pull_request: { number: 1, merged: 'yes' },
    });
    assert.equal(ok, false);
  });
});

// ===========================================================================
// HMAC verification — exercised through app.inject() so we're testing the
// route's wiring, not just the underlying helper.
// ===========================================================================

test('webhook rejects 401 when X-Hub-Signature-256 missing', async () => {
  const app = buildApp();
  const body = closedMergedPayload(1);
  const res = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/github',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'pull_request',
    },
    payload: body,
  });
  assert.equal(res.statusCode, 401);
  const parsed = res.json<{ error: string }>();
  assert.equal(parsed.error, 'missing_signature');
  await app.close();
});

test('webhook rejects 401 when signature header is malformed (no sha256= prefix)', async () => {
  const app = buildApp();
  const body = closedMergedPayload(1);
  const res = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/github',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'pull_request',
      'x-hub-signature-256': 'deadbeef',
    },
    payload: body,
  });
  assert.equal(res.statusCode, 401);
  const parsed = res.json<{ error: string }>();
  assert.equal(parsed.error, 'missing_signature');
  await app.close();
});

test('webhook rejects 401 when HMAC does not match (wrong secret)', async () => {
  const app = buildApp();
  const body = closedMergedPayload(1);
  const res = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/github',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'pull_request',
      'x-hub-signature-256': sign(body, 'a-different-secret'),
    },
    payload: body,
  });
  assert.equal(res.statusCode, 401);
  const parsed = res.json<{ error: string }>();
  assert.equal(parsed.error, 'invalid_signature');
  await app.close();
});

test('webhook rejects 401 when signature length differs (timing-safe length check)', async () => {
  // Two buffers of different lengths would crash crypto.timingSafeEqual;
  // the helper guards by returning false. This test verifies the route
  // still 401s rather than 500ing.
  const app = buildApp();
  const body = closedMergedPayload(1);
  const res = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/github',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'pull_request',
      // sha256= prefix + a too-short hex string. The helper decodes
      // both sides via Buffer.from(..., 'hex') and length-mismatches
      // rather than crashing.
      'x-hub-signature-256': 'sha256=ab',
    },
    payload: body,
  });
  assert.equal(res.statusCode, 401);
  const parsed = res.json<{ error: string }>();
  assert.equal(parsed.error, 'invalid_signature');
  await app.close();
});

// ===========================================================================
// Event handling.
// ===========================================================================

test('webhook accepts and ignores non-pull_request events (push) with action=no-op', async () => {
  const app = buildApp();
  const body = JSON.stringify({ ref: 'refs/heads/main', commits: [] });
  const res = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/github',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'push',
      'x-hub-signature-256': sign(body),
    },
    payload: body,
  });
  assert.equal(res.statusCode, 200);
  const parsed = res.json<{ received: boolean; action: string }>();
  assert.equal(parsed.received, true);
  assert.equal(parsed.action, 'no-op');
  await app.close();
});

test('webhook 400s on malformed JSON after a valid signature', async () => {
  const app = buildApp();
  const body = '{not-valid-json';
  const res = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/github',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'pull_request',
      'x-hub-signature-256': sign(body),
    },
    payload: body,
  });
  assert.equal(res.statusCode, 400);
  const parsed = res.json<{ error: string }>();
  assert.equal(parsed.error, 'invalid_json');
  await app.close();
});

test('webhook treats pull_request.opened as no-op', async () => {
  const app = buildApp();
  const body = JSON.stringify({
    action: 'opened',
    pull_request: { number: 99, merged: false },
  });
  const res = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/github',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'pull_request',
      'x-hub-signature-256': sign(body),
    },
    payload: body,
  });
  assert.equal(res.statusCode, 200);
  const parsed = res.json<{ action: string }>();
  assert.equal(parsed.action, 'no-op');
  await app.close();
});

test('webhook 200s with action=unknown-pr when github_pr_number not in DB', async (t) => {
  if (skipIfNoDb(t)) return;
  const app = buildApp();
  // Use a number that no test seeds.
  const body = closedMergedPayload(987654);
  const res = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/github',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'pull_request',
      'x-hub-signature-256': sign(body),
    },
    payload: body,
  });
  assert.equal(res.statusCode, 200);
  const parsed = res.json<{ action: string }>();
  assert.equal(parsed.action, 'unknown-pr');
  await app.close();
});

test('pull_request.merged=true updates child + parent DB rows', async (t) => {
  if (skipIfNoDb(t)) return;
  const prNumber = 5001;
  const seeded = await seedSuggestionWithPr({
    tenant_id: TENANT_A,
    github_pr_number: prNumber,
  });
  const app = buildApp();
  const body = closedMergedPayload(prNumber);
  const res = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/github',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'pull_request',
      'x-hub-signature-256': sign(body),
    },
    payload: body,
  });
  assert.equal(res.statusCode, 200);
  const parsed = res.json<{ action: string }>();
  assert.equal(parsed.action, 'merged');

  const pr = await privilegedSql<{ merged_at: Date | null; merge_commit_sha: string | null }[]>`
    SELECT merged_at, merge_commit_sha FROM prompt_suggestion_pr WHERE id = ${seeded.pr_id}
  `;
  assert.ok(pr[0]?.merged_at);
  assert.equal(pr[0]?.merge_commit_sha, 'abc123deadbeef');

  const sug = await privilegedSql<{ status: string; resolved_at: Date | null }[]>`
    SELECT status, resolved_at FROM prompt_suggestion WHERE id = ${seeded.suggestion_id}
  `;
  assert.equal(sug[0]?.status, 'pr_merged');
  assert.ok(sug[0]?.resolved_at);
  await app.close();
});

test('pull_request.closed without merged flips parent status to dismissed', async (t) => {
  if (skipIfNoDb(t)) return;
  const prNumber = 5002;
  const seeded = await seedSuggestionWithPr({
    tenant_id: TENANT_A,
    github_pr_number: prNumber,
  });
  const app = buildApp();
  const body = closedNotMergedPayload(prNumber);
  const res = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/github',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'pull_request',
      'x-hub-signature-256': sign(body),
    },
    payload: body,
  });
  assert.equal(res.statusCode, 200);
  const parsed = res.json<{ action: string }>();
  assert.equal(parsed.action, 'dismissed');

  // Child PR row should NOT have merged_at set — there was no merge.
  const pr = await privilegedSql<{ merged_at: Date | null }[]>`
    SELECT merged_at FROM prompt_suggestion_pr WHERE id = ${seeded.pr_id}
  `;
  assert.equal(pr[0]?.merged_at, null);

  const sug = await privilegedSql<{ status: string; resolved_at: Date | null }[]>`
    SELECT status, resolved_at FROM prompt_suggestion WHERE id = ${seeded.suggestion_id}
  `;
  assert.equal(sug[0]?.status, 'dismissed');
  assert.ok(sug[0]?.resolved_at);
  await app.close();
});

test('idempotent on redelivery: second pull_request.merged returns already-merged', async (t) => {
  if (skipIfNoDb(t)) return;
  const prNumber = 5003;
  const seeded = await seedSuggestionWithPr({
    tenant_id: TENANT_A,
    github_pr_number: prNumber,
  });
  const app = buildApp();
  const body = closedMergedPayload(prNumber);
  const headers = {
    'content-type': 'application/json',
    'x-github-event': 'pull_request',
    'x-hub-signature-256': sign(body),
  };
  const first = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/github',
    headers,
    payload: body,
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json<{ action: string }>().action, 'merged');

  // Capture parent's resolved_at after first delivery — must be stable
  // across redelivery (no double-update).
  const sugAfterFirst = await privilegedSql<{ resolved_at: Date | null }[]>`
    SELECT resolved_at FROM prompt_suggestion WHERE id = ${seeded.suggestion_id}
  `;
  const firstResolvedAt = sugAfterFirst[0]?.resolved_at;
  assert.ok(firstResolvedAt);

  const second = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/github',
    headers,
    payload: body,
  });
  assert.equal(second.statusCode, 200);
  assert.equal(second.json<{ action: string }>().action, 'already-merged');

  // resolved_at must be unchanged across the redelivery — confirming we
  // didn't issue a second UPDATE.
  const sugAfterSecond = await privilegedSql<{ resolved_at: Date | null }[]>`
    SELECT resolved_at FROM prompt_suggestion WHERE id = ${seeded.suggestion_id}
  `;
  const secondResolvedAt = sugAfterSecond[0]?.resolved_at;
  assert.ok(secondResolvedAt);
  assert.equal(secondResolvedAt.getTime(), firstResolvedAt.getTime());
  await app.close();
});

test('cross-tenant safety: merge for tenant B PR does not touch tenant A rows', async (t) => {
  if (skipIfNoDb(t)) return;
  const prA = 5101;
  const prB = 5102;
  const seededA = await seedSuggestionWithPr({
    tenant_id: TENANT_A,
    github_pr_number: prA,
  });
  const seededB = await seedSuggestionWithPr({
    tenant_id: TENANT_B,
    github_pr_number: prB,
  });

  // Capture A's pre-state.
  const beforeA = await privilegedSql<{ status: string }[]>`
    SELECT status FROM prompt_suggestion WHERE id = ${seededA.suggestion_id}
  `;
  assert.equal(beforeA[0]?.status, 'pr_drafted');

  // Fire merge for B only.
  const app = buildApp();
  const body = closedMergedPayload(prB);
  const res = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/github',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'pull_request',
      'x-hub-signature-256': sign(body),
    },
    payload: body,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json<{ action: string }>().action, 'merged');

  // B should be merged; A should be untouched.
  const sugB = await privilegedSql<{ status: string }[]>`
    SELECT status FROM prompt_suggestion WHERE id = ${seededB.suggestion_id}
  `;
  assert.equal(sugB[0]?.status, 'pr_merged');

  const sugA = await privilegedSql<{ status: string; resolved_at: Date | null }[]>`
    SELECT status, resolved_at FROM prompt_suggestion WHERE id = ${seededA.suggestion_id}
  `;
  assert.equal(sugA[0]?.status, 'pr_drafted');
  assert.equal(sugA[0]?.resolved_at, null);
  await app.close();
});
