import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { signSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../app.js';

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

const TENANT_ID = '00000000-0000-4000-8000-0000000000c1';
const USER_ID = '00000000-0000-4000-8000-00000000c001';

after(async () => {
  await sql.end();
  await privilegedSql.end();
});

test('GET /v1/whoami: 401 when no session cookie', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/v1/whoami' });
  assert.equal(res.statusCode, 401);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'unauthenticated');
  await app.close();
});

test('GET /v1/whoami: 200 with user + tenant info when authenticated', async () => {
  // Seed: a tenant + user + tenant_user membership (privileged path)
  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT_ID}, 'Whoami Firm', 'whoami-firm', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id)
            VALUES (${USER_ID}, 'whoami@example.com', 'microsoft', 'microsoft:test-whoami')`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT_ID}, ${USER_ID}, 'consultant', true)`;

  try {
    const jwt = await signSession(
      {
        sub: USER_ID,
        email: 'whoami@example.com',
        primaryIdp: 'microsoft',
        activeTenantId: TENANT_ID,
        activeRole: 'consultant',
        availableTenants: [
          { tenantId: TENANT_ID, name: 'Whoami Firm', slug: 'whoami-firm', role: 'consultant' },
        ],
      },
      SESSION_SECRET,
      { ttlSeconds: 3600 },
    );

    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/whoami',
      cookies: { cpa_session: jwt },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{
      user: { id: string; email: string; tenantId: string; role: string };
      availableTenants: Array<{
        tenantId: string;
        name: string;
        slug: string;
        role: string;
        isDefault: boolean;
      }>;
    }>();
    assert.equal(body.user.id, USER_ID);
    assert.equal(body.user.email, 'whoami@example.com');
    assert.equal(body.user.tenantId, TENANT_ID);
    assert.equal(body.user.role, 'consultant');
    assert.equal(body.availableTenants.length, 1);
    assert.equal(body.availableTenants[0]?.tenantId, TENANT_ID);
    assert.equal(body.availableTenants[0]?.role, 'consultant');
    assert.equal(body.availableTenants[0]?.isDefault, true);
    await app.close();
  } finally {
    await privilegedSql`DELETE FROM tenant_user WHERE user_id = ${USER_ID}`;
    await sql`DELETE FROM "user" WHERE id = ${USER_ID}`;
    await sql`DELETE FROM tenant WHERE id = ${TENANT_ID}`;
  }
});

test('GET /v1/whoami: 401 + cookie cleared when JWT expired', async () => {
  const jwt = await signSession(
    {
      sub: USER_ID,
      email: 'expired@example.com',
      primaryIdp: 'microsoft',
      activeTenantId: null,
      activeRole: null,
      availableTenants: [],
    },
    SESSION_SECRET,
    { ttlSeconds: -1 },
  );
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/whoami',
    cookies: { cpa_session: jwt },
  });
  assert.equal(res.statusCode, 401);
  const setCookie = res.headers['set-cookie'];
  const setCookieStr = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie);
  assert.match(setCookieStr, /cpa_session=;.*Max-Age=0/i, 'cookie cleared on expired JWT');
  await app.close();
});
