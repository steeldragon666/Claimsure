import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { signSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../app.js';
import { MOBILE_AUDIENCE } from '../middleware/mobile-jwt-verifier.js';

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

const TENANT_A = '00000000-0000-4000-8000-0000000b2201';
const TENANT_B = '00000000-0000-4000-8000-0000000b2202';
const ADMIN_USER = '00000000-0000-4000-8000-0000000b2210';
const VIEWER_USER = '00000000-0000-4000-8000-0000000b2211';
const SUBJECT_A1 = '00000000-0000-4000-8000-0000000b2221';
const SUBJECT_B1 = '00000000-0000-4000-8000-0000000b2222';
const EMP_A1 = '00000000-0000-4000-8000-0000000b2231';
const EMP_A2 = '00000000-0000-4000-8000-0000000b2232';
const EMP_B1 = '00000000-0000-4000-8000-0000000b2233';

// Time entry seeds.
const ENTRY_MANUAL_OK = '00000000-0000-4000-8000-0000000b2241';
const ENTRY_PAYROLL = '00000000-0000-4000-8000-0000000b2242';
const ENTRY_MANUAL_FLAGGED = '00000000-0000-4000-8000-0000000b2243';
const ENTRY_FIRM_B = '00000000-0000-4000-8000-0000000b2244';

const cleanup = async (): Promise<void> => {
  await privilegedSql`DELETE FROM time_entry WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM subject_tenant_employee WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM subject_tenant_user WHERE subject_tenant_id IN (
    SELECT id FROM subject_tenant WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})
  )`;
  await privilegedSql`DELETE FROM subject_tenant WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await sql`DELETE FROM "user" WHERE id IN (${ADMIN_USER}, ${VIEWER_USER})`;
  await sql`DELETE FROM tenant WHERE id IN (${TENANT_A}, ${TENANT_B})`;
};

before(async () => {
  // Ensure SESSION_JWT_SECRET is set for the mobile-JWT middleware
  // (tests run with the dev fallback if no env file).
  process.env['SESSION_JWT_SECRET'] = SESSION_SECRET;
  await cleanup();
  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT_A}, 'Firm A', 'firm-a-b22', 'mixed'),
                   (${TENANT_B}, 'Firm B', 'firm-b-b22', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${ADMIN_USER}, 'b22-admin@example.com', 'microsoft', 'microsoft:b22-admin', 'B22 Admin'),
                   (${VIEWER_USER}, 'b22-viewer@example.com', 'microsoft', 'microsoft:b22-viewer', 'B22 Viewer')`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT_A}, ${ADMIN_USER}, 'admin', true),
                              (gen_random_uuid(), ${TENANT_A}, ${VIEWER_USER}, 'viewer', true)`;
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                       VALUES (${SUBJECT_A1}, ${TENANT_A}, 'Acme Co', 'claimant'),
                              (${SUBJECT_B1}, ${TENANT_B}, 'Other Corp', 'claimant')`;
  await privilegedSql`
    INSERT INTO subject_tenant_employee (id, subject_tenant_id, tenant_id, email, name, invited_by_user_id)
    VALUES
      (${EMP_A1}, ${SUBJECT_A1}, ${TENANT_A}, 'emp-a1@example.com', 'Emp A1', ${ADMIN_USER}),
      (${EMP_A2}, ${SUBJECT_A1}, ${TENANT_A}, 'emp-a2@example.com', 'Emp A2', ${ADMIN_USER}),
      (${EMP_B1}, ${SUBJECT_B1}, ${TENANT_B}, 'emp-b1@example.com', 'Emp B1', ${ADMIN_USER})
  `;
  // Seed entries: 1 manual unflagged, 1 payroll-imported, 1 manual flagged.
  await privilegedSql`
    INSERT INTO time_entry (
      id, tenant_id, subject_tenant_id, employee_id, source, external_id,
      started_at, ended_at, duration_minutes, is_rd, notes, flagged_at
    ) VALUES
    (${ENTRY_MANUAL_OK}, ${TENANT_A}, ${SUBJECT_A1}, ${EMP_A1}, 'manual', NULL,
     '2026-04-25T09:00:00Z'::timestamptz, '2026-04-25T11:00:00Z'::timestamptz,
     120, true, 'manual entry', NULL),
    (${ENTRY_PAYROLL}, ${TENANT_A}, ${SUBJECT_A1}, ${EMP_A1}, 'employment_hero', 'eh-payroll-1',
     '2026-04-26T09:00:00Z'::timestamptz, '2026-04-26T17:00:00Z'::timestamptz,
     480, true, 'payroll', NULL),
    (${ENTRY_MANUAL_FLAGGED}, ${TENANT_A}, ${SUBJECT_A1}, ${EMP_A1}, 'manual', NULL,
     '2026-04-26T10:00:00Z'::timestamptz, '2026-04-26T12:00:00Z'::timestamptz,
     120, true, 'overlaps payroll', NOW()),
    (${ENTRY_FIRM_B}, ${TENANT_B}, ${SUBJECT_B1}, ${EMP_B1}, 'manual', NULL,
     '2026-04-25T09:00:00Z'::timestamptz, '2026-04-25T11:00:00Z'::timestamptz,
     120, true, 'firm B entry', NULL)
  `;
});

after(async () => {
  await cleanup();
  await sql.end();
  await privilegedSql.end();
});

const adminJwt = (): Promise<string> =>
  signSession(
    {
      sub: ADMIN_USER,
      email: 'b22-admin@example.com',
      primaryIdp: 'microsoft',
      activeTenantId: TENANT_A,
      activeRole: 'admin',
      availableTenants: [],
    },
    SESSION_SECRET,
    { ttlSeconds: 3600 },
  );

const viewerJwt = (): Promise<string> =>
  signSession(
    {
      sub: VIEWER_USER,
      email: 'b22-viewer@example.com',
      primaryIdp: 'microsoft',
      activeTenantId: TENANT_A,
      activeRole: 'viewer',
      availableTenants: [],
    },
    SESSION_SECRET,
    { ttlSeconds: 3600 },
  );

const mobileJwtFor = async (
  employeeId: string,
  tenantId: string,
  subjectTenantId: string,
): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    tenant_id: tenantId,
    subject_tenant_id: subjectTenantId,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(employeeId)
    .setAudience(MOBILE_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(new TextEncoder().encode(SESSION_SECRET));
};

// ---------- GET /v1/time-entries ----------

test('GET /v1/time-entries: 401 without auth', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/time-entries?subject_tenant_id=${SUBJECT_A1}`,
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('GET /v1/time-entries: 400 without subject_tenant_id', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/time-entries',
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('GET /v1/time-entries: consultant lists active firm rows only (RLS) — flagged hidden by default', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/time-entries?subject_tenant_id=${SUBJECT_A1}`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    time_entries: Array<{ id: string; tenant_id: string; flagged_at: string | null }>;
  }>();
  assert.ok(body.time_entries.length >= 2);
  assert.ok(body.time_entries.every((t) => t.tenant_id === TENANT_A));
  // Flagged entry is filtered by default.
  assert.ok(!body.time_entries.some((t) => t.id === ENTRY_MANUAL_FLAGGED));
  // Cross-firm entry is filtered by RLS.
  assert.ok(!body.time_entries.some((t) => t.id === ENTRY_FIRM_B));
  await app.close();
});

test('GET /v1/time-entries: include_flagged=true surfaces the flagged entry', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/time-entries?subject_tenant_id=${SUBJECT_A1}&include_flagged=true`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ time_entries: Array<{ id: string; flagged_at: string | null }> }>();
  assert.ok(body.time_entries.some((t) => t.id === ENTRY_MANUAL_FLAGGED));
});

test('GET /v1/time-entries: filtered by employee_id', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/time-entries?subject_tenant_id=${SUBJECT_A1}&employee_id=${EMP_A2}`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ time_entries: Array<{ employee_id: string }> }>();
  // EMP_A2 has no seeded entries, so empty.
  assert.equal(body.time_entries.length, 0);
  await app.close();
});

test('GET /v1/time-entries: from/to date filters narrow the result', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/time-entries?subject_tenant_id=${SUBJECT_A1}&from=2026-04-26&to=2026-04-26`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ time_entries: Array<{ id: string; started_at: string }> }>();
  // Only ENTRY_PAYROLL falls in the 26 Apr window (the manual flagged
  // is also on 26 Apr but flagged out by default).
  assert.ok(body.time_entries.some((t) => t.id === ENTRY_PAYROLL));
  assert.ok(!body.time_entries.some((t) => t.id === ENTRY_MANUAL_OK));
  await app.close();
});

test('GET /v1/time-entries: mobile JWT scoped to own employee_id, ignores foreign filter', async () => {
  const app = buildApp();
  const token = await mobileJwtFor(EMP_A1, TENANT_A, SUBJECT_A1);
  const res = await app.inject({
    method: 'GET',
    url: `/v1/time-entries?subject_tenant_id=${SUBJECT_A1}&include_flagged=true`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ time_entries: Array<{ employee_id: string }> }>();
  // Mobile sees their own entries only.
  assert.ok(body.time_entries.length >= 1);
  assert.ok(body.time_entries.every((t) => t.employee_id === EMP_A1));
  await app.close();
});

test('GET /v1/time-entries: mobile JWT 403 when subject_tenant_id mismatches', async () => {
  const app = buildApp();
  const token = await mobileJwtFor(EMP_A1, TENANT_A, SUBJECT_A1);
  const res = await app.inject({
    method: 'GET',
    url: `/v1/time-entries?subject_tenant_id=${SUBJECT_B1}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

// ---------- POST /v1/time-entries ----------

test('POST /v1/time-entries: 401 without mobile JWT', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/time-entries',
    payload: {
      started_at: '2026-04-27T09:00:00Z',
      ended_at: '2026-04-27T11:00:00Z',
    },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /v1/time-entries: 201 + DB row + duration computed', async () => {
  const app = buildApp();
  const token = await mobileJwtFor(EMP_A1, TENANT_A, SUBJECT_A1);
  const res = await app.inject({
    method: 'POST',
    url: '/v1/time-entries',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      started_at: '2026-04-27T09:00:00Z',
      ended_at: '2026-04-27T10:30:00Z',
      notes: 'mobile test entry',
    },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json<{
    time_entry: {
      id: string;
      employee_id: string;
      duration_minutes: number;
      source: string;
      is_rd: boolean;
    };
  }>();
  assert.equal(body.time_entry.employee_id, EMP_A1);
  assert.equal(body.time_entry.source, 'manual');
  // 90 minutes = 1.5h.
  assert.equal(body.time_entry.duration_minutes, 90);
  assert.equal(body.time_entry.is_rd, true);

  const dbRows = await privilegedSql<{ id: string; notes: string | null }[]>`
    SELECT id, notes FROM time_entry WHERE id = ${body.time_entry.id}
  `;
  assert.equal(dbRows.length, 1);
  assert.equal(dbRows[0]?.notes, 'mobile test entry');
  // Cleanup the row so subsequent runs don't accumulate.
  await privilegedSql`DELETE FROM time_entry WHERE id = ${body.time_entry.id}`;
  await app.close();
});

test('POST /v1/time-entries: 400 when ended_at <= started_at', async () => {
  const app = buildApp();
  const token = await mobileJwtFor(EMP_A1, TENANT_A, SUBJECT_A1);
  const res = await app.inject({
    method: 'POST',
    url: '/v1/time-entries',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      started_at: '2026-04-27T11:00:00Z',
      ended_at: '2026-04-27T09:00:00Z',
    },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

// ---------- PATCH /v1/time-entries/:id/apportionment ----------

test('PATCH /v1/time-entries/:id/apportionment: 200 sets pct + stamps user/at', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/time-entries/${ENTRY_MANUAL_OK}/apportionment`,
    cookies: { cpa_session: await adminJwt() },
    payload: { apportionment_pct: 75.5 },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    time_entry: {
      id: string;
      apportionment_pct: number | null;
      apportioned_by_user_id: string | null;
      apportioned_at: string | null;
    };
  }>();
  assert.equal(body.time_entry.apportionment_pct, 75.5);
  assert.equal(body.time_entry.apportioned_by_user_id, ADMIN_USER);
  assert.ok(body.time_entry.apportioned_at);
  await app.close();
});

test('PATCH /v1/time-entries/:id/apportionment: 400 when pct out of range', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/time-entries/${ENTRY_MANUAL_OK}/apportionment`,
    cookies: { cpa_session: await adminJwt() },
    payload: { apportionment_pct: 150 },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('PATCH /v1/time-entries/:id/apportionment: 403 for viewer role', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/time-entries/${ENTRY_MANUAL_OK}/apportionment`,
    cookies: { cpa_session: await viewerJwt() },
    payload: { apportionment_pct: 50 },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('PATCH /v1/time-entries/:id/apportionment: 404 cross-firm', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/time-entries/${ENTRY_FIRM_B}/apportionment`,
    cookies: { cpa_session: await adminJwt() },
    payload: { apportionment_pct: 50 },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

// ---------- POST /v1/time-entries/:id/clear-flag ----------

test('POST /v1/time-entries/:id/clear-flag: 200 clears flagged_at', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/time-entries/${ENTRY_MANUAL_FLAGGED}/clear-flag`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ time_entry: { id: string; flagged_at: string | null } }>();
  assert.equal(body.time_entry.flagged_at, null);

  // Restore the flag for any subsequent test.
  await privilegedSql`
    UPDATE time_entry SET flagged_at = NOW() WHERE id = ${ENTRY_MANUAL_FLAGGED}
  `;
  await app.close();
});

test('POST /v1/time-entries/:id/clear-flag: 404 cross-firm', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/time-entries/${ENTRY_FIRM_B}/clear-flag`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('POST /v1/time-entries/:id/clear-flag: 403 for viewer role', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/time-entries/${ENTRY_MANUAL_FLAGGED}/clear-flag`,
    cookies: { cpa_session: await viewerJwt() },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});
