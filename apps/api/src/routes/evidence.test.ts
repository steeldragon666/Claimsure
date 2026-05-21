import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { signSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../app.js';

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

// Namespace 0c000... for evidence-tab tests.
const TENANT_A = '00000000-0000-4000-8000-0000000c0001';
const TENANT_B = '00000000-0000-4000-8000-0000000c0002';
const USER_A = '00000000-0000-4000-8000-0000000c0010';
const SUBJECT_A1 = '00000000-0000-4000-8000-0000000c0021';
const SUBJECT_A2 = '00000000-0000-4000-8000-0000000c0022';
const SUBJECT_B1 = '00000000-0000-4000-8000-0000000c0023';
// Stable event IDs so cursor pagination is deterministic.
const EV_OLDEST = '00000000-0000-4000-8000-0000000c0031';
const EV_MID = '00000000-0000-4000-8000-0000000c0032';
const EV_NEWEST = '00000000-0000-4000-8000-0000000c0033';
const EV_OTHER_TENANT = '00000000-0000-4000-8000-0000000c0034';

const cleanup = async (): Promise<void> => {
  await privilegedSql`DELETE FROM event WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM subject_tenant WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await sql`DELETE FROM "user" WHERE id = ${USER_A}`;
  await sql`DELETE FROM tenant WHERE id IN (${TENANT_A}, ${TENANT_B})`;
};

before(async () => {
  await cleanup();
  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT_A}, 'Firm A Evidence', 'firm-a-ev-c', 'mixed'),
                   (${TENANT_B}, 'Firm B Evidence', 'firm-b-ev-c', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${USER_A}, 'user-a-ev@example.com', 'microsoft', 'ms:ev-a', 'Evidence User A')`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role)
                      VALUES (gen_random_uuid(), ${TENANT_A}, ${USER_A}, 'admin')`;
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name)
                      VALUES (${SUBJECT_A1}, ${TENANT_A}, 'Claimant A1'),
                             (${SUBJECT_A2}, ${TENANT_A}, 'Claimant A2'),
                             (${SUBJECT_B1}, ${TENANT_B}, 'Claimant B1 (other tenant)')`;
  // Seed: 3 events under USER_A's tenant (A1 × 2, A2 × 1), 1 under other tenant.
  await privilegedSql`
    INSERT INTO event (id, tenant_id, subject_tenant_id, kind, payload, hash, captured_at, received_at, captured_by_user_id)
    VALUES
      (${EV_OLDEST},        ${TENANT_A}, ${SUBJECT_A1}, 'OBSERVATION',
        '{"raw_text":"Oldest observation under A1"}'::jsonb,
        encode(sha256('oldest'::bytea), 'hex'),
        '2026-05-01T10:00:00Z', now(), ${USER_A}),
      (${EV_MID},           ${TENANT_A}, ${SUBJECT_A2}, 'EVIDENCE_UPLOADED',
        '{"filename":"design-spec.pdf","raw_text":"Mid event under A2"}'::jsonb,
        encode(sha256('mid'::bytea), 'hex'),
        '2026-05-10T10:00:00Z', now(), ${USER_A}),
      (${EV_NEWEST},        ${TENANT_A}, ${SUBJECT_A1}, 'HYPOTHESIS',
        '{"raw_text":"Newest hypothesis under A1"}'::jsonb,
        encode(sha256('newest'::bytea), 'hex'),
        '2026-05-20T10:00:00Z', now(), ${USER_A}),
      (${EV_OTHER_TENANT},  ${TENANT_B}, ${SUBJECT_B1}, 'OBSERVATION',
        '{"raw_text":"Event under OTHER tenant — must not be visible"}'::jsonb,
        encode(sha256('other'::bytea), 'hex'),
        '2026-05-15T10:00:00Z', now(), ${USER_A})
  `;
});

after(async () => {
  await cleanup();
  await sql.end();
  await privilegedSql.end();
});

const userJwt = (): Promise<string> =>
  signSession(
    {
      sub: USER_A,
      email: 'user-a-ev@example.com',
      primaryIdp: 'microsoft',
      activeTenantId: TENANT_A,
      activeRole: 'admin',
      availableTenants: [
        { tenantId: TENANT_A, name: 'Firm A Evidence', slug: 'firm-a-ev-c', role: 'admin' },
      ],
    },
    SESSION_SECRET,
    { ttlSeconds: 3600 },
  );

test('GET /v1/evidence: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/v1/evidence' });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test("GET /v1/evidence: returns events from user's tenant only, sorted DESC by captured_at", async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/evidence',
    cookies: { cpa_session: await userJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ items: Array<{ id: string }>; next_cursor: string | null }>();
  assert.equal(body.items.length, 3, 'three events under TENANT_A');
  assert.deepEqual(
    body.items.map((i) => i.id),
    [EV_NEWEST, EV_MID, EV_OLDEST],
    'sorted DESC by captured_at',
  );
  await app.close();
});

test('GET /v1/evidence: RLS isolation — does NOT return events from another tenant', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/evidence',
    cookies: { cpa_session: await userJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ items: Array<{ id: string }> }>();
  const ids = body.items.map((i) => i.id);
  assert.ok(!ids.includes(EV_OTHER_TENANT), 'event from TENANT_B must NOT appear');
});

test('GET /v1/evidence: filters by claimant_ids', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/evidence?claimant_ids=${SUBJECT_A1}`,
    cookies: { cpa_session: await userJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ items: Array<{ id: string; claimant: { id: string } }> }>();
  assert.equal(body.items.length, 2, 'only events under SUBJECT_A1');
  for (const item of body.items) {
    assert.equal(item.claimant.id, SUBJECT_A1);
  }
});

test('GET /v1/evidence: filters by kinds', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/evidence?kinds=HYPOTHESIS',
    cookies: { cpa_session: await userJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ items: Array<{ id: string; kind: string }> }>();
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0]?.kind, 'HYPOTHESIS');
});

test('GET /v1/evidence: cursor pagination yields disjoint, ordered pages', async () => {
  const app = buildApp();
  // Page 1: limit=2 → newest two
  const page1Res = await app.inject({
    method: 'GET',
    url: '/v1/evidence?limit=2',
    cookies: { cpa_session: await userJwt() },
  });
  assert.equal(page1Res.statusCode, 200);
  const page1 = page1Res.json<{ items: Array<{ id: string }>; next_cursor: string | null }>();
  assert.equal(page1.items.length, 2);
  assert.deepEqual(
    page1.items.map((i) => i.id),
    [EV_NEWEST, EV_MID],
  );
  assert.ok(page1.next_cursor, 'cursor returned when more pages exist');

  // Page 2: continue from cursor
  const page2Res = await app.inject({
    method: 'GET',
    url: `/v1/evidence?limit=2&cursor=${encodeURIComponent(page1.next_cursor)}`,
    cookies: { cpa_session: await userJwt() },
  });
  assert.equal(page2Res.statusCode, 200);
  const page2 = page2Res.json<{ items: Array<{ id: string }>; next_cursor: string | null }>();
  assert.equal(page2.items.length, 1);
  assert.deepEqual(
    page2.items.map((i) => i.id),
    [EV_OLDEST],
  );
  assert.equal(page2.next_cursor, null, 'no more pages');
  await app.close();
});

test('GET /v1/evidence: 400 on invalid kind', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/evidence?kinds=NOT_A_REAL_KIND',
    cookies: { cpa_session: await userJwt() },
  });
  assert.equal(res.statusCode, 400);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'invalid_query');
  await app.close();
});
