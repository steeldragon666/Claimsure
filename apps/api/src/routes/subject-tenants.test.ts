import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { signSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import { insertEventWithChain } from '@cpa/db';
import { buildApp } from '../app.js';

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

const TENANT_A = '00000000-0000-4000-8000-0000000c0001';
const TENANT_B = '00000000-0000-4000-8000-0000000c0002';
const ADMIN_USER = '00000000-0000-4000-8000-0000000c0010';
const VIEWER_USER = '00000000-0000-4000-8000-0000000c0011';
const CONSULTANT_USER = '00000000-0000-4000-8000-0000000c0012';
const SUBJECT_A1 = '00000000-0000-4000-8000-0000000c0021';
const SUBJECT_A2 = '00000000-0000-4000-8000-0000000c0022';
const SUBJECT_B1 = '00000000-0000-4000-8000-0000000c0023';

const cleanup = async (): Promise<void> => {
  // Wipe in FK-safe order. Created subject_tenant_user rows live under the
  // seeded subject_tenants AND any rows created by the POST tests; cascade
  // by tenant_id so every test-created acl is captured. Events FK to both
  // tenant + subject_tenant, so wipe them first.
  await privilegedSql`DELETE FROM event WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM subject_tenant_user WHERE subject_tenant_id IN (
    SELECT id FROM subject_tenant WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})
  )`;
  await privilegedSql`DELETE FROM subject_tenant WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await sql`DELETE FROM "user" WHERE id IN (${ADMIN_USER}, ${VIEWER_USER}, ${CONSULTANT_USER})`;
  await sql`DELETE FROM tenant WHERE id IN (${TENANT_A}, ${TENANT_B})`;
};

before(async () => {
  await cleanup();

  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT_A}, 'Firm A', 'firm-a-st', 'mixed'),
                   (${TENANT_B}, 'Firm B', 'firm-b-st', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${ADMIN_USER}, 'st-admin@example.com', 'microsoft', 'microsoft:st-admin', 'ST Admin'),
                   (${VIEWER_USER}, 'st-viewer@example.com', 'microsoft', 'microsoft:st-viewer', 'ST Viewer'),
                   (${CONSULTANT_USER}, 'st-cons@example.com', 'microsoft', 'microsoft:st-cons', 'ST Consultant')`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT_A}, ${ADMIN_USER}, 'admin', true),
                              (gen_random_uuid(), ${TENANT_A}, ${VIEWER_USER}, 'viewer', true),
                              (gen_random_uuid(), ${TENANT_A}, ${CONSULTANT_USER}, 'consultant', true)`;

  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                       VALUES (${SUBJECT_A1}, ${TENANT_A}, 'Acme Co', 'claimant'),
                              (${SUBJECT_A2}, ${TENANT_A}, 'Beta Inc', 'claimant'),
                              (${SUBJECT_B1}, ${TENANT_B}, 'Other Corp', 'financier')`;

  // Seed two events on SUBJECT_A1 so detail-test assertions on event_count /
  // head_hash have something non-trivial to verify. Use the chain helper so
  // the rows pass DB CHECK constraints.
  await insertEventWithChain({
    tenant_id: TENANT_A,
    subject_tenant_id: SUBJECT_A1,
    kind: 'HYPOTHESIS',
    payload: { _v: 1, source: 'test-fixture', text: 'first' },
    classification: null,
    captured_at: new Date('2025-01-01T00:00:00Z'),
    captured_by_user_id: ADMIN_USER,
    override_of_event_id: null,
    override_new_kind: null,
    override_reason: null,
  });
  await insertEventWithChain({
    tenant_id: TENANT_A,
    subject_tenant_id: SUBJECT_A1,
    kind: 'EXPERIMENT',
    payload: { _v: 1, source: 'test-fixture', text: 'second' },
    classification: null,
    captured_at: new Date('2025-01-02T00:00:00Z'),
    captured_by_user_id: ADMIN_USER,
    override_of_event_id: null,
    override_new_kind: null,
    override_reason: null,
  });
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

const adminJwt = (): Promise<string> => jwtFor(ADMIN_USER, 'st-admin@example.com', 'admin');
const viewerJwt = (): Promise<string> => jwtFor(VIEWER_USER, 'st-viewer@example.com', 'viewer');
const consultantJwt = (): Promise<string> =>
  jwtFor(CONSULTANT_USER, 'st-cons@example.com', 'consultant');

test('GET /v1/subject-tenants: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/v1/subject-tenants' });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('GET /v1/subject-tenants: returns active firm rows only (RLS)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/subject-tenants',
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ subject_tenants: Array<{ id: string; name: string; kind: string }> }>();
  // Both firm-A subjects, no firm-B row.
  assert.equal(body.subject_tenants.length, 2);
  const ids = body.subject_tenants.map((s) => s.id).sort();
  assert.deepEqual(ids, [SUBJECT_A1, SUBJECT_A2].sort());
  assert.ok(body.subject_tenants.every((s) => s.kind === 'claimant'));
  await app.close();
});

test('GET /v1/subject-tenants?kind=financier: empty when none match', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/subject-tenants?kind=financier',
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ subject_tenants: unknown[] }>();
  assert.equal(body.subject_tenants.length, 0);
  await app.close();
});

test('POST /v1/subject-tenants: 201 + ACL row for consultant caller', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/subject-tenants',
    cookies: { cpa_session: await consultantJwt() },
    payload: { name: 'Gamma Holdings', kind: 'claimant' },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json<{
    subject_tenant: { id: string; name: string; kind: string; tenant_id: string };
  }>();
  assert.equal(body.subject_tenant.name, 'Gamma Holdings');
  assert.equal(body.subject_tenant.kind, 'claimant');
  assert.equal(body.subject_tenant.tenant_id, TENANT_A);

  // ACL row exists with role='lead' (schema's equivalent of 'owner').
  const acl = await privilegedSql<
    { user_id: string; role: 'lead' | 'observer' }[]
  >`SELECT user_id, role FROM subject_tenant_user
     WHERE subject_tenant_id = ${body.subject_tenant.id}`;
  assert.equal(acl.length, 1);
  assert.equal(acl[0]?.user_id, CONSULTANT_USER);
  assert.equal(acl[0]?.role, 'lead');
  await app.close();
});

test('POST /v1/subject-tenants: 409 on duplicate name within firm', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/subject-tenants',
    cookies: { cpa_session: await adminJwt() },
    payload: { name: 'Acme Co', kind: 'claimant' }, // collides with SUBJECT_A1
  });
  assert.equal(res.statusCode, 409);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'duplicate_name');
  await app.close();
});

test('POST /v1/subject-tenants: 403 for viewer role', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/subject-tenants',
    cookies: { cpa_session: await viewerJwt() },
    payload: { name: 'Should-Fail Inc', kind: 'claimant' },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('POST /v1/subject-tenants: 400 on invalid body', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/subject-tenants',
    cookies: { cpa_session: await adminJwt() },
    payload: { name: '', kind: 'claimant' }, // empty name
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('GET /v1/subject-tenants/:id: returns detail with event_count + head_hash', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/subject-tenants/${SUBJECT_A1}`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    subject_tenant: { id: string; name: string };
    event_count: number;
    head_hash: string | null;
  }>();
  assert.equal(body.subject_tenant.id, SUBJECT_A1);
  assert.equal(body.event_count, 2);
  assert.ok(body.head_hash !== null);
  assert.match(body.head_hash ?? '', /^[0-9a-f]{64}$/);
  await app.close();
});

test('GET /v1/subject-tenants/:id: event_count=0 + head_hash=null when no events', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/subject-tenants/${SUBJECT_A2}`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ event_count: number; head_hash: string | null }>();
  assert.equal(body.event_count, 0);
  assert.equal(body.head_hash, null);
  await app.close();
});

test('GET /v1/subject-tenants/:id: 404 unknown id', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/subject-tenants/00000000-0000-4000-8000-00000000dead',
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('GET /v1/subject-tenants/:id: 404 cross-firm (RLS hides firm B row)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/subject-tenants/${SUBJECT_B1}`,
    cookies: { cpa_session: await adminJwt() }, // session is in firm A
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('GET /v1/subject-tenants/:id/chain-status: clean chain returns verified=true', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/subject-tenants/${SUBJECT_A1}/chain-status`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    verified: boolean;
    head_hash: string | null;
    event_count: number;
    first_break_at: number | null;
  }>();
  assert.equal(body.verified, true);
  assert.equal(body.event_count, 2);
  assert.equal(body.first_break_at, null);
  assert.match(body.head_hash ?? '', /^[0-9a-f]{64}$/);
  await app.close();
});

test('GET /v1/subject-tenants/:id/chain-status: tampered hash → verified=false', async () => {
  // Tamper with the FIRST event's hash via privilegedSql (RLS-bypassing).
  // verifyChain replays the chain in (captured_at, received_at, id) order;
  // a corrupted first event surfaces as first_break_at=0.
  const [first] = await privilegedSql<{ id: string; hash: string }[]>`
    SELECT id, hash FROM event WHERE subject_tenant_id = ${SUBJECT_A1}
    ORDER BY captured_at, received_at, id LIMIT 1
  `;
  assert.ok(first);
  const original = first.hash;
  // Stable corrupt hex (passes the format CHECK but is wrong).
  const corrupt = '0123456789abcdef' + original.substring(16);
  await privilegedSql`UPDATE event SET hash = ${corrupt} WHERE id = ${first.id}`;
  try {
    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/subject-tenants/${SUBJECT_A1}/chain-status`,
      cookies: { cpa_session: await adminJwt() },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{ verified: boolean; first_break_at: number | null }>();
    assert.equal(body.verified, false);
    assert.equal(body.first_break_at, 0);
    await app.close();
  } finally {
    // Restore so subsequent tests still see a clean chain.
    await privilegedSql`UPDATE event SET hash = ${original} WHERE id = ${first.id}`;
  }
});

test('GET /v1/subject-tenants/:id/chain-status: 404 cross-firm', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/subject-tenants/${SUBJECT_B1}/chain-status`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});
