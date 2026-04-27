import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { signSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../app.js';

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

const TENANT_A = '00000000-0000-4000-8000-0000000f9001';
const TENANT_B = '00000000-0000-4000-8000-0000000f9002';
const ADMIN_USER = '00000000-0000-4000-8000-0000000f9010';
const VIEWER_USER = '00000000-0000-4000-8000-0000000f9011';
const CONSULTANT_USER = '00000000-0000-4000-8000-0000000f9012';

const cleanup = async (): Promise<void> => {
  await privilegedSql`DELETE FROM brand_config WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await sql`DELETE FROM "user" WHERE id IN (${ADMIN_USER}, ${VIEWER_USER}, ${CONSULTANT_USER})`;
  await sql`DELETE FROM tenant WHERE id IN (${TENANT_A}, ${TENANT_B})`;
};

before(async () => {
  await cleanup();
  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT_A}, 'Firm A', 'firm-a-f9', 'mixed'),
                   (${TENANT_B}, 'Firm B', 'firm-b-f9', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${ADMIN_USER}, 'f9-admin@example.com', 'microsoft', 'microsoft:f9-admin', 'F9 Admin'),
                   (${VIEWER_USER}, 'f9-viewer@example.com', 'microsoft', 'microsoft:f9-viewer', 'F9 Viewer'),
                   (${CONSULTANT_USER}, 'f9-cons@example.com', 'microsoft', 'microsoft:f9-cons', 'F9 Cons')`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT_A}, ${ADMIN_USER}, 'admin', true),
                              (gen_random_uuid(), ${TENANT_A}, ${VIEWER_USER}, 'viewer', true),
                              (gen_random_uuid(), ${TENANT_A}, ${CONSULTANT_USER}, 'consultant', true)`;
  await privilegedSql`
    INSERT INTO brand_config (
      tenant_id, display_name, primary_color, accent_color, logo_s3_key,
      support_email, terms_of_service_url, custom_subdomain,
      email_sender_dkim_status, custom_domain_acm_arn, custom_domain_status
    )
    VALUES
      (${TENANT_A}, 'Firm A Brand', '#112233', '#445566', 'firma/logo.png',
       'help@firma.com', 'https://firma.com/tos', 'firma',
       'verified', 'arn:aws:acm:us-east-1:123:certificate/secret', 'active'),
      (${TENANT_B}, 'Firm B Brand', '#778899', '#aabbcc', NULL,
       NULL, NULL, 'firmb',
       'unconfigured', NULL, 'unconfigured')
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

const adminJwt = (): Promise<string> => jwtFor(ADMIN_USER, 'f9-admin@example.com', 'admin');
const viewerJwt = (): Promise<string> => jwtFor(VIEWER_USER, 'f9-viewer@example.com', 'viewer');
const consultantJwt = (): Promise<string> =>
  jwtFor(CONSULTANT_USER, 'f9-cons@example.com', 'consultant');

test('GET /v1/brand-config/by-tenant/:id: 200 unauthed + public subset only', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/brand-config/by-tenant/${TENANT_A}`,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    brand_config: Record<string, unknown>;
  }>();
  // Public fields present.
  assert.equal(body.brand_config['tenant_id'], TENANT_A);
  assert.equal(body.brand_config['display_name'], 'Firm A Brand');
  assert.equal(body.brand_config['primary_color'], '#112233');
  assert.equal(body.brand_config['accent_color'], '#445566');
  assert.equal(body.brand_config['logo_s3_key'], 'firma/logo.png');
  assert.equal(body.brand_config['support_email'], 'help@firma.com');
  assert.equal(body.brand_config['terms_of_service_url'], 'https://firma.com/tos');
  assert.equal(body.brand_config['custom_subdomain'], 'firma');
  // Operational fields MUST NOT be present.
  assert.ok(!('email_sender_dkim_status' in body.brand_config));
  assert.ok(!('custom_domain_acm_arn' in body.brand_config));
  assert.ok(!('custom_domain_status' in body.brand_config));
  await app.close();
});

test('GET /v1/brand-config/by-tenant/:id: 404 for unknown tenant', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/brand-config/by-tenant/00000000-0000-4000-8000-00000000dead',
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('PATCH /v1/brand-config: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: '/v1/brand-config',
    payload: { display_name: 'New' },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('PATCH /v1/brand-config: 200 admin updates display_name', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: '/v1/brand-config',
    cookies: { cpa_session: await adminJwt() },
    payload: { display_name: 'Firm A Renamed', primary_color: '#aabbcc' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ brand_config: { display_name: string; primary_color: string } }>();
  assert.equal(body.brand_config.display_name, 'Firm A Renamed');
  assert.equal(body.brand_config.primary_color, '#aabbcc');

  // Verify the update landed in the DB.
  const rows = await privilegedSql<{ display_name: string; primary_color: string }[]>`
    SELECT display_name, primary_color FROM brand_config WHERE tenant_id = ${TENANT_A}
  `;
  assert.equal(rows[0]?.display_name, 'Firm A Renamed');
  assert.equal(rows[0]?.primary_color, '#aabbcc');

  // Restore so other tests have predictable state.
  await privilegedSql`
    UPDATE brand_config
       SET display_name = 'Firm A Brand', primary_color = '#112233'
     WHERE tenant_id = ${TENANT_A}
  `;
  await app.close();
});

test('PATCH /v1/brand-config: 403 for consultant role', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: '/v1/brand-config',
    cookies: { cpa_session: await consultantJwt() },
    payload: { display_name: 'Should-Fail' },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('PATCH /v1/brand-config: 403 for viewer role', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: '/v1/brand-config',
    cookies: { cpa_session: await viewerJwt() },
    payload: { display_name: 'Should-Fail-Too' },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('PATCH /v1/brand-config: 400 on invalid color hex', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: '/v1/brand-config',
    cookies: { cpa_session: await adminJwt() },
    payload: { primary_color: 'not-a-color' },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('PATCH /v1/brand-config: 400 on 3-digit hex shorthand (must be 6 digits)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: '/v1/brand-config',
    cookies: { cpa_session: await adminJwt() },
    payload: { primary_color: '#fff' },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('PATCH /v1/brand-config: 400 on extraneous (non-editable) field', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: '/v1/brand-config',
    cookies: { cpa_session: await adminJwt() },
    // custom_subdomain is editable only via the C5-C9 wizard.
    payload: { custom_subdomain: 'attacker-takes-over-firma' },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('PATCH /v1/brand-config: 400 on empty body', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: '/v1/brand-config',
    cookies: { cpa_session: await adminJwt() },
    payload: {},
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});
