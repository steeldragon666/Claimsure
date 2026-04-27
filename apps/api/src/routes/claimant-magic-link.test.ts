import crypto from 'node:crypto';
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { jwtVerify } from 'jose';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../app.js';

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';
process.env['SESSION_JWT_SECRET'] = SESSION_SECRET;

// UUIDs are 8-4-4-4-12 hex chars. The original c11 fixtures had 13 chars in
// the last group (8 zeros + "c1xxx" 5-char suffix); fixed to 7 zeros + 5-char
// suffix to land on the canonical 12-char width, matching the a3/a6/a12
// fixture convention elsewhere in the test suite.
const TENANT_A = '00000000-0000-4000-8000-0000000c1101';
const ADMIN_USER = '00000000-0000-4000-8000-0000000c1110';
const SUBJECT_A1 = '00000000-0000-4000-8000-0000000c1121';
const EMPLOYEE_VALID = '00000000-0000-4000-8000-0000000c1130';
const EMPLOYEE_DEACTIVATED = '00000000-0000-4000-8000-0000000c1131';

const cleanup = async (): Promise<void> => {
  await privilegedSql`
    DELETE FROM magic_link_token WHERE employee_id IN (
      SELECT id FROM subject_tenant_employee WHERE tenant_id = ${TENANT_A}
    )
  `;
  await privilegedSql`DELETE FROM subject_tenant_employee WHERE tenant_id = ${TENANT_A}`;
  await privilegedSql`DELETE FROM subject_tenant WHERE tenant_id = ${TENANT_A}`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id = ${TENANT_A}`;
  await sql`DELETE FROM "user" WHERE id = ${ADMIN_USER}`;
  await sql`DELETE FROM tenant WHERE id = ${TENANT_A}`;
};

before(async () => {
  await cleanup();
  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT_A}, 'Firm C11', 'firm-c11', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${ADMIN_USER}, 'c11-admin@example.com', 'microsoft', 'microsoft:c11-admin', 'C11 Admin')`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT_A}, ${ADMIN_USER}, 'admin', true)`;
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                       VALUES (${SUBJECT_A1}, ${TENANT_A}, 'Acme Co', 'claimant')`;
  await privilegedSql`
    INSERT INTO subject_tenant_employee (
      id, subject_tenant_id, tenant_id, email, name, invited_by_user_id
    ) VALUES
      (${EMPLOYEE_VALID}, ${SUBJECT_A1}, ${TENANT_A}, 'c11-valid@example.com', 'Valid', ${ADMIN_USER}),
      (${EMPLOYEE_DEACTIVATED}, ${SUBJECT_A1}, ${TENANT_A}, 'c11-inactive@example.com', 'Inactive', ${ADMIN_USER})
  `;
  await privilegedSql`
    UPDATE subject_tenant_employee
       SET deactivated_at = NOW()
     WHERE id = ${EMPLOYEE_DEACTIVATED}
  `;
});

after(async () => {
  await cleanup();
  await sql.end();
  await privilegedSql.end();
});

interface IssuedToken {
  rawToken: string;
  tokenHash: string;
}

const issueToken = (): IssuedToken => {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  return { rawToken, tokenHash };
};

const insertToken = async (
  employeeId: string,
  expiresAt: Date,
  consumedAt: Date | null = null,
): Promise<IssuedToken> => {
  const { rawToken, tokenHash } = issueToken();
  await privilegedSql`
    INSERT INTO magic_link_token (id, employee_id, token_hash, expires_at, consumed_at)
    VALUES (${crypto.randomUUID()}, ${employeeId}, ${tokenHash}, ${expiresAt.toISOString()}::timestamptz,
            ${consumedAt === null ? null : consumedAt.toISOString()}::timestamptz)
  `;
  return { rawToken, tokenHash };
};

/**
 * Pull the cpa_claimant_session value out of a Set-Cookie header. Returns
 * the raw cookie value (the JWT) and the attribute string for assertions.
 */
const parseClaimantSetCookie = (
  setCookieHeader: string | string[] | undefined,
): { jwt: string; attrs: string } | null => {
  if (!setCookieHeader) return null;
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const h of headers) {
    if (h.startsWith('cpa_claimant_session=')) {
      const semi = h.indexOf(';');
      const eq = h.indexOf('=');
      const jwt = h.slice(eq + 1, semi >= 0 ? semi : undefined);
      const attrs = semi >= 0 ? h.slice(semi + 1).trim() : '';
      return { jwt, attrs };
    }
  }
  return null;
};

test('POST /v1/claimant-auth/redeem: 200 + Set-Cookie (httpOnly, SameSite=Lax)', async () => {
  const expires = new Date(Date.now() + 10 * 60 * 1000);
  const { rawToken } = await insertToken(EMPLOYEE_VALID, expires);

  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/claimant-auth/redeem',
    payload: { token: rawToken },
  });
  assert.equal(res.statusCode, 200);

  const setCookie = parseClaimantSetCookie(res.headers['set-cookie']);
  assert.ok(setCookie, 'expected cpa_claimant_session Set-Cookie header');
  assert.match(setCookie.attrs, /HttpOnly/i);
  assert.match(setCookie.attrs, /SameSite=Lax/i);
  assert.match(setCookie.attrs, /Path=\//i);
  // 90 days = 7,776,000 seconds. Look for that exact Max-Age.
  assert.match(setCookie.attrs, /Max-Age=7776000/);

  // Verify the JWT verifies under the PWA-claimant audience.
  const { payload } = await jwtVerify(setCookie.jwt, new TextEncoder().encode(SESSION_SECRET), {
    audience: 'pwa-claimant',
  });
  assert.equal(payload.sub, EMPLOYEE_VALID);
  assert.equal(payload['tenant_id'], TENANT_A);
  assert.equal(payload['subject_tenant_id'], SUBJECT_A1);

  // Body carries a small employee summary the redirect can show.
  const body = res.json<{ ok: boolean; employee: { id: string; name: string } }>();
  assert.equal(body.ok, true);
  assert.equal(body.employee.id, EMPLOYEE_VALID);
  assert.equal(body.employee.name, 'Valid');

  // Verify the magic-link token is now consumed.
  const consumed = await privilegedSql<{ consumed_at: Date | null }[]>`
    SELECT consumed_at FROM magic_link_token
     WHERE token_hash = ${crypto.createHash('sha256').update(rawToken).digest('hex')}
  `;
  assert.ok(consumed[0]?.consumed_at !== null);

  // Employee's first_seen_at + last_seen_at populated.
  const empCheck = await privilegedSql<
    {
      first_seen_at: Date | null;
      last_seen_at: Date | null;
    }[]
  >`
    SELECT first_seen_at, last_seen_at FROM subject_tenant_employee WHERE id = ${EMPLOYEE_VALID}
  `;
  assert.ok(empCheck[0]?.first_seen_at !== null);
  assert.ok(empCheck[0]?.last_seen_at !== null);

  await app.close();
});

test('POST /v1/claimant-auth/redeem: 401 on expired token', async () => {
  const expired = new Date(Date.now() - 1000);
  const { rawToken } = await insertToken(EMPLOYEE_VALID, expired);

  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/claimant-auth/redeem',
    payload: { token: rawToken },
  });
  assert.equal(res.statusCode, 401);
  // Expired tokens shouldn't set a cookie.
  assert.equal(parseClaimantSetCookie(res.headers['set-cookie']), null);
  await app.close();
});

test('POST /v1/claimant-auth/redeem: 401 on already-consumed token', async () => {
  const expires = new Date(Date.now() + 10 * 60 * 1000);
  const consumed = new Date(Date.now() - 1000);
  const { rawToken } = await insertToken(EMPLOYEE_VALID, expires, consumed);

  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/claimant-auth/redeem',
    payload: { token: rawToken },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(parseClaimantSetCookie(res.headers['set-cookie']), null);
  await app.close();
});

test('POST /v1/claimant-auth/redeem: 401 on unknown token', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/claimant-auth/redeem',
    payload: {
      token: 'not-a-real-token-' + crypto.randomBytes(16).toString('hex'),
    },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /v1/claimant-auth/redeem: 400 on missing token', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/claimant-auth/redeem',
    payload: {},
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /v1/claimant-auth/redeem: 401 on token for deactivated employee', async () => {
  const expires = new Date(Date.now() + 10 * 60 * 1000);
  const { rawToken } = await insertToken(EMPLOYEE_DEACTIVATED, expires);

  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/claimant-auth/redeem',
    payload: { token: rawToken },
  });
  assert.equal(res.statusCode, 401);
  // Token still consumed (single-use is single-use).
  const consumed = await privilegedSql<{ consumed_at: Date | null }[]>`
    SELECT consumed_at FROM magic_link_token
     WHERE token_hash = ${crypto.createHash('sha256').update(rawToken).digest('hex')}
  `;
  assert.ok(consumed[0]?.consumed_at !== null);
  await app.close();
});

test('cookie carries Secure attribute when NODE_ENV=production', async () => {
  const prevNodeEnv = process.env['NODE_ENV'];
  process.env['NODE_ENV'] = 'production';
  try {
    const expires = new Date(Date.now() + 10 * 60 * 1000);
    const { rawToken } = await insertToken(EMPLOYEE_VALID, expires);
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/claimant-auth/redeem',
      payload: { token: rawToken },
    });
    assert.equal(res.statusCode, 200);
    const setCookie = parseClaimantSetCookie(res.headers['set-cookie']);
    assert.ok(setCookie);
    assert.match(setCookie.attrs, /Secure/i);
    await app.close();
  } finally {
    if (prevNodeEnv === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = prevNodeEnv;
  }
});
