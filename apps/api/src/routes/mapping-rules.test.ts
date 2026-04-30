import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { signSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../app.js';

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

const TENANT_A = '00000000-0000-4000-8000-0000000b9001';
const TENANT_B = '00000000-0000-4000-8000-0000000b9002';
const ADMIN_USER = '00000000-0000-4000-8000-0000000b9010';
const VIEWER_USER = '00000000-0000-4000-8000-0000000b9011';
const CONSULTANT_USER = '00000000-0000-4000-8000-0000000b9012';

// Two pre-seeded rules in firm A (priority order) + one in firm B
// for the cross-firm RLS positive control.
const RULE_A1 = '00000000-0000-4000-8000-0000000b9021';
const RULE_A2 = '00000000-0000-4000-8000-0000000b9022';
const RULE_B1 = '00000000-0000-4000-8000-0000000b9023';
// Activity ids referenced by rule actions. We don't need real activity
// rows — the engine only checks shape, and the DB column has no FK to
// activity (mapping rules carry their action as opaque jsonb).
const ACTIVITY_X = '00000000-0000-4000-8000-0000000b9091';
const ACTIVITY_Y = '00000000-0000-4000-8000-0000000b9092';

const cleanup = async (): Promise<void> => {
  await privilegedSql`DELETE FROM mapping_rule WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await sql`DELETE FROM "user" WHERE id IN (${ADMIN_USER}, ${VIEWER_USER}, ${CONSULTANT_USER})`;
  await sql`DELETE FROM tenant WHERE id IN (${TENANT_A}, ${TENANT_B})`;
};

before(async () => {
  await cleanup();
  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT_A}, 'Firm A', 'firm-a-b9', 'mixed'),
                   (${TENANT_B}, 'Firm B', 'firm-b-b9', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${ADMIN_USER}, 'b9-admin@example.com', 'microsoft', 'microsoft:b9-admin', 'B9 Admin'),
                   (${VIEWER_USER}, 'b9-viewer@example.com', 'microsoft', 'microsoft:b9-viewer', 'B9 Viewer'),
                   (${CONSULTANT_USER}, 'b9-cons@example.com', 'microsoft', 'microsoft:b9-cons', 'B9 Consultant')`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT_A}, ${ADMIN_USER}, 'admin', true),
                              (gen_random_uuid(), ${TENANT_A}, ${VIEWER_USER}, 'viewer', true),
                              (gen_random_uuid(), ${TENANT_A}, ${CONSULTANT_USER}, 'consultant', true)`;

  // Pre-seed two firm-A rules at priorities 10 and 20, plus one firm-B
  // rule the active session must NOT see (RLS positive control).
  await privilegedSql`
    INSERT INTO mapping_rule (
      tenant_id, id, name, priority, enabled, conditions, action, created_by_user_id
    ) VALUES
      (${TENANT_A}, ${RULE_A1}, 'Rule A1 (high priority)', 10, true,
       ${[]},
       ${{ type: 'flag_for_review', reason: 'pre-seeded A1' }},
       ${ADMIN_USER}),
      (${TENANT_A}, ${RULE_A2}, 'Rule A2 (low priority)', 20, true,
       ${[{ field: 'contact_name', op: 'contains', value: 'Acme', case_insensitive: true }]},
       ${{ type: 'map_to_activity', activity_id: ACTIVITY_X }},
       ${ADMIN_USER}),
      (${TENANT_B}, ${RULE_B1}, 'Rule B1 (cross-firm)', 5, true,
       ${[]},
       ${{ type: 'flag_for_review', reason: 'firm-B rule' }},
       ${ADMIN_USER})
  `;
});

after(async () => {
  await cleanup();
  await sql.end();
  await privilegedSql.end();
});

const jwtFor = (
  userId: string,
  email: string,
  role: 'admin' | 'consultant' | 'viewer',
): Promise<string> =>
  signSession(
    {
      sub: userId,
      email,
      primaryIdp: 'microsoft',
      activeTenantId: TENANT_A,
      activeRole: role,
      availableTenants: [],
    },
    SESSION_SECRET,
    { ttlSeconds: 3600 },
  );

const adminJwt = (): Promise<string> => jwtFor(ADMIN_USER, 'b9-admin@example.com', 'admin');
const viewerJwt = (): Promise<string> => jwtFor(VIEWER_USER, 'b9-viewer@example.com', 'viewer');
const consultantJwt = (): Promise<string> =>
  jwtFor(CONSULTANT_USER, 'b9-cons@example.com', 'consultant');

// ---------------------------------------------------------------------------
// POST /v1/mapping-rules
// ---------------------------------------------------------------------------

test('POST /v1/mapping-rules: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/mapping-rules',
    payload: {
      name: 'X',
      priority: 1,
      conditions: [],
      action: { type: 'flag_for_review', reason: 'r' },
    },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /v1/mapping-rules: 403 for viewer role', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/mapping-rules',
    cookies: { cpa_session: await viewerJwt() },
    payload: {
      name: 'X',
      priority: 1,
      conditions: [],
      action: { type: 'flag_for_review', reason: 'r' },
    },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('POST /v1/mapping-rules: 201 happy path with map_to_activity action', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/mapping-rules',
    cookies: { cpa_session: await consultantJwt() },
    payload: {
      name: 'New Rule',
      priority: 50,
      conditions: [
        { field: 'contact_name', op: 'eq', value: 'Vendor Inc' },
        { field: 'amount', op: 'gte', value: 100 },
      ],
      action: { type: 'map_to_activity', activity_id: ACTIVITY_X },
    },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json<{
    mapping_rule: {
      id: string;
      tenant_id: string;
      name: string;
      priority: number;
      enabled: boolean;
    };
  }>();
  assert.equal(body.mapping_rule.name, 'New Rule');
  assert.equal(body.mapping_rule.priority, 50);
  assert.equal(body.mapping_rule.tenant_id, TENANT_A);
  assert.equal(body.mapping_rule.enabled, true);
  // Confirm the row landed in the DB.
  const rows = await privilegedSql<{ id: string }[]>`
    SELECT id FROM mapping_rule WHERE id = ${body.mapping_rule.id}
  `;
  assert.equal(rows.length, 1);
  await privilegedSql`DELETE FROM mapping_rule WHERE id = ${body.mapping_rule.id}`;
  await app.close();
});

test('POST /v1/mapping-rules: 201 with apportion action summing to 100', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/mapping-rules',
    cookies: { cpa_session: await consultantJwt() },
    payload: {
      name: 'Apportion Rule',
      priority: 60,
      conditions: [],
      action: {
        type: 'apportion',
        allocations: [
          { activity_id: ACTIVITY_X, percentage: 60 },
          { activity_id: ACTIVITY_Y, percentage: 40 },
        ],
      },
    },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json<{ mapping_rule: { id: string } }>();
  await privilegedSql`DELETE FROM mapping_rule WHERE id = ${body.mapping_rule.id}`;
  await app.close();
});

test('POST /v1/mapping-rules: 400 on Zod failure (missing required field)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/mapping-rules',
    cookies: { cpa_session: await consultantJwt() },
    payload: { priority: 1, conditions: [], action: { type: 'flag_for_review', reason: 'r' } },
  });
  assert.equal(res.statusCode, 400);
  const body = res.json<{ error: string; message: string }>();
  assert.equal(body.error, 'invalid_body');
  // Zod surfaces the field-level message.
  assert.match(body.message, /name|Required/i);
  await app.close();
});

test('POST /v1/mapping-rules: 400 on negative priority', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/mapping-rules',
    cookies: { cpa_session: await consultantJwt() },
    payload: {
      name: 'Bad',
      priority: -1,
      conditions: [],
      action: { type: 'flag_for_review', reason: 'r' },
    },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /v1/mapping-rules: 400 on apportion sum != 100 (B8 InvalidRuleError)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/mapping-rules',
    cookies: { cpa_session: await consultantJwt() },
    payload: {
      name: 'Bad Apportion',
      priority: 70,
      conditions: [],
      action: {
        type: 'apportion',
        allocations: [
          { activity_id: ACTIVITY_X, percentage: 60 },
          { activity_id: ACTIVITY_Y, percentage: 27 }, // sum = 87, not 100
        ],
      },
    },
  });
  assert.equal(res.statusCode, 400);
  const body = res.json<{ error: string; message: string }>();
  assert.equal(body.error, 'invalid_rule');
  assert.match(body.message, /apportion percentages must sum to 100/i);
  await app.close();
});

test('POST /v1/mapping-rules: 400 on apportion with empty allocations', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/mapping-rules',
    cookies: { cpa_session: await consultantJwt() },
    payload: {
      name: 'Empty Apportion',
      priority: 71,
      conditions: [],
      action: { type: 'apportion', allocations: [] },
    },
  });
  // Zod's .min(1) on the allocations array catches this before B8 even runs.
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /v1/mapping-rules: 400 on inverted amount-between condition (B8 InvalidRuleError)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/mapping-rules',
    cookies: { cpa_session: await consultantJwt() },
    payload: {
      name: 'Inverted Range',
      priority: 72,
      conditions: [{ field: 'amount', op: 'between', value: [1000, 100] }],
      action: { type: 'map_to_activity', activity_id: ACTIVITY_X },
    },
  });
  // The dummy expenditure has amount=1, so the condition would never
  // match — but B8 validates the range eagerly when evaluating.
  assert.equal(res.statusCode, 400);
  const body = res.json<{ error: string; message: string }>();
  assert.equal(body.error, 'invalid_rule');
  assert.match(body.message, /amount between range is inverted/i);
  await app.close();
});

test('POST /v1/mapping-rules: 400 on unknown action type (Zod)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/mapping-rules',
    cookies: { cpa_session: await consultantJwt() },
    payload: {
      name: 'Unknown Action',
      priority: 73,
      conditions: [],
      action: { type: 'do_something_weird', value: 1 },
    },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /v1/mapping-rules: 400 on unknown condition field (Zod)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/mapping-rules',
    cookies: { cpa_session: await consultantJwt() },
    payload: {
      name: 'Unknown Field',
      priority: 74,
      conditions: [{ field: 'foo', op: 'eq', value: 'bar' }],
      action: { type: 'map_to_activity', activity_id: ACTIVITY_X },
    },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /v1/mapping-rules: 201 with empty conditions (catch-all rule)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/mapping-rules',
    cookies: { cpa_session: await adminJwt() },
    payload: {
      name: 'Catch-all',
      priority: 9999,
      conditions: [],
      action: { type: 'flag_for_review', reason: 'unmatched expenditure' },
    },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json<{ mapping_rule: { id: string } }>();
  await privilegedSql`DELETE FROM mapping_rule WHERE id = ${body.mapping_rule.id}`;
  await app.close();
});

// ---------------------------------------------------------------------------
// GET /v1/mapping-rules (list)
// ---------------------------------------------------------------------------

test('GET /v1/mapping-rules: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/v1/mapping-rules' });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('GET /v1/mapping-rules: 200 returns firm A rules in priority order', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/mapping-rules',
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    mapping_rules: Array<{ id: string; tenant_id: string; priority: number }>;
    next_cursor: string | null;
  }>();
  // We pre-seeded two firm-A rules; tests that create rules clean up
  // immediately, so the seed pair is the stable subset.
  const seedRules = body.mapping_rules.filter((r) => r.id === RULE_A1 || r.id === RULE_A2);
  assert.equal(seedRules.length, 2);
  // Ascending priority — RULE_A1 (10) before RULE_A2 (20).
  const a1Idx = seedRules.findIndex((r) => r.id === RULE_A1);
  const a2Idx = seedRules.findIndex((r) => r.id === RULE_A2);
  assert.ok(a1Idx < a2Idx, 'RULE_A1 should come before RULE_A2');
  // Cross-firm positive control: the firm-B rule is NOT in the result.
  assert.ok(!body.mapping_rules.some((r) => r.id === RULE_B1));
  // Every returned row's tenant_id is firm A's.
  assert.ok(body.mapping_rules.every((r) => r.tenant_id === TENANT_A));
  await app.close();
});

test('GET /v1/mapping-rules: viewer role can list', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/mapping-rules',
    cookies: { cpa_session: await viewerJwt() },
  });
  assert.equal(res.statusCode, 200);
  await app.close();
});

test('GET /v1/mapping-rules: cursor pagination roundtrip', async () => {
  const app = buildApp();
  // Page 1 with limit=1 forces a next_cursor since we have 2+ seed rules.
  const page1 = await app.inject({
    method: 'GET',
    url: '/v1/mapping-rules?limit=1',
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(page1.statusCode, 200);
  const body1 = page1.json<{
    mapping_rules: Array<{ id: string; priority: number }>;
    next_cursor: string | null;
  }>();
  assert.equal(body1.mapping_rules.length, 1);
  assert.ok(body1.next_cursor !== null, 'expected a next_cursor on page 1');

  // Page 2 should NOT include the page-1 row.
  const page2 = await app.inject({
    method: 'GET',
    url: `/v1/mapping-rules?limit=1&cursor=${encodeURIComponent(body1.next_cursor)}`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(page2.statusCode, 200);
  const body2 = page2.json<{ mapping_rules: Array<{ id: string }> }>();
  assert.equal(body2.mapping_rules.length, 1);
  assert.notEqual(body2.mapping_rules[0]!.id, body1.mapping_rules[0]!.id);
  await app.close();
});

test('GET /v1/mapping-rules: 400 on malformed cursor', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/mapping-rules?cursor=not-base64-json',
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 400);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'invalid_cursor');
  await app.close();
});

test('GET /v1/mapping-rules?enabled=false: filters out enabled rules', async () => {
  // Soft-archive RULE_A2 then re-enable in a `finally`.
  await privilegedSql`UPDATE mapping_rule SET enabled = false WHERE id = ${RULE_A2}`;
  try {
    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/mapping-rules?enabled=false',
      cookies: { cpa_session: await adminJwt() },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{ mapping_rules: Array<{ id: string; enabled: boolean }> }>();
    assert.ok(body.mapping_rules.some((r) => r.id === RULE_A2));
    assert.ok(body.mapping_rules.every((r) => r.enabled === false));
    await app.close();
  } finally {
    await privilegedSql`UPDATE mapping_rule SET enabled = true WHERE id = ${RULE_A2}`;
  }
});

// ---------------------------------------------------------------------------
// GET /v1/mapping-rules/:id
// ---------------------------------------------------------------------------

test('GET /v1/mapping-rules/:id: 200 happy', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/mapping-rules/${RULE_A1}`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ mapping_rule: { id: string; name: string; priority: number } }>();
  assert.equal(body.mapping_rule.id, RULE_A1);
  assert.equal(body.mapping_rule.priority, 10);
  await app.close();
});

test('GET /v1/mapping-rules/:id: 404 cross-firm', async () => {
  // The firm-B rule id is real but invisible to a firm-A session.
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/mapping-rules/${RULE_B1}`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 404);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'mapping_rule_not_found');
  await app.close();
});

test('GET /v1/mapping-rules/:id: 404 unknown id', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/mapping-rules/00000000-0000-4000-8000-000000abcdef',
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

// ---------------------------------------------------------------------------
// PATCH /v1/mapping-rules/:id
// ---------------------------------------------------------------------------

test('PATCH /v1/mapping-rules/:id: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/mapping-rules/${RULE_A1}`,
    payload: { priority: 11 },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('PATCH /v1/mapping-rules/:id: 403 for viewer', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/mapping-rules/${RULE_A1}`,
    cookies: { cpa_session: await viewerJwt() },
    payload: { priority: 11 },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('PATCH /v1/mapping-rules/:id: 200 happy + preserves unspecified fields', async () => {
  // Insert a fresh rule for this test so we don't perturb the seed.
  const RULE_TMP = '00000000-0000-4000-8000-0000000b9051';
  await privilegedSql`
    INSERT INTO mapping_rule (
      tenant_id, id, name, priority, enabled, conditions, action, created_by_user_id
    ) VALUES (
      ${TENANT_A}, ${RULE_TMP}, 'Patch Target', 100, true,
      ${[{ field: 'currency', op: 'eq', value: 'AUD' }]},
      ${{ type: 'flag_for_review', reason: 'orig' }},
      ${ADMIN_USER}
    )
  `;
  try {
    const app = buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/mapping-rules/${RULE_TMP}`,
      cookies: { cpa_session: await consultantJwt() },
      payload: { priority: 99 },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{
      mapping_rule: { id: string; name: string; priority: number; conditions: unknown[] };
    }>();
    assert.equal(body.mapping_rule.priority, 99);
    // Name preserved.
    assert.equal(body.mapping_rule.name, 'Patch Target');
    // Conditions preserved.
    assert.equal(body.mapping_rule.conditions.length, 1);
    await app.close();
  } finally {
    await privilegedSql`DELETE FROM mapping_rule WHERE id = ${RULE_TMP}`;
  }
});

test('PATCH /v1/mapping-rules/:id: 400 on empty patch', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/mapping-rules/${RULE_A1}`,
    cookies: { cpa_session: await consultantJwt() },
    payload: {},
  });
  assert.equal(res.statusCode, 400);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'empty_patch');
  await app.close();
});

test('PATCH /v1/mapping-rules/:id: 400 when patch makes apportion sum != 100', async () => {
  // RULE_A2 starts as map_to_activity. Patching to a malformed apportion
  // should fail at B8 validation, NOT at apply time.
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/mapping-rules/${RULE_A2}`,
    cookies: { cpa_session: await consultantJwt() },
    payload: {
      action: {
        type: 'apportion',
        allocations: [
          { activity_id: ACTIVITY_X, percentage: 50 },
          { activity_id: ACTIVITY_Y, percentage: 30 }, // sum = 80
        ],
      },
    },
  });
  assert.equal(res.statusCode, 400);
  const body = res.json<{ error: string; message: string }>();
  assert.equal(body.error, 'invalid_rule');
  assert.match(body.message, /apportion percentages must sum to 100/i);
  // Original action preserved.
  const rows = await privilegedSql<{ action: { type: string } }[]>`
    SELECT action FROM mapping_rule WHERE id = ${RULE_A2}
  `;
  assert.equal(rows[0]!.action.type, 'map_to_activity');
  await app.close();
});

test('PATCH /v1/mapping-rules/:id: 404 cross-firm', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/mapping-rules/${RULE_B1}`,
    cookies: { cpa_session: await adminJwt() },
    payload: { priority: 99 },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('PATCH /v1/mapping-rules/:id: 200 lets admin update conditions + action together', async () => {
  const RULE_TMP = '00000000-0000-4000-8000-0000000b9052';
  await privilegedSql`
    INSERT INTO mapping_rule (
      tenant_id, id, name, priority, enabled, conditions, action, created_by_user_id
    ) VALUES (
      ${TENANT_A}, ${RULE_TMP}, 'Combo Patch', 100, true,
      ${[]},
      ${{ type: 'flag_for_review', reason: 'orig' }},
      ${ADMIN_USER}
    )
  `;
  try {
    const app = buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/mapping-rules/${RULE_TMP}`,
      cookies: { cpa_session: await adminJwt() },
      payload: {
        conditions: [{ field: 'kind', op: 'eq', value: 'INVOICE' }],
        action: { type: 'map_to_activity', activity_id: ACTIVITY_X },
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{
      mapping_rule: { conditions: unknown[]; action: { type: string; activity_id?: string } };
    }>();
    assert.equal(body.mapping_rule.conditions.length, 1);
    assert.equal(body.mapping_rule.action.type, 'map_to_activity');
    assert.equal(body.mapping_rule.action.activity_id, ACTIVITY_X);
    await app.close();
  } finally {
    await privilegedSql`DELETE FROM mapping_rule WHERE id = ${RULE_TMP}`;
  }
});

// ---------------------------------------------------------------------------
// DELETE /v1/mapping-rules/:id
// ---------------------------------------------------------------------------

test('DELETE /v1/mapping-rules/:id: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'DELETE',
    url: `/v1/mapping-rules/${RULE_A1}`,
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('DELETE /v1/mapping-rules/:id: 403 for consultant (admin-only)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'DELETE',
    url: `/v1/mapping-rules/${RULE_A1}`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('DELETE /v1/mapping-rules/:id: 403 for viewer', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'DELETE',
    url: `/v1/mapping-rules/${RULE_A1}`,
    cookies: { cpa_session: await viewerJwt() },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('DELETE /v1/mapping-rules/:id: 204 admin happy + soft-archives the row', async () => {
  // Insert a fresh rule so we don't perturb the seed.
  const RULE_TMP = '00000000-0000-4000-8000-0000000b9053';
  await privilegedSql`
    INSERT INTO mapping_rule (
      tenant_id, id, name, priority, enabled, conditions, action, created_by_user_id
    ) VALUES (
      ${TENANT_A}, ${RULE_TMP}, 'Delete Target', 100, true,
      ${[]},
      ${{ type: 'flag_for_review', reason: 'will be deleted' }},
      ${ADMIN_USER}
    )
  `;
  try {
    const app = buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/mapping-rules/${RULE_TMP}`,
      cookies: { cpa_session: await adminJwt() },
    });
    assert.equal(res.statusCode, 204);
    // Soft-delete: row still exists but enabled = false.
    const rows = await privilegedSql<{ enabled: boolean }[]>`
      SELECT enabled FROM mapping_rule WHERE id = ${RULE_TMP}
    `;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.enabled, false);
    await app.close();
  } finally {
    await privilegedSql`DELETE FROM mapping_rule WHERE id = ${RULE_TMP}`;
  }
});

test('DELETE /v1/mapping-rules/:id: 404 cross-firm', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'DELETE',
    url: `/v1/mapping-rules/${RULE_B1}`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('DELETE /v1/mapping-rules/:id: 404 unknown id', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'DELETE',
    url: '/v1/mapping-rules/00000000-0000-4000-8000-000000abcdef',
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

// ---------------------------------------------------------------------------
// MAPPING_RULE_* audit-kind relocation (P5 Task 2.2)
// ---------------------------------------------------------------------------

test('MAPPING_RULE_* kinds are NOT in evidenceKind (post-2.2 relocation)', async () => {
  // P5 Task 2.2 moved the three MAPPING_RULE_* kinds out of evidenceKind
  // (event chain) and into AUDIT_KINDS (audit_log). This pins that the
  // wire-format Zod enum no longer admits the three values — any caller
  // that still tries to ship them as `event.kind` will fail Zod parse,
  // matching the DB-side `event_kind_valid` CHECK rebuilt in 0023.
  const { evidenceKind } = await import('@cpa/schemas');
  const options = evidenceKind.options;
  assert.ok(!options.includes('MAPPING_RULE_CREATED' as never));
  assert.ok(!options.includes('MAPPING_RULE_UPDATED' as never));
  assert.ok(!options.includes('MAPPING_RULE_ARCHIVED' as never));
});

test('MAPPING_RULE_* kinds ARE in AUDIT_KINDS (their new home)', async () => {
  const { AUDIT_KINDS, auditKind } = await import('@cpa/schemas');
  assert.ok(AUDIT_KINDS.includes('MAPPING_RULE_CREATED'));
  assert.ok(AUDIT_KINDS.includes('MAPPING_RULE_UPDATED'));
  assert.ok(AUDIT_KINDS.includes('MAPPING_RULE_ARCHIVED'));
  // Zod enum mirrors the const array.
  assert.ok(auditKind.options.includes('MAPPING_RULE_CREATED'));
});

test('MAPPING_RULE_* audit payloads parse cleanly via the Zod schemas', async () => {
  const {
    MappingRuleCreatedAuditPayload,
    MappingRuleUpdatedAuditPayload,
    MappingRuleArchivedAuditPayload,
  } = await import('@cpa/schemas');
  // A representative shape for each variant.
  MappingRuleCreatedAuditPayload.parse({
    mapping_rule_id: RULE_A1,
    name: 'r',
    priority: 1,
    conditions: [],
    action: { type: 'flag_for_review', reason: 'x' },
  });
  MappingRuleUpdatedAuditPayload.parse({
    mapping_rule_id: RULE_A1,
    fields_changed: { priority: { from: 10, to: 11 } },
  });
  MappingRuleArchivedAuditPayload.parse({
    mapping_rule_id: RULE_A1,
    archived_by_user_id: ADMIN_USER,
  });
});

// ---------------------------------------------------------------------------
// P5 Task 2.4 — emission-shape assertions
// ---------------------------------------------------------------------------
// One per kind. Each test exercises the full route → audit_log path:
// hits the API, then reads back via privilegedSql and asserts the
// audit_log row has the expected (firm_id, kind, payload, actor_user_id).

test('POST /v1/mapping-rules: emits MAPPING_RULE_CREATED with correct payload', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/mapping-rules',
    cookies: { cpa_session: await consultantJwt() },
    payload: {
      name: 'Audit-emission rule',
      priority: 77,
      conditions: [],
      action: { type: 'flag_for_review', reason: 'audit emission test' },
    },
  });
  assert.equal(res.statusCode, 201);
  const created = res.json<{ mapping_rule: { id: string } }>().mapping_rule;

  // Read back the audit_log row (privilegedSql bypasses RLS — RLS is
  // covered by the keystone test in audit-log.test.ts).
  const rows = await privilegedSql<
    {
      firm_id: string;
      kind: string;
      payload: { mapping_rule_id?: string; name?: string; priority?: number };
      actor_user_id: string | null;
    }[]
  >`
    SELECT firm_id, kind, payload, actor_user_id
      FROM audit_log
     WHERE firm_id = ${TENANT_A}
       AND kind = 'MAPPING_RULE_CREATED'
       AND payload ->> 'mapping_rule_id' = ${created.id}
     ORDER BY created_at DESC
     LIMIT 1
  `;
  assert.equal(rows.length, 1, 'expected one MAPPING_RULE_CREATED audit row');
  const audit = rows[0]!;
  assert.equal(audit.firm_id, TENANT_A);
  assert.equal(audit.kind, 'MAPPING_RULE_CREATED');
  assert.equal(audit.payload.mapping_rule_id, created.id);
  assert.equal(audit.payload.name, 'Audit-emission rule');
  assert.equal(audit.payload.priority, 77);
  assert.equal(audit.actor_user_id, CONSULTANT_USER);

  // Cleanup.
  await privilegedSql`DELETE FROM audit_log WHERE payload ->> 'mapping_rule_id' = ${created.id}`;
  await privilegedSql`DELETE FROM mapping_rule WHERE id = ${created.id}`;
  await app.close();
});

test('PATCH /v1/mapping-rules/:id: emits MAPPING_RULE_UPDATED with fields_changed diff', async () => {
  const app = buildApp();
  // PATCH the pre-seeded RULE_A1 (priority 10 → 99).
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/mapping-rules/${RULE_A1}`,
    cookies: { cpa_session: await consultantJwt() },
    payload: { priority: 99 },
  });
  assert.equal(res.statusCode, 200);

  const rows = await privilegedSql<
    {
      firm_id: string;
      kind: string;
      payload: {
        mapping_rule_id?: string;
        fields_changed?: Record<string, { from: unknown; to: unknown }>;
      };
      actor_user_id: string | null;
    }[]
  >`
    SELECT firm_id, kind, payload, actor_user_id
      FROM audit_log
     WHERE firm_id = ${TENANT_A}
       AND kind = 'MAPPING_RULE_UPDATED'
       AND payload ->> 'mapping_rule_id' = ${RULE_A1}
     ORDER BY created_at DESC
     LIMIT 1
  `;
  assert.equal(rows.length, 1, 'expected one MAPPING_RULE_UPDATED audit row');
  const audit = rows[0]!;
  assert.equal(audit.kind, 'MAPPING_RULE_UPDATED');
  assert.equal(audit.payload.mapping_rule_id, RULE_A1);
  // fields_changed must contain the priority diff (10 → 99) only.
  const fc = audit.payload.fields_changed!;
  assert.deepEqual(fc['priority'], { from: 10, to: 99 });
  // Other fields untouched → not in fields_changed.
  assert.equal(fc['name'], undefined);
  assert.equal(audit.actor_user_id, CONSULTANT_USER);

  // Cleanup: revert RULE_A1 back to priority 10 + drop audit row so
  // subsequent test runs see a clean fixture state.
  await privilegedSql`UPDATE mapping_rule SET priority = 10 WHERE id = ${RULE_A1}`;
  await privilegedSql`DELETE FROM audit_log WHERE kind = 'MAPPING_RULE_UPDATED' AND payload ->> 'mapping_rule_id' = ${RULE_A1}`;
  await app.close();
});

test('DELETE /v1/mapping-rules/:id: emits MAPPING_RULE_ARCHIVED with admin actor', async () => {
  const app = buildApp();
  // Insert a fresh rule to archive (don't touch the pre-seeded RULE_A1
  // which other tests rely on).
  const ARCHIVE_RULE = '00000000-0000-4000-8000-0000000b9091';
  await privilegedSql`
    INSERT INTO mapping_rule (
      tenant_id, id, name, priority, enabled, conditions, action, created_by_user_id
    ) VALUES (
      ${TENANT_A}, ${ARCHIVE_RULE}, 'Archive me', 90, true,
      ${[]},
      ${{ type: 'flag_for_review', reason: 'pre-archive' }},
      ${ADMIN_USER}
    )
  `;
  const res = await app.inject({
    method: 'DELETE',
    url: `/v1/mapping-rules/${ARCHIVE_RULE}`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 204);

  const rows = await privilegedSql<
    {
      firm_id: string;
      kind: string;
      payload: { mapping_rule_id?: string; archived_by_user_id?: string };
      actor_user_id: string | null;
    }[]
  >`
    SELECT firm_id, kind, payload, actor_user_id
      FROM audit_log
     WHERE firm_id = ${TENANT_A}
       AND kind = 'MAPPING_RULE_ARCHIVED'
       AND payload ->> 'mapping_rule_id' = ${ARCHIVE_RULE}
     ORDER BY created_at DESC
     LIMIT 1
  `;
  assert.equal(rows.length, 1, 'expected one MAPPING_RULE_ARCHIVED audit row');
  const audit = rows[0]!;
  assert.equal(audit.firm_id, TENANT_A);
  assert.equal(audit.kind, 'MAPPING_RULE_ARCHIVED');
  assert.equal(audit.payload.mapping_rule_id, ARCHIVE_RULE);
  assert.equal(audit.payload.archived_by_user_id, ADMIN_USER);
  assert.equal(audit.actor_user_id, ADMIN_USER);

  // Cleanup.
  await privilegedSql`DELETE FROM audit_log WHERE payload ->> 'mapping_rule_id' = ${ARCHIVE_RULE}`;
  await privilegedSql`DELETE FROM mapping_rule WHERE id = ${ARCHIVE_RULE}`;
  await app.close();
});
