import crypto from 'node:crypto';
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../app.js';

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';
process.env['SESSION_JWT_SECRET'] = SESSION_SECRET;

// UUIDs are 8-4-4-4-12 hex chars. Original c12 fixtures had 13 chars in the
// last group (8 zeros + "c12xx" 5-char suffix); fixed to 7 zeros + 5-char
// suffix to land on the canonical 12-char width.
const TENANT_A = '00000000-0000-4000-8000-0000000c1201';
const TENANT_B = '00000000-0000-4000-8000-0000000c1202';
const ADMIN_USER = '00000000-0000-4000-8000-0000000c1210';
const SUBJECT_A1 = '00000000-0000-4000-8000-0000000c1221';
const SUBJECT_A2 = '00000000-0000-4000-8000-0000000c1222';
const SUBJECT_B1 = '00000000-0000-4000-8000-0000000c1223';
const EMPLOYEE_A1 = '00000000-0000-4000-8000-0000000c1230';

const cleanup = async (): Promise<void> => {
  await privilegedSql`DELETE FROM event WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM subject_tenant_employee WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM brand_config WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM subject_tenant WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await sql`DELETE FROM "user" WHERE id = ${ADMIN_USER}`;
  await sql`DELETE FROM tenant WHERE id IN (${TENANT_A}, ${TENANT_B})`;
};

before(async () => {
  await cleanup();
  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT_A}, 'Firm C12 A', 'firm-c12-a', 'mixed'),
                   (${TENANT_B}, 'Firm C12 B', 'firm-c12-b', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${ADMIN_USER}, 'c12-admin@example.com', 'microsoft', 'microsoft:c12-admin', 'C12 Admin')`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT_A}, ${ADMIN_USER}, 'admin', true)`;
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                       VALUES (${SUBJECT_A1}, ${TENANT_A}, 'Acme Co', 'claimant'),
                              (${SUBJECT_A2}, ${TENANT_A}, 'Acme Sister', 'claimant'),
                              (${SUBJECT_B1}, ${TENANT_B}, 'Other Corp', 'claimant')`;
  await privilegedSql`
    INSERT INTO brand_config (
      tenant_id, display_name, primary_color, accent_color, logo_s3_key
    ) VALUES
      (${TENANT_A}, 'Firm C12 A Brand', '#11aabb', '#22ccdd', 'firma/logo.svg')
  `;
  await privilegedSql`
    INSERT INTO subject_tenant_employee (
      id, subject_tenant_id, tenant_id, email, name, invited_by_user_id
    ) VALUES
      (${EMPLOYEE_A1}, ${SUBJECT_A1}, ${TENANT_A}, 'c12-jane@acme.com', 'Jane', ${ADMIN_USER})
  `;
  // Insert 6 events so we can verify "last 5" + ordering.
  // The `${JSON.stringify(obj)}::jsonb` pattern stores as a jsonb-string
  // scalar in the prepared-statement path raw test-seeds use; the route's
  // eventSnippet handles both string- and object-shaped payloads
  // defensively, so this is fine. (The earlier sql.json() approach worked
  // for the row contents but caused the test runner to hang at process-
  // exit time — the Parameter objects appear to hold a reference that
  // blocks `privilegedSql.end()` from completing.)
  for (let i = 0; i < 6; i++) {
    const id = crypto.randomUUID();
    const hash = crypto.randomBytes(32).toString('hex');
    const captured = new Date(Date.now() - (6 - i) * 60_000).toISOString();
    const idempotency = crypto.randomBytes(32).toString('hex');
    await privilegedSql`
      INSERT INTO event (
        id, tenant_id, subject_tenant_id, kind, payload, hash, idempotency_key,
        captured_at, captured_by_user_id
      ) VALUES (
        ${id}, ${TENANT_A}, ${SUBJECT_A1}, 'HYPOTHESIS',
        ${JSON.stringify({ _v: 1, source: 'paste', raw_text: `Hypothesis number ${i} with extra padding text to test the 80-char snippet truncation behaviour properly.` })}::jsonb,
        ${hash}, ${idempotency},
        ${captured}::timestamptz, ${ADMIN_USER}
      )
    `;
  }
});

after(async () => {
  await cleanup();
  await sql.end();
  await privilegedSql.end();
});

const signClaimantCookie = async (
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
    .setAudience('pwa-claimant')
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(new TextEncoder().encode(SESSION_SECRET));
};

test('GET /v1/claimant-status/:id: 200 with full payload', async () => {
  const cookie = await signClaimantCookie(EMPLOYEE_A1, TENANT_A, SUBJECT_A1);

  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/claimant-status/${SUBJECT_A1}`,
    cookies: { cpa_claimant_session: cookie },
  });
  assert.equal(res.statusCode, 200);

  const body = res.json<{
    subject_tenant: { id: string; name: string; kind: string };
    brand: { display_name: string; primary_color: string; logo_s3_key: string | null };
    claim_stage: string;
    recent_events: Array<{ id: string; kind: string; captured_at: string; snippet: string }>;
    pending_rfis: unknown[];
  }>();

  assert.equal(body.subject_tenant.id, SUBJECT_A1);
  assert.equal(body.subject_tenant.name, 'Acme Co');
  assert.equal(body.subject_tenant.kind, 'claimant');

  assert.equal(body.brand.display_name, 'Firm C12 A Brand');
  assert.equal(body.brand.primary_color, '#11aabb');
  assert.equal(body.brand.logo_s3_key, 'firma/logo.svg');

  assert.equal(body.claim_stage, 'activity_capture');

  // Last 5 events, newest first. We inserted 6, so the oldest is dropped.
  assert.equal(body.recent_events.length, 5);
  // Each snippet is the raw_text truncated to 80 chars + ellipsis.
  for (const ev of body.recent_events) {
    assert.equal(ev.kind, 'HYPOTHESIS');
    assert.ok(ev.snippet.length <= 81); // 80 + ellipsis
    assert.match(ev.snippet, /^Hypothesis number \d+/);
  }
  // Newest captured_at first.
  const times = body.recent_events.map((e) => new Date(e.captured_at).getTime());
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i - 1]! >= times[i]!);
  }

  assert.deepEqual(body.pending_rfis, []);

  await app.close();
});

test('GET /v1/claimant-status/:id: 401 without cookie', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/claimant-status/${SUBJECT_A1}`,
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('GET /v1/claimant-status/:id: 401 with invalid cookie', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/claimant-status/${SUBJECT_A1}`,
    cookies: { cpa_claimant_session: 'not.a.valid.jwt' },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('GET /v1/claimant-status/:id: 404 cross-firm (different tenant)', async () => {
  // Cookie says employee belongs to TENANT_A / SUBJECT_A1, asking for
  // SUBJECT_B1 (TENANT_B's claimant). 404 — not an authorisation leak.
  const cookie = await signClaimantCookie(EMPLOYEE_A1, TENANT_A, SUBJECT_A1);
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/claimant-status/${SUBJECT_B1}`,
    cookies: { cpa_claimant_session: cookie },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('GET /v1/claimant-status/:id: 404 cross-claimant within same firm', async () => {
  // Cookie says employee belongs to SUBJECT_A1; asking for SUBJECT_A2
  // (same firm, different claimant). Still 404 — claimant employees
  // are scoped to their own claimant only.
  const cookie = await signClaimantCookie(EMPLOYEE_A1, TENANT_A, SUBJECT_A1);
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/claimant-status/${SUBJECT_A2}`,
    cookies: { cpa_claimant_session: cookie },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});
