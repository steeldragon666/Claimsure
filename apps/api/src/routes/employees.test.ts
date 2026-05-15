import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { signSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../app.js';

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

const TENANT_A = '00000000-0000-4000-8000-0000000f6001';
const TENANT_B = '00000000-0000-4000-8000-0000000f6002';
const ADMIN_USER = '00000000-0000-4000-8000-0000000f6010';
const VIEWER_USER = '00000000-0000-4000-8000-0000000f6011';
const CONSULTANT_USER = '00000000-0000-4000-8000-0000000f6012';
const SUBJECT_A1 = '00000000-0000-4000-8000-0000000f6021';
const SUBJECT_B1 = '00000000-0000-4000-8000-0000000f6023';
const EMPLOYEE_PRESEED = '00000000-0000-4000-8000-0000000f6030';

const cleanup = async (): Promise<void> => {
  // FK-safe cleanup: events first (event.subject_tenant_id FKs to
  // subject_tenant), then magic_link_token → subject_tenant_employee →
  // subject_tenant → tenant_user → user → tenant.
  //
  // The event delete handles stale events from prior failed runs that
  // would otherwise block the subject_tenant delete on FK constraint
  // event_subject_tenant_id_subject_tenant_id_fk.
  await privilegedSql`DELETE FROM event WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`
    DELETE FROM magic_link_token WHERE employee_id IN (
      SELECT id FROM subject_tenant_employee WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})
    )
  `;
  await privilegedSql`DELETE FROM subject_tenant_employee WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
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
            VALUES (${TENANT_A}, 'Firm A', 'firm-a-f6', 'mixed'),
                   (${TENANT_B}, 'Firm B', 'firm-b-f6', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${ADMIN_USER}, 'f6-admin@example.com', 'microsoft', 'microsoft:f6-admin', 'F6 Admin'),
                   (${VIEWER_USER}, 'f6-viewer@example.com', 'microsoft', 'microsoft:f6-viewer', 'F6 Viewer'),
                   (${CONSULTANT_USER}, 'f6-cons@example.com', 'microsoft', 'microsoft:f6-cons', 'F6 Consultant')`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT_A}, ${ADMIN_USER}, 'admin', true),
                              (gen_random_uuid(), ${TENANT_A}, ${VIEWER_USER}, 'viewer', true),
                              (gen_random_uuid(), ${TENANT_A}, ${CONSULTANT_USER}, 'consultant', true)`;
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                       VALUES (${SUBJECT_A1}, ${TENANT_A}, 'Acme Co', 'claimant'),
                              (${SUBJECT_B1}, ${TENANT_B}, 'Other Corp', 'claimant')`;
  // Pre-seed an employee for the resend / detail / cross-firm tests.
  await privilegedSql`
    INSERT INTO subject_tenant_employee (
      id, subject_tenant_id, tenant_id, email, name, invited_by_user_id
    ) VALUES (
      ${EMPLOYEE_PRESEED}, ${SUBJECT_A1}, ${TENANT_A},
      'preseed@example.com', 'Pre-Seed', ${ADMIN_USER}
    )
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

const adminJwt = (): Promise<string> => jwtFor(ADMIN_USER, 'f6-admin@example.com', 'admin');
const viewerJwt = (): Promise<string> => jwtFor(VIEWER_USER, 'f6-viewer@example.com', 'viewer');
const consultantJwt = (): Promise<string> =>
  jwtFor(CONSULTANT_USER, 'f6-cons@example.com', 'consultant');

test('POST /v1/employees: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/employees',
    payload: { subject_tenant_id: SUBJECT_A1, email: 'x@y.com', name: 'X' },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /v1/employees: 201 + DB rows + magic-link token created', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/employees',
    cookies: { cpa_session: await consultantJwt() },
    payload: {
      subject_tenant_id: SUBJECT_A1,
      email: 'new1@example.com',
      name: 'New One',
      job_title: 'Engineer',
    },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json<{ employee: { id: string; email: string; tenant_id: string } }>();
  assert.equal(body.employee.email, 'new1@example.com');
  assert.equal(body.employee.tenant_id, TENANT_A);

  // Verify the employee row exists in the DB.
  const employeeRows = await privilegedSql<{ id: string; name: string }[]>`
    SELECT id, name FROM subject_tenant_employee WHERE id = ${body.employee.id}
  `;
  assert.equal(employeeRows.length, 1);
  assert.equal(employeeRows[0]?.name, 'New One');

  // Verify a magic-link token row was created for this employee.
  const tokenRows = await privilegedSql<{ id: string; expires_at: Date }[]>`
    SELECT id, expires_at FROM magic_link_token WHERE employee_id = ${body.employee.id}
  `;
  assert.equal(tokenRows.length, 1);
  // 15-minute expiry, give or take a few seconds for clock skew.
  const expires = new Date(tokenRows[0]!.expires_at).getTime();
  const now = Date.now();
  assert.ok(expires - now > 14 * 60 * 1000);
  assert.ok(expires - now <= 15 * 60 * 1000 + 5_000);

  await app.close();
});

test('POST /v1/employees: 400 on invalid email', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/employees',
    cookies: { cpa_session: await consultantJwt() },
    payload: { subject_tenant_id: SUBJECT_A1, email: 'not-an-email', name: 'X' },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /v1/employees: 403 for viewer role', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/employees',
    cookies: { cpa_session: await viewerJwt() },
    payload: { subject_tenant_id: SUBJECT_A1, email: 'shouldfail@example.com', name: 'X' },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('POST /v1/employees: 404 cross-firm subject_tenant', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/employees',
    cookies: { cpa_session: await adminJwt() },
    payload: { subject_tenant_id: SUBJECT_B1, email: 'crosfirm@example.com', name: 'X' },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('POST /v1/employees: 409 on duplicate active email for the same claimant', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/employees',
    cookies: { cpa_session: await consultantJwt() },
    payload: {
      subject_tenant_id: SUBJECT_A1,
      email: 'preseed@example.com', // collides with the pre-seeded row
      name: 'Duplicate',
    },
  });
  assert.equal(res.statusCode, 409);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'employee_email_taken');
  await app.close();
});

test('GET /v1/employees: returns active firm rows only (RLS)', async () => {
  // Seed an extra firm-B employee to confirm it's filtered out.
  const FIRM_B_EMP = '00000000-0000-4000-8000-0000000f6041';
  await privilegedSql`
    INSERT INTO subject_tenant_employee (
      id, subject_tenant_id, tenant_id, email, name, invited_by_user_id
    ) VALUES (
      ${FIRM_B_EMP}, ${SUBJECT_B1}, ${TENANT_B},
      'firmb@example.com', 'Firm B', ${ADMIN_USER}
    )
  `;
  try {
    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/employees',
      cookies: { cpa_session: await adminJwt() },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{ employees: Array<{ id: string; tenant_id: string }> }>();
    assert.ok(body.employees.length >= 1);
    assert.ok(body.employees.every((e) => e.tenant_id === TENANT_A));
    assert.ok(!body.employees.some((e) => e.id === FIRM_B_EMP));
    await app.close();
  } finally {
    await privilegedSql`DELETE FROM subject_tenant_employee WHERE id = ${FIRM_B_EMP}`;
  }
});

test('GET /v1/employees?subject_tenant_id=...: filters to that claimant', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/employees?subject_tenant_id=${SUBJECT_A1}`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ employees: Array<{ subject_tenant_id: string }> }>();
  assert.ok(body.employees.length >= 1);
  assert.ok(body.employees.every((e) => e.subject_tenant_id === SUBJECT_A1));
  await app.close();
});

test('GET /v1/employees/:id: detail returns the employee', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/employees/${EMPLOYEE_PRESEED}`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ employee: { id: string; email: string } }>();
  assert.equal(body.employee.id, EMPLOYEE_PRESEED);
  assert.equal(body.employee.email, 'preseed@example.com');
  await app.close();
});

test('GET /v1/employees/:id: 404 cross-firm', async () => {
  // Add a firm-B employee so we have a real cross-firm id to probe.
  const FIRM_B_EMP = '00000000-0000-4000-8000-0000000f6042';
  await privilegedSql`
    INSERT INTO subject_tenant_employee (
      id, subject_tenant_id, tenant_id, email, name, invited_by_user_id
    ) VALUES (
      ${FIRM_B_EMP}, ${SUBJECT_B1}, ${TENANT_B},
      'firmb-cross@example.com', 'Cross Firm B', ${ADMIN_USER}
    )
  `;
  try {
    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/employees/${FIRM_B_EMP}`,
      cookies: { cpa_session: await adminJwt() }, // session is in firm A
    });
    assert.equal(res.statusCode, 404);
    await app.close();
  } finally {
    await privilegedSql`DELETE FROM subject_tenant_employee WHERE id = ${FIRM_B_EMP}`;
  }
});

test('POST /v1/employees/:id/invite: re-issues a magic-link token', async () => {
  // Snapshot existing token count for the pre-seed, then resend, then
  // confirm a new row landed.
  const before = await privilegedSql<{ n: string }[]>`
    SELECT COUNT(*)::text AS n FROM magic_link_token WHERE employee_id = ${EMPLOYEE_PRESEED}
  `;
  const beforeN = Number(before[0]?.n ?? '0');

  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/employees/${EMPLOYEE_PRESEED}/invite`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(res.statusCode, 202);

  const after = await privilegedSql<{ n: string }[]>`
    SELECT COUNT(*)::text AS n FROM magic_link_token WHERE employee_id = ${EMPLOYEE_PRESEED}
  `;
  const afterN = Number(after[0]?.n ?? '0');
  assert.equal(afterN, beforeN + 1);
  await app.close();
});

test('POST /v1/employees/:id/invite: 403 for viewer role', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/employees/${EMPLOYEE_PRESEED}/invite`,
    cookies: { cpa_session: await viewerJwt() },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

// =============================================================================
// PATCH /v1/employees/:id (P5A)
// =============================================================================

test('PATCH /v1/employees/:id: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/employees/${EMPLOYEE_PRESEED}`,
    payload: { name: 'New Name' },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('PATCH /v1/employees/:id: 403 for viewer role', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/employees/${EMPLOYEE_PRESEED}`,
    cookies: { cpa_session: await viewerJwt() },
    payload: { name: 'Should Fail' },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('PATCH /v1/employees/:id: 400 on invalid body (extra key)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/employees/${EMPLOYEE_PRESEED}`,
    cookies: { cpa_session: await adminJwt() },
    payload: { name: 'Valid', unknown_field: 'oops' },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('PATCH /v1/employees/:id: 404 cross-firm id (RLS isolation)', async () => {
  // Seed a firm-B employee to use as a cross-firm id.
  const FIRM_B_EMP_PATCH = '00000000-0000-4000-8000-0000000f6050';
  await privilegedSql`
    INSERT INTO subject_tenant_employee (
      id, subject_tenant_id, tenant_id, email, name, invited_by_user_id
    ) VALUES (
      ${FIRM_B_EMP_PATCH}, ${SUBJECT_B1}, ${TENANT_B},
      'firmb-patch@example.com', 'Firm B Patch', ${ADMIN_USER}
    )
  `;
  try {
    const app = buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/employees/${FIRM_B_EMP_PATCH}`,
      cookies: { cpa_session: await adminJwt() },
      payload: { name: 'Hijack' },
    });
    assert.equal(res.statusCode, 404);
    await app.close();
  } finally {
    await privilegedSql`DELETE FROM subject_tenant_employee WHERE id = ${FIRM_B_EMP_PATCH}`;
  }
});

test('PATCH /v1/employees/:id: 200 + updated row + EMPLOYEE_UPDATED event', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/employees/${EMPLOYEE_PRESEED}`,
    cookies: { cpa_session: await consultantJwt() },
    payload: { name: 'Pre-Seed Updated', job_title: 'Senior Engineer' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ employee: { id: string; name: string; job_title: string | null } }>();
  assert.equal(body.employee.id, EMPLOYEE_PRESEED);
  assert.equal(body.employee.name, 'Pre-Seed Updated');
  assert.equal(body.employee.job_title, 'Senior Engineer');

  // Verify event landed on the chain.
  const eventRows = await privilegedSql<{ kind: string }[]>`
    SELECT kind FROM event
     WHERE kind = 'EMPLOYEE_UPDATED'
       AND payload ->> 'employee_id' = ${EMPLOYEE_PRESEED}
     ORDER BY captured_at DESC LIMIT 1
  `;
  assert.equal(eventRows.length, 1);

  await app.close();
});

// =============================================================================
// DELETE /v1/employees/:id (P5A)
// =============================================================================

test('DELETE /v1/employees/:id: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'DELETE',
    url: `/v1/employees/${EMPLOYEE_PRESEED}`,
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('DELETE /v1/employees/:id: 403 for viewer role', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'DELETE',
    url: `/v1/employees/${EMPLOYEE_PRESEED}`,
    cookies: { cpa_session: await viewerJwt() },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('DELETE /v1/employees/:id: 404 cross-firm (RLS isolation)', async () => {
  const FIRM_B_EMP_DEL = '00000000-0000-4000-8000-0000000f6051';
  await privilegedSql`
    INSERT INTO subject_tenant_employee (
      id, subject_tenant_id, tenant_id, email, name, invited_by_user_id
    ) VALUES (
      ${FIRM_B_EMP_DEL}, ${SUBJECT_B1}, ${TENANT_B},
      'firmb-del@example.com', 'Firm B Del', ${ADMIN_USER}
    )
  `;
  try {
    const app = buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/employees/${FIRM_B_EMP_DEL}`,
      cookies: { cpa_session: await adminJwt() },
    });
    assert.equal(res.statusCode, 404);
    await app.close();
  } finally {
    await privilegedSql`DELETE FROM subject_tenant_employee WHERE id = ${FIRM_B_EMP_DEL}`;
  }
});

test('DELETE /v1/employees/:id: 204 soft-deactivates employee + emits EMPLOYEE_DEACTIVATED', async () => {
  // Create a dedicated employee to deactivate (can't re-use EMPLOYEE_PRESEED
  // as further invite tests depend on it being active).
  const DEACTIVATE_EMP = '00000000-0000-4000-8000-0000000f6052';
  await privilegedSql`
    INSERT INTO subject_tenant_employee (
      id, subject_tenant_id, tenant_id, email, name, invited_by_user_id
    ) VALUES (
      ${DEACTIVATE_EMP}, ${SUBJECT_A1}, ${TENANT_A},
      'to-deactivate@example.com', 'To Deactivate', ${ADMIN_USER}
    )
  `;
  const app = buildApp();
  const res = await app.inject({
    method: 'DELETE',
    url: `/v1/employees/${DEACTIVATE_EMP}`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 204);

  // Row should be soft-deactivated.
  const row = await privilegedSql<{ deactivated_at: Date | null }[]>`
    SELECT deactivated_at FROM subject_tenant_employee WHERE id = ${DEACTIVATE_EMP}
  `;
  assert.ok(row[0]?.deactivated_at !== null);

  // Chain event emitted.
  const eventRows = await privilegedSql<{ kind: string }[]>`
    SELECT kind FROM event
     WHERE kind = 'EMPLOYEE_DEACTIVATED'
       AND payload ->> 'employee_id' = ${DEACTIVATE_EMP}
     ORDER BY captured_at DESC LIMIT 1
  `;
  assert.equal(eventRows.length, 1);

  await app.close();
});
