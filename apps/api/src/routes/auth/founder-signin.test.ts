import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../../app.js';
import { signFounderSigninToken } from '../../lib/founder-signin-token.js';

const TEST_SESSION_SECRET = 'test-founder-signin-session-secret-32+bytes!!';
const TEST_EMAIL = 'founder-signin-test@example.com';
const TEST_FIRM = 'Founder Signin Test Firm';

function buildHostedApp() {
  return buildApp({
    founderSignin: {
      sessionSecret: TEST_SESSION_SECRET,
      cookieName: 'cpa_session',
      cookieSecure: false,
      ttlSeconds: 3600,
    },
  });
}

interface SeededUserTenant {
  userId: string;
  tenantId: string;
}

async function seedUserAndTenant(): Promise<SeededUserTenant> {
  const userId = crypto.randomUUID();
  const tenantId = crypto.randomUUID();
  await privilegedSql`
    INSERT INTO "user" (id, email, primary_idp, external_id)
    VALUES (${userId}, ${TEST_EMAIL}, 'email', ${TEST_EMAIL})
  `;
  await privilegedSql`
    INSERT INTO tenant (id, name, slug, primary_idp, trial_status, trial_ends_at, billing_mode)
    VALUES (
      ${tenantId},
      ${TEST_FIRM},
      ${`founder-signin-test-${tenantId.slice(0, 8)}`},
      'mixed',
      'active',
      ${new Date(Date.now() + 30 * 86400_000).toISOString()},
      'trial'
    )
  `;
  await privilegedSql`
    INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
    VALUES (gen_random_uuid(), ${tenantId}, ${userId}, 'admin', true)
  `;
  return { userId, tenantId };
}

async function cleanup() {
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id IN (
    SELECT id FROM tenant WHERE name = ${TEST_FIRM}
  )`;
  await privilegedSql`DELETE FROM tenant WHERE name = ${TEST_FIRM}`;
  await sql`DELETE FROM "user" WHERE email = ${TEST_EMAIL}`;
}

before(cleanup);
after(cleanup);

test('founder-signin: 401 HTML on missing token', async () => {
  await cleanup();
  const app = buildHostedApp();
  const res = await app.inject({ method: 'GET', url: '/v1/auth/founder-issued-signin' });
  assert.equal(res.statusCode, 401);
  assert.match(res.headers['content-type'] ?? '', /text\/html/);
  await app.close();
});

test('founder-signin: 401 HTML on invalid token', async () => {
  await cleanup();
  const app = buildHostedApp();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/auth/founder-issued-signin?token=not-a-real-jwt',
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('founder-signin: 401 HTML on expired token', async () => {
  await cleanup();
  const seeded = await seedUserAndTenant();
  const app = buildHostedApp();
  const expired = await signFounderSigninToken(
    { sub: seeded.userId, email: TEST_EMAIL, tenantId: seeded.tenantId },
    TEST_SESSION_SECRET,
    { ttlSeconds: -10 },
  );
  const res = await app.inject({
    method: 'GET',
    url: `/v1/auth/founder-issued-signin?token=${encodeURIComponent(expired)}`,
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('founder-signin: happy path sets cookie and 302-redirects to /subject-tenants', async () => {
  await cleanup();
  const seeded = await seedUserAndTenant();
  const app = buildHostedApp();
  const token = await signFounderSigninToken(
    { sub: seeded.userId, email: TEST_EMAIL, tenantId: seeded.tenantId },
    TEST_SESSION_SECRET,
  );
  const res = await app.inject({
    method: 'GET',
    url: `/v1/auth/founder-issued-signin?token=${encodeURIComponent(token)}`,
  });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers['location'], '/subject-tenants');
  const setCookie = res.headers['set-cookie'] as string | string[];
  const cookieStr = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie;
  assert.ok(cookieStr?.includes('cpa_session='), 'session cookie must be set');
  await app.close();
});

test('founder-signin: 401 when JWT email does not match user row', async () => {
  await cleanup();
  const seeded = await seedUserAndTenant();
  const app = buildHostedApp();
  const token = await signFounderSigninToken(
    { sub: seeded.userId, email: 'mismatched@example.com', tenantId: seeded.tenantId },
    TEST_SESSION_SECRET,
  );
  const res = await app.inject({
    method: 'GET',
    url: `/v1/auth/founder-issued-signin?token=${encodeURIComponent(token)}`,
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('founder-signin: 401 when tenant in JWT is not a membership of the user', async () => {
  await cleanup();
  const seeded = await seedUserAndTenant();
  const app = buildHostedApp();
  const token = await signFounderSigninToken(
    {
      sub: seeded.userId,
      email: TEST_EMAIL,
      tenantId: crypto.randomUUID(), // not a real tenant for this user
    },
    TEST_SESSION_SECRET,
  );
  const res = await app.inject({
    method: 'GET',
    url: `/v1/auth/founder-issued-signin?token=${encodeURIComponent(token)}`,
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});
