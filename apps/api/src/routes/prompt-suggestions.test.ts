import { test, after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { signSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../app.js';
import { _internals } from './prompt-suggestions.js';
import { ChoreographyError } from '@cpa/integrations/github-app';
import type { ChoreographyOptions, ChoreographyResult } from '@cpa/integrations/github-app';
import type { PromptSuggestionEvaluation } from '@cpa/agents';

/**
 * P7 Theme B Task B.3 — prompt-suggestion route tests.
 *
 * Live-DB tests use the same fixture pattern as mapping-rules.test.ts:
 * seed two firms + a couple of users, exercise the routes via
 * `app.inject()`, then teardown.
 *
 * Per Task B.3 spec (Docker daemon unavailable in this worktree):
 * tests probe the connection in `before()` and skip the live-DB
 * branches if the probe fails, leaving the unit-level Zod / cursor /
 * state-machine assertions running unconditionally. The DB-gated
 * tests still run in CI where Postgres is available — same behaviour
 * as activities.test.ts and the rest of the suite.
 */

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

const TENANT_A = '00000000-0000-4000-8000-0000000b3001';
const TENANT_B = '00000000-0000-4000-8000-0000000b3002';
const ADMIN_USER = '00000000-0000-4000-8000-0000000b3010';
const VIEWER_USER = '00000000-0000-4000-8000-0000000b3011';
const CONSULTANT_USER = '00000000-0000-4000-8000-0000000b3012';
const CONSULTANT_USER_B = '00000000-0000-4000-8000-0000000b3013';

let dbAvailable = false;

const cleanup = async (): Promise<void> => {
  try {
    await privilegedSql`DELETE FROM prompt_suggestion_pr WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
    await privilegedSql`DELETE FROM prompt_suggestion_review WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
    await privilegedSql`DELETE FROM prompt_suggestion WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
    await privilegedSql`DELETE FROM tenant_user WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
    await sql`DELETE FROM "user" WHERE id IN (${ADMIN_USER}, ${VIEWER_USER}, ${CONSULTANT_USER}, ${CONSULTANT_USER_B})`;
    await sql`DELETE FROM tenant WHERE id IN (${TENANT_A}, ${TENANT_B})`;
  } catch {
    // ignore — DB unreachable, cleanup is a no-op.
  }
};

before(async () => {
  // Probe the DB. If it's reachable, do the full fixture seed; otherwise
  // mark dbAvailable=false and let DB-gated tests skip.
  try {
    await privilegedSql`SELECT 1`;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    return;
  }
  await cleanup();
  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT_A}, 'Firm PS-A', 'firm-ps-a', 'mixed'),
                   (${TENANT_B}, 'Firm PS-B', 'firm-ps-b', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${ADMIN_USER}, 'ps-admin@example.com', 'microsoft', 'microsoft:ps-admin', 'PS Admin'),
                   (${VIEWER_USER}, 'ps-viewer@example.com', 'microsoft', 'microsoft:ps-viewer', 'PS Viewer'),
                   (${CONSULTANT_USER}, 'ps-cons@example.com', 'microsoft', 'microsoft:ps-cons', 'PS Consultant'),
                   (${CONSULTANT_USER_B}, 'ps-cons-b@example.com', 'microsoft', 'microsoft:ps-cons-b', 'PS Consultant B')`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT_A}, ${ADMIN_USER}, 'admin', true),
                              (gen_random_uuid(), ${TENANT_A}, ${VIEWER_USER}, 'viewer', true),
                              (gen_random_uuid(), ${TENANT_A}, ${CONSULTANT_USER}, 'consultant', true),
                              (gen_random_uuid(), ${TENANT_B}, ${CONSULTANT_USER_B}, 'consultant', true)`;
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

const jwtFor = (
  userId: string,
  email: string,
  role: 'admin' | 'consultant' | 'viewer',
  tenantId: string = TENANT_A,
): Promise<string> =>
  signSession(
    {
      sub: userId,
      email,
      primaryIdp: 'microsoft',
      activeTenantId: tenantId,
      activeRole: role,
      availableTenants: [],
    },
    SESSION_SECRET,
    { ttlSeconds: 3600 },
  );

const adminJwt = (): Promise<string> => jwtFor(ADMIN_USER, 'ps-admin@example.com', 'admin');
const viewerJwt = (): Promise<string> => jwtFor(VIEWER_USER, 'ps-viewer@example.com', 'viewer');
const consultantJwt = (): Promise<string> =>
  jwtFor(CONSULTANT_USER, 'ps-cons@example.com', 'consultant');
const consultantBJwt = (): Promise<string> =>
  jwtFor(CONSULTANT_USER_B, 'ps-cons-b@example.com', 'consultant', TENANT_B);

const skipIfNoDb = (t: { skip: (msg?: string) => void }): boolean => {
  if (!dbAvailable) {
    t.skip('Postgres not reachable — DB-gated test skipped');
    return true;
  }
  return false;
};

const dummyFlag = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  source_kind: 'consultant_flag',
  source_payload: { reason: 'output looked off' },
  affected_prompt_module: 'narrative-drafter',
  affected_section_kind: 'new_knowledge',
  issue_summary: 'Hypothesis section conflated with new knowledge',
  ...overrides,
});

// ===========================================================================
// Unit-level tests — no DB required. Cover Zod schemas + cursor codec.
// ===========================================================================

describe('prompt-suggestions: Zod input schemas', () => {
  test('FlagSuggestionInput rejects unknown source_kind', () => {
    const r = _internals.FlagSuggestionInput.safeParse({
      source_kind: 'unknown_source',
      source_payload: {},
      issue_summary: 'this is a sufficiently long issue summary',
    });
    assert.equal(r.success, false);
  });

  test('FlagSuggestionInput rejects too-short issue_summary', () => {
    const r = _internals.FlagSuggestionInput.safeParse({
      source_kind: 'consultant_flag',
      source_payload: {},
      issue_summary: 'short',
    });
    assert.equal(r.success, false);
  });

  test('FlagSuggestionInput accepts a minimal valid body', () => {
    const r = _internals.FlagSuggestionInput.safeParse({
      source_kind: 'consultant_flag',
      source_payload: { reason: 'x' },
      issue_summary: 'this is a sufficiently long issue summary',
    });
    assert.equal(r.success, true);
  });

  test('FlagSuggestionInput rejects extra fields (strict)', () => {
    const r = _internals.FlagSuggestionInput.safeParse({
      source_kind: 'consultant_flag',
      source_payload: {},
      issue_summary: 'this is a sufficiently long issue summary',
      extra_field: 'nope',
    });
    assert.equal(r.success, false);
  });

  test('ListSuggestionsQuery defaults limit to 50 and coerces strings', () => {
    const r = _internals.ListSuggestionsQuery.safeParse({});
    assert.equal(r.success, true);
    assert.equal(r.success && r.data.limit, 50);
    const r2 = _internals.ListSuggestionsQuery.safeParse({ limit: '25' });
    assert.equal(r2.success, true);
    assert.equal(r2.success && r2.data.limit, 25);
  });

  test('ListSuggestionsQuery rejects limit > 100', () => {
    const r = _internals.ListSuggestionsQuery.safeParse({ limit: 101 });
    assert.equal(r.success, false);
  });

  test('ListSuggestionsQuery accepts status + source_kind filters', () => {
    const r = _internals.ListSuggestionsQuery.safeParse({
      status: 'open',
      source_kind: 'rif_event',
      limit: 10,
    });
    assert.equal(r.success, true);
  });

  test('TriageInput rejects status_after=open (cannot rewind)', () => {
    const r = _internals.TriageInput.safeParse({
      triage_classification: 'prompt_change',
      status_after: 'open',
    });
    assert.equal(r.success, false);
  });

  test('TriageInput accepts triaged + dismissed status_after', () => {
    const a = _internals.TriageInput.safeParse({
      triage_classification: 'prompt_change',
      status_after: 'triaged',
    });
    const b = _internals.TriageInput.safeParse({
      triage_classification: 'no_action_needed',
      status_after: 'dismissed',
    });
    assert.equal(a.success, true);
    assert.equal(b.success, true);
  });

  test('ReviewInput accepts all four dispositions', () => {
    for (const d of _internals.REVIEW_DISPOSITIONS) {
      const r = _internals.ReviewInput.safeParse({ disposition: d });
      assert.equal(r.success, true);
    }
  });

  test('ReviewInput rejects too-long notes', () => {
    const r = _internals.ReviewInput.safeParse({
      disposition: 'approve_for_pr',
      notes: 'x'.repeat(1001),
    });
    assert.equal(r.success, false);
  });
});

describe('prompt-suggestions: cursor codec', () => {
  test('encode → decode roundtrips', () => {
    const tuple = { flagged_at: '2025-04-01T00:00:00.000Z', id: 'abc' };
    const encoded = _internals.encodeCursor(tuple);
    const decoded = _internals.decodeCursor(encoded);
    assert.deepEqual(decoded, tuple);
  });

  test('decode returns null for malformed input', () => {
    assert.equal(_internals.decodeCursor('not-base64-json'), null);
    assert.equal(
      _internals.decodeCursor(Buffer.from('{"id":"x"}', 'utf8').toString('base64url')),
      null,
    );
    assert.equal(
      _internals.decodeCursor(
        Buffer.from('{"flagged_at":"not-a-date","id":"x"}', 'utf8').toString('base64url'),
      ),
      null,
    );
  });
});

// ===========================================================================
// HTTP / auth tests — buildApp() works without DB; auth gating runs
// before any SQL is touched, so these cases are DB-independent.
// ===========================================================================

describe('prompt-suggestions: auth gating (no DB)', () => {
  // Auth-gating tests don't exercise generate-pr's slow path, but they
  // DO need the routes registered. Provide a minimal stub deps bag so
  // buildApp() actually mounts the routes (post-Fix-1 the route layer
  // requires a runContractTest function).
  const stubDeps = (): {
    evaluate: () => Promise<PromptSuggestionEvaluation>;
    choreograph: () => Promise<ChoreographyResult>;
    runContractTest: () => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  } => ({
    evaluate: () => Promise.reject(new Error('stub: should not be called in auth-gating tests')),
    choreograph: () => Promise.reject(new Error('stub: should not be called in auth-gating tests')),
    runContractTest: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
  });

  test('POST /v1/suggestions: 401 without session', async () => {
    const app = buildApp({ promptSuggestions: stubDeps() });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/suggestions',
      payload: dummyFlag(),
    });
    assert.equal(res.statusCode, 401);
    await app.close();
  });

  test('GET /v1/suggestions: 401 without session', async () => {
    const app = buildApp({ promptSuggestions: stubDeps() });
    const res = await app.inject({ method: 'GET', url: '/v1/suggestions' });
    assert.equal(res.statusCode, 401);
    await app.close();
  });

  test('GET /v1/suggestions/:id: 401 without session', async () => {
    const app = buildApp({ promptSuggestions: stubDeps() });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/suggestions/00000000-0000-4000-8000-000000000001',
    });
    assert.equal(res.statusCode, 401);
    await app.close();
  });

  test('POST /v1/suggestions/:id/triage: 401 without session', async () => {
    const app = buildApp({ promptSuggestions: stubDeps() });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/suggestions/00000000-0000-4000-8000-000000000001/triage',
      payload: { triage_classification: 'prompt_change', status_after: 'triaged' },
    });
    assert.equal(res.statusCode, 401);
    await app.close();
  });

  test('POST /v1/suggestions/:id/review: 401 without session', async () => {
    const app = buildApp({ promptSuggestions: stubDeps() });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/suggestions/00000000-0000-4000-8000-000000000001/review',
      payload: { disposition: 'approve_for_pr' },
    });
    assert.equal(res.statusCode, 401);
    await app.close();
  });

  test('POST /v1/suggestions/:id/generate-pr: 401 without session', async () => {
    const app = buildApp({ promptSuggestions: stubDeps() });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/suggestions/00000000-0000-4000-8000-000000000001/generate-pr',
    });
    assert.equal(res.statusCode, 401);
    await app.close();
  });
});

// ===========================================================================
// DB-gated integration tests — exercise the full route + DB.
// ===========================================================================

/** Deps stub needed so buildApp() actually mounts the /v1/suggestions routes. */
const suggestionsStub = (): {
  evaluate: () => Promise<PromptSuggestionEvaluation>;
  choreograph: () => Promise<ChoreographyResult>;
  runContractTest: () => Promise<{ exitCode: number; stdout: string; stderr: string }>;
} => ({
  evaluate: () => Promise.reject(new Error('stub: not wired in DB-gated tests')),
  choreograph: () => Promise.reject(new Error('stub: not wired in DB-gated tests')),
  runContractTest: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
});
const buildAppWithSuggestions = () => buildApp({ promptSuggestions: suggestionsStub() });

describe('POST /v1/suggestions', () => {
  test('400 on invalid body (missing source_kind)', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildAppWithSuggestions();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/suggestions',
      cookies: { cpa_session: await consultantJwt() },
      payload: { source_payload: {}, issue_summary: 'x'.repeat(20) },
    });
    assert.equal(res.statusCode, 400);
    await app.close();
  });

  test('400 on issue_summary too short', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildAppWithSuggestions();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/suggestions',
      cookies: { cpa_session: await consultantJwt() },
      payload: { source_kind: 'consultant_flag', source_payload: {}, issue_summary: 'short' },
    });
    assert.equal(res.statusCode, 400);
    await app.close();
  });

  test('201 happy path — flag a suggestion', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildAppWithSuggestions();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/suggestions',
      cookies: { cpa_session: await consultantJwt() },
      payload: dummyFlag(),
    });
    assert.equal(res.statusCode, 201);
    const body = res.json<{
      suggestion: {
        id: string;
        tenant_id: string;
        status: string;
        flagged_by_user_id: string;
        source_kind: string;
      };
    }>();
    assert.equal(body.suggestion.tenant_id, TENANT_A);
    assert.equal(body.suggestion.status, 'open');
    assert.equal(body.suggestion.flagged_by_user_id, CONSULTANT_USER);
    assert.equal(body.suggestion.source_kind, 'consultant_flag');
    // Confirm the row landed.
    const rows = await privilegedSql<{ id: string }[]>`
      SELECT id FROM prompt_suggestion WHERE id = ${body.suggestion.id}
    `;
    assert.equal(rows.length, 1);
    await app.close();
  });

  test('201 with rif_event source_kind', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildAppWithSuggestions();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/suggestions',
      cookies: { cpa_session: await consultantJwt() },
      payload: dummyFlag({
        source_kind: 'rif_event',
        source_payload: { event_id: '00000000-0000-4000-8000-0000000b3901', kind: 'X' },
      }),
    });
    assert.equal(res.statusCode, 201);
    await app.close();
  });
});

describe('GET /v1/suggestions', () => {
  test('200 happy path — lists tenant rows only', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildAppWithSuggestions();

    // Seed two suggestions in firm A and one in firm B.
    const aRes1 = await app.inject({
      method: 'POST',
      url: '/v1/suggestions',
      cookies: { cpa_session: await consultantJwt() },
      payload: dummyFlag({ issue_summary: 'A1 issue summary that is long enough' }),
    });
    assert.equal(aRes1.statusCode, 201);

    const aRes2 = await app.inject({
      method: 'POST',
      url: '/v1/suggestions',
      cookies: { cpa_session: await consultantJwt() },
      payload: dummyFlag({
        source_kind: 'rif_event',
        issue_summary: 'A2 issue summary that is long enough',
      }),
    });
    assert.equal(aRes2.statusCode, 201);

    const bRes = await app.inject({
      method: 'POST',
      url: '/v1/suggestions',
      cookies: { cpa_session: await consultantBJwt() },
      payload: dummyFlag({ issue_summary: 'B1 issue summary that is long enough' }),
    });
    assert.equal(bRes.statusCode, 201);

    // Firm A consultant lists — should see only firm A rows.
    const listRes = await app.inject({
      method: 'GET',
      url: '/v1/suggestions',
      cookies: { cpa_session: await consultantJwt() },
    });
    assert.equal(listRes.statusCode, 200);
    const body = listRes.json<{
      suggestions: { id: string; tenant_id: string }[];
      next_cursor: string | null;
    }>();
    for (const item of body.suggestions) {
      assert.equal(item.tenant_id, TENANT_A);
    }
    // At least the two we just inserted.
    assert.ok(body.suggestions.length >= 2);

    await app.close();
  });

  test('200 with status filter narrows result set', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildAppWithSuggestions();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/suggestions?status=open',
      cookies: { cpa_session: await consultantJwt() },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{ suggestions: { status: string }[] }>();
    for (const item of body.suggestions) assert.equal(item.status, 'open');
    await app.close();
  });

  test('400 on invalid status filter', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildAppWithSuggestions();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/suggestions?status=not-a-real-status',
      cookies: { cpa_session: await consultantJwt() },
    });
    assert.equal(res.statusCode, 400);
    await app.close();
  });

  test('400 on malformed cursor', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildAppWithSuggestions();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/suggestions?cursor=not-a-real-cursor',
      cookies: { cpa_session: await consultantJwt() },
    });
    assert.equal(res.statusCode, 400);
    await app.close();
  });

  test('cursor pagination — limit=1 returns next_cursor', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildAppWithSuggestions();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/suggestions?limit=1',
      cookies: { cpa_session: await consultantJwt() },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{ suggestions: unknown[]; next_cursor: string | null }>();
    assert.equal(body.suggestions.length, 1);
    assert.notEqual(body.next_cursor, null);
    await app.close();
  });
});

describe('GET /v1/suggestions/:id', () => {
  test('400 on non-uuid id', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildAppWithSuggestions();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/suggestions/not-a-uuid',
      cookies: { cpa_session: await consultantJwt() },
    });
    assert.equal(res.statusCode, 400);
    await app.close();
  });

  test('404 for unknown id', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildAppWithSuggestions();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/suggestions/00000000-0000-4000-8000-000000000999',
      cookies: { cpa_session: await consultantJwt() },
    });
    assert.equal(res.statusCode, 404);
    await app.close();
  });

  test('200 with reviews:[] and pr:null on fresh suggestion', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildAppWithSuggestions();
    const flagRes = await app.inject({
      method: 'POST',
      url: '/v1/suggestions',
      cookies: { cpa_session: await consultantJwt() },
      payload: dummyFlag({ issue_summary: 'detail get test issue summary long' }),
    });
    const id = flagRes.json<{ suggestion: { id: string } }>().suggestion.id;

    const res = await app.inject({
      method: 'GET',
      url: `/v1/suggestions/${id}`,
      cookies: { cpa_session: await consultantJwt() },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{
      suggestion: { id: string };
      reviews: unknown[];
      pr: unknown;
    }>();
    assert.equal(body.suggestion.id, id);
    assert.deepEqual(body.reviews, []);
    assert.equal(body.pr, null);
    await app.close();
  });

  test('404 for cross-tenant id (RLS isolation)', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildAppWithSuggestions();
    // Firm B inserts a suggestion.
    const bRes = await app.inject({
      method: 'POST',
      url: '/v1/suggestions',
      cookies: { cpa_session: await consultantBJwt() },
      payload: dummyFlag({ issue_summary: 'firm B issue summary that is long enough' }),
    });
    const bId = bRes.json<{ suggestion: { id: string } }>().suggestion.id;
    // Firm A consultant tries to read it — should 404, not 200/403.
    const res = await app.inject({
      method: 'GET',
      url: `/v1/suggestions/${bId}`,
      cookies: { cpa_session: await consultantJwt() },
    });
    assert.equal(res.statusCode, 404);
    await app.close();
  });
});

describe('POST /v1/suggestions/:id/triage', () => {
  test('403 for viewer role', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildAppWithSuggestions();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/suggestions/00000000-0000-4000-8000-000000000001/triage',
      cookies: { cpa_session: await viewerJwt() },
      payload: { triage_classification: 'prompt_change', status_after: 'triaged' },
    });
    assert.equal(res.statusCode, 403);
    await app.close();
  });

  test('400 on invalid body', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildAppWithSuggestions();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/suggestions/00000000-0000-4000-8000-000000000001/triage',
      cookies: { cpa_session: await consultantJwt() },
      payload: { triage_classification: 'unknown_class', status_after: 'triaged' },
    });
    assert.equal(res.statusCode, 400);
    await app.close();
  });

  test('404 for unknown suggestion id', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildAppWithSuggestions();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/suggestions/00000000-0000-4000-8000-000000000999/triage',
      cookies: { cpa_session: await consultantJwt() },
      payload: { triage_classification: 'prompt_change', status_after: 'triaged' },
    });
    assert.equal(res.statusCode, 404);
    await app.close();
  });

  test('200 happy path — open → triaged', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildAppWithSuggestions();
    const flagRes = await app.inject({
      method: 'POST',
      url: '/v1/suggestions',
      cookies: { cpa_session: await consultantJwt() },
      payload: dummyFlag({ issue_summary: 'triage happy path issue summary long' }),
    });
    const id = flagRes.json<{ suggestion: { id: string } }>().suggestion.id;
    const res = await app.inject({
      method: 'POST',
      url: `/v1/suggestions/${id}/triage`,
      cookies: { cpa_session: await consultantJwt() },
      payload: {
        triage_classification: 'prompt_change',
        status_after: 'triaged',
        notes: 'looks like a prompt fix',
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{
      suggestion: { status: string; triage_classification: string; resolved_at: string | null };
    }>();
    assert.equal(body.suggestion.status, 'triaged');
    assert.equal(body.suggestion.triage_classification, 'prompt_change');
    assert.equal(body.suggestion.resolved_at, null);
    await app.close();
  });

  test('200 dismissal — open → dismissed populates resolved_at', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildAppWithSuggestions();
    const flagRes = await app.inject({
      method: 'POST',
      url: '/v1/suggestions',
      cookies: { cpa_session: await consultantJwt() },
      payload: dummyFlag({ issue_summary: 'triage dismissal path issue summary long' }),
    });
    const id = flagRes.json<{ suggestion: { id: string } }>().suggestion.id;
    const res = await app.inject({
      method: 'POST',
      url: `/v1/suggestions/${id}/triage`,
      cookies: { cpa_session: await consultantJwt() },
      payload: {
        triage_classification: 'no_action_needed',
        status_after: 'dismissed',
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{ suggestion: { status: string; resolved_at: string | null } }>();
    assert.equal(body.suggestion.status, 'dismissed');
    assert.notEqual(body.suggestion.resolved_at, null);
    await app.close();
  });

  test('409 on re-triage of already-triaged suggestion', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildAppWithSuggestions();
    const flagRes = await app.inject({
      method: 'POST',
      url: '/v1/suggestions',
      cookies: { cpa_session: await consultantJwt() },
      payload: dummyFlag({ issue_summary: 're-triage rejection issue summary long' }),
    });
    const id = flagRes.json<{ suggestion: { id: string } }>().suggestion.id;
    // First triage succeeds.
    await app.inject({
      method: 'POST',
      url: `/v1/suggestions/${id}/triage`,
      cookies: { cpa_session: await consultantJwt() },
      payload: { triage_classification: 'prompt_change', status_after: 'triaged' },
    });
    // Second triage: 409.
    const res = await app.inject({
      method: 'POST',
      url: `/v1/suggestions/${id}/triage`,
      cookies: { cpa_session: await consultantJwt() },
      payload: { triage_classification: 'schema_change', status_after: 'triaged' },
    });
    assert.equal(res.statusCode, 409);
    await app.close();
  });
});

describe('POST /v1/suggestions/:id/review', () => {
  test('403 for viewer role', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildAppWithSuggestions();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/suggestions/00000000-0000-4000-8000-000000000001/review',
      cookies: { cpa_session: await viewerJwt() },
      payload: { disposition: 'approve_for_pr' },
    });
    assert.equal(res.statusCode, 403);
    await app.close();
  });

  test('409 if suggestion is still open (not yet triaged)', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildAppWithSuggestions();
    const flagRes = await app.inject({
      method: 'POST',
      url: '/v1/suggestions',
      cookies: { cpa_session: await consultantJwt() },
      payload: dummyFlag({ issue_summary: 'review on open suggestion issue long' }),
    });
    const id = flagRes.json<{ suggestion: { id: string } }>().suggestion.id;
    const res = await app.inject({
      method: 'POST',
      url: `/v1/suggestions/${id}/review`,
      cookies: { cpa_session: await consultantJwt() },
      payload: { disposition: 'approve_for_pr' },
    });
    assert.equal(res.statusCode, 409);
    await app.close();
  });

  test('200 happy path — review row inserted, suggestion stays triaged on approve_for_pr', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildAppWithSuggestions();
    const flagRes = await app.inject({
      method: 'POST',
      url: '/v1/suggestions',
      cookies: { cpa_session: await consultantJwt() },
      payload: dummyFlag({ issue_summary: 'review approval happy path issue long' }),
    });
    const id = flagRes.json<{ suggestion: { id: string } }>().suggestion.id;
    await app.inject({
      method: 'POST',
      url: `/v1/suggestions/${id}/triage`,
      cookies: { cpa_session: await consultantJwt() },
      payload: { triage_classification: 'prompt_change', status_after: 'triaged' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/suggestions/${id}/review`,
      cookies: { cpa_session: await consultantJwt() },
      payload: { disposition: 'approve_for_pr', notes: 'looks good to me' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{
      review: { id: string; disposition: string; reviewer_user_id: string };
    }>();
    assert.equal(body.review.disposition, 'approve_for_pr');
    assert.equal(body.review.reviewer_user_id, CONSULTANT_USER);

    // Confirm suggestion is still 'triaged' (approve_for_pr does NOT
    // flip status; only generate-pr does).
    const detailRes = await app.inject({
      method: 'GET',
      url: `/v1/suggestions/${id}`,
      cookies: { cpa_session: await consultantJwt() },
    });
    const detail = detailRes.json<{ suggestion: { status: string }; reviews: unknown[] }>();
    assert.equal(detail.suggestion.status, 'triaged');
    assert.equal(detail.reviews.length, 1);
    await app.close();
  });

  test('200 dismissal review flips suggestion status to dismissed', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildAppWithSuggestions();
    const flagRes = await app.inject({
      method: 'POST',
      url: '/v1/suggestions',
      cookies: { cpa_session: await consultantJwt() },
      payload: dummyFlag({ issue_summary: 'review dismissal path issue long e' }),
    });
    const id = flagRes.json<{ suggestion: { id: string } }>().suggestion.id;
    await app.inject({
      method: 'POST',
      url: `/v1/suggestions/${id}/triage`,
      cookies: { cpa_session: await consultantJwt() },
      payload: { triage_classification: 'prompt_change', status_after: 'triaged' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/suggestions/${id}/review`,
      cookies: { cpa_session: await consultantJwt() },
      payload: { disposition: 'dismiss', notes: 'duplicate of #234' },
    });
    assert.equal(res.statusCode, 200);

    const detailRes = await app.inject({
      method: 'GET',
      url: `/v1/suggestions/${id}`,
      cookies: { cpa_session: await consultantJwt() },
    });
    const detail = detailRes.json<{ suggestion: { status: string; resolved_at: string | null } }>();
    assert.equal(detail.suggestion.status, 'dismissed');
    assert.notEqual(detail.suggestion.resolved_at, null);
    await app.close();
  });
});

describe('POST /v1/suggestions/:id/generate-pr', () => {
  // Task B.5 — full choreography path. The handler:
  //   1. validates auth + role + uuid shape (no DB hit)
  //   2. loads the suggestion (RLS-scoped) and 404s if missing
  //   3. 409s if status !== 'triaged'
  //   4. 503s if GitHub App env is missing
  //   5. calls the injected evaluator (B.4) to get a change set
  //   6. calls the injected choreography (B.5) to land branch + commit + PR
  //   7. persists prompt_suggestion_pr + flips parent to 'pr_drafted'
  //   8. returns 202 with PR info
  //
  // Tests inject mocks for both `evaluate` and `choreograph` via the
  // PromptSuggestionsRouteDeps seam (passed through `buildApp({ promptSuggestions })`).
  // No real GitHub or Anthropic calls.

  /** Stub evaluator that returns a deterministic minimal change set. */
  const fakeEvaluation = (suggestionId: string): PromptSuggestionEvaluation => ({
    suggestion_id: suggestionId,
    classification: 'prompt_change',
    files: [
      {
        path: 'packages/agents/src/classifier-expenditure/prompts/classify-expenditure@1.0.0.ts',
        change_kind: 'modify',
        rationale: 'Tighten the decision tree for borderline cases per the consultant flag.',
        diff_preview: '@@ tiny @@',
        newContent: 'export const SYSTEM_PROMPT = "x";\n',
      },
    ],
    cross_file_consistency_checks_run: ['ran subprocess tests'],
    rationale_summary:
      'Consultant flagged a misclassification; tightened the prompt decision tree.',
    prompt_version: '1.0.0',
    model: 'claude-opus-4-7',
  });

  const fakeChoreographyResult = (): ChoreographyResult => ({
    pr_number: 42,
    pr_url: 'https://github.com/aaron/cpa-platform/pull/42',
    branch_name: 'prompt-suggestion/abc12345',
    commit_sha: 'newcommitsha',
    changed_files: [
      {
        path: 'packages/agents/src/classifier-expenditure/prompts/classify-expenditure@1.0.0.ts',
        change_kind: 'modify',
      },
    ],
  });

  const happyDeps = (): {
    evaluate: (input: {
      suggestion: { id: string };
      repoRoot: string;
    }) => Promise<PromptSuggestionEvaluation>;
    choreograph: (opts: ChoreographyOptions) => Promise<ChoreographyResult>;
    runContractTest: () => Promise<{ exitCode: number; stdout: string; stderr: string }>;
    env: Record<string, string | undefined>;
  } => ({
    evaluate: ({ suggestion }) => Promise.resolve(fakeEvaluation(suggestion.id)),
    choreograph: () => Promise.resolve(fakeChoreographyResult()),
    runContractTest: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
    env: {
      GITHUB_APP_ID: 'test-app',
      GITHUB_APP_PRIVATE_KEY: 'test-private-key',
      GITHUB_APP_INSTALLATION_ID: 'test-install',
      GITHUB_APP_OWNER: 'aaron',
      GITHUB_APP_REPO: 'cpa-platform',
    },
  });

  // Helper: insert + triage a suggestion, return its id.
  const seedTriagedSuggestion = async (
    app: ReturnType<typeof buildApp>,
    summary: string,
  ): Promise<string> => {
    const flagRes = await app.inject({
      method: 'POST',
      url: '/v1/suggestions',
      cookies: { cpa_session: await consultantJwt() },
      payload: dummyFlag({ issue_summary: summary }),
    });
    const id = flagRes.json<{ suggestion: { id: string } }>().suggestion.id;
    await app.inject({
      method: 'POST',
      url: `/v1/suggestions/${id}/triage`,
      cookies: { cpa_session: await consultantJwt() },
      payload: { triage_classification: 'prompt_change', status_after: 'triaged' },
    });
    return id;
  };

  test('403 for viewer role (auth gate before any DB lookup)', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildApp({ promptSuggestions: happyDeps() });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/suggestions/00000000-0000-4000-8000-000000000001/generate-pr',
      cookies: { cpa_session: await viewerJwt() },
    });
    assert.equal(res.statusCode, 403);
    await app.close();
  });

  test('400 for non-uuid id', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildApp({ promptSuggestions: happyDeps() });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/suggestions/not-a-uuid/generate-pr',
      cookies: { cpa_session: await consultantJwt() },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json<{ error: string }>();
    assert.equal(body.error, 'invalid_id');
    await app.close();
  });

  test('404 for unknown suggestion id', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildApp({ promptSuggestions: happyDeps() });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/suggestions/00000000-0000-4000-8000-000000000999/generate-pr',
      cookies: { cpa_session: await consultantJwt() },
    });
    assert.equal(res.statusCode, 404);
    await app.close();
  });

  test('409 if suggestion is not in triaged status', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildApp({ promptSuggestions: happyDeps() });
    const flagRes = await app.inject({
      method: 'POST',
      url: '/v1/suggestions',
      cookies: { cpa_session: await consultantJwt() },
      payload: dummyFlag({ issue_summary: 'open status — generate-pr should 409 here' }),
    });
    const id = flagRes.json<{ suggestion: { id: string } }>().suggestion.id;
    // Status is 'open' — generate-pr requires 'triaged'.
    const res = await app.inject({
      method: 'POST',
      url: `/v1/suggestions/${id}/generate-pr`,
      cookies: { cpa_session: await consultantJwt() },
    });
    assert.equal(res.statusCode, 409);
    const body = res.json<{ error: string }>();
    assert.equal(body.error, 'invalid_state_transition');
    await app.close();
  });

  test('503 when GitHub App env vars are missing', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildApp({
      promptSuggestions: {
        evaluate: happyDeps().evaluate,
        choreograph: happyDeps().choreograph,
        runContractTest: happyDeps().runContractTest,
        // env intentionally missing the GitHub app vars
        env: {},
      },
    });
    const id = await seedTriagedSuggestion(app, 'env-missing scenario for generate-pr 503');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/suggestions/${id}/generate-pr`,
      cookies: { cpa_session: await consultantJwt() },
    });
    assert.equal(res.statusCode, 503);
    const body = res.json<{ error: string }>();
    assert.equal(body.error, 'github_app_not_configured');
    await app.close();
  });

  test('202 happy path — PR row persisted, suggestion flipped to pr_drafted (admin role)', async (t) => {
    if (skipIfNoDb(t)) return;
    const deps = happyDeps();
    const app = buildApp({ promptSuggestions: deps });
    const id = await seedTriagedSuggestion(app, 'happy path generate-pr issue summary');

    // Exercise as admin — generate-pr is allowed for admin and consultant.
    const res = await app.inject({
      method: 'POST',
      url: `/v1/suggestions/${id}/generate-pr`,
      cookies: { cpa_session: await adminJwt() },
    });
    assert.equal(res.statusCode, 202);
    const body = res.json<{
      pr: { github_pr_number: number; github_pr_url: string; branch_name: string };
      suggestion: { status: string; resolved_at: string | null };
    }>();
    assert.equal(body.pr.github_pr_number, 42);
    assert.match(body.pr.github_pr_url, /\/pull\/42$/);
    assert.equal(body.suggestion.status, 'pr_drafted');
    assert.notEqual(body.suggestion.resolved_at, null);

    // Confirm prompt_suggestion_pr row landed.
    const prRows = await privilegedSql<{ github_pr_number: number; suggestion_id: string }[]>`
      SELECT github_pr_number, suggestion_id
        FROM prompt_suggestion_pr
       WHERE suggestion_id = ${id}
    `;
    assert.equal(prRows.length, 1);
    assert.equal(prRows[0]?.github_pr_number, 42);

    await app.close();
  });

  test('202 — handler invokes evaluator with the loaded suggestion', async (t) => {
    if (skipIfNoDb(t)) return;
    let evaluatorCalledWith: { suggestionId?: string } = {};
    const deps = {
      ...happyDeps(),
      evaluate: (input: { suggestion: { id: string }; repoRoot: string }) => {
        evaluatorCalledWith = { suggestionId: input.suggestion.id };
        return Promise.resolve(fakeEvaluation(input.suggestion.id));
      },
    };
    const app = buildApp({ promptSuggestions: deps });
    const id = await seedTriagedSuggestion(app, 'evaluator-invocation issue summary text');

    await app.inject({
      method: 'POST',
      url: `/v1/suggestions/${id}/generate-pr`,
      cookies: { cpa_session: await consultantJwt() },
    });
    assert.equal(evaluatorCalledWith.suggestionId, id);
    await app.close();
  });

  test('202 — handler invokes choreography with reviewerUserId from session', async (t) => {
    if (skipIfNoDb(t)) return;
    let choreographyOpts: { reviewerUserId?: string } = {};
    const deps = {
      ...happyDeps(),
      choreograph: (opts: ChoreographyOptions) => {
        choreographyOpts = { reviewerUserId: opts.reviewerUserId };
        return Promise.resolve(fakeChoreographyResult());
      },
    };
    const app = buildApp({ promptSuggestions: deps });
    const id = await seedTriagedSuggestion(app, 'choreography reviewer id passthrough test');

    await app.inject({
      method: 'POST',
      url: `/v1/suggestions/${id}/generate-pr`,
      cookies: { cpa_session: await consultantJwt() },
    });
    // The session is consultantJwt() = CONSULTANT_USER.
    assert.equal(choreographyOpts.reviewerUserId, CONSULTANT_USER);
    await app.close();
  });

  test('502 when evaluator throws', async (t) => {
    if (skipIfNoDb(t)) return;
    const deps = {
      ...happyDeps(),
      evaluate: (): Promise<PromptSuggestionEvaluation> =>
        Promise.reject(new Error('Anthropic 500')),
    };
    const app = buildApp({ promptSuggestions: deps });
    const id = await seedTriagedSuggestion(app, 'evaluator-error generate-pr issue summary');

    const res = await app.inject({
      method: 'POST',
      url: `/v1/suggestions/${id}/generate-pr`,
      cookies: { cpa_session: await consultantJwt() },
    });
    assert.equal(res.statusCode, 502);
    const body = res.json<{ error: string }>();
    assert.equal(body.error, 'evaluator_failed');

    // Suggestion stays at 'triaged' — the evaluator failure is BEFORE
    // any state transition.
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/suggestions/${id}`,
      cookies: { cpa_session: await consultantJwt() },
    });
    const detailBody = detail.json<{ suggestion: { status: string } }>();
    assert.equal(detailBody.suggestion.status, 'triaged');

    await app.close();
  });

  test('422 when contract test fails — stage=contract_test, stdout/stderr in detail', async (t) => {
    if (skipIfNoDb(t)) return;
    const deps = {
      ...happyDeps(),
      choreograph: (): Promise<ChoreographyResult> =>
        Promise.reject(
          new ChoreographyError(
            'contract_test',
            { exitCode: 1, stdout: 'test foo: assertion failed', stderr: 'AssertionError' },
            'pr-choreography: contract test failed (exit 1)',
          ),
        ),
    };
    const app = buildApp({ promptSuggestions: deps });
    const id = await seedTriagedSuggestion(app, 'contract-test failure generate-pr issue ');

    const res = await app.inject({
      method: 'POST',
      url: `/v1/suggestions/${id}/generate-pr`,
      cookies: { cpa_session: await consultantJwt() },
    });
    assert.equal(res.statusCode, 422);
    const body = res.json<{
      error: string;
      stage: string;
      detail: { exitCode?: number; stdout?: string; stderr?: string };
    }>();
    assert.equal(body.error, 'contract_test_failed');
    assert.equal(body.stage, 'contract_test');
    assert.equal(body.detail.exitCode, 1);
    assert.match(body.detail.stdout ?? '', /assertion failed/);
    assert.match(body.detail.stderr ?? '', /AssertionError/);

    // Suggestion stays at 'triaged' — choreography failed before persist.
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/suggestions/${id}`,
      cookies: { cpa_session: await consultantJwt() },
    });
    const detailBody = detail.json<{ suggestion: { status: string } }>();
    assert.equal(detailBody.suggestion.status, 'triaged');

    await app.close();
  });

  test('502 when choreography fails at pr_create stage', async (t) => {
    if (skipIfNoDb(t)) return;
    const deps = {
      ...happyDeps(),
      choreograph: (): Promise<ChoreographyResult> =>
        Promise.reject(
          new ChoreographyError(
            'pr_create',
            { status: 502, body: 'Bad Gateway' },
            'pr-choreography: pulls.create failed',
          ),
        ),
    };
    const app = buildApp({ promptSuggestions: deps });
    const id = await seedTriagedSuggestion(app, 'pr_create failure generate-pr issue 502');

    const res = await app.inject({
      method: 'POST',
      url: `/v1/suggestions/${id}/generate-pr`,
      cookies: { cpa_session: await consultantJwt() },
    });
    assert.equal(res.statusCode, 502);
    const body = res.json<{ error: string; stage: string }>();
    assert.equal(body.error, 'github_upstream_failure');
    assert.equal(body.stage, 'pr_create');
    await app.close();
  });

  test('500 when choreography fails at unknown stage', async (t) => {
    if (skipIfNoDb(t)) return;
    const deps = {
      ...happyDeps(),
      choreograph: (): Promise<ChoreographyResult> =>
        Promise.reject(new ChoreographyError('tree', new Error('tree error'), 'tree failed')),
    };
    const app = buildApp({ promptSuggestions: deps });
    const id = await seedTriagedSuggestion(app, 'tree failure generate-pr issue summary 500');

    const res = await app.inject({
      method: 'POST',
      url: `/v1/suggestions/${id}/generate-pr`,
      cookies: { cpa_session: await consultantJwt() },
    });
    assert.equal(res.statusCode, 500);
    const body = res.json<{ error: string; stage: string }>();
    assert.equal(body.error, 'choreography_failed');
    assert.equal(body.stage, 'tree');
    await app.close();
  });
});
