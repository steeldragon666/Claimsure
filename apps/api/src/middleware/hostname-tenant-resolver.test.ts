import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { sql, privilegedSql } from '@cpa/db/client';
import { registerHostnameTenantResolver, type ResolvedBrand } from './hostname-tenant-resolver.js';

const TENANT_A = '00000000-0000-4000-8000-0000000f4001';
const TENANT_B = '00000000-0000-4000-8000-0000000f4002';

const cleanup = async (): Promise<void> => {
  await privilegedSql`DELETE FROM brand_config WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await sql`DELETE FROM tenant WHERE id IN (${TENANT_A}, ${TENANT_B})`;
};

before(async () => {
  await cleanup();
  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT_A}, 'Acme Co', 'acme-f4', 'mixed'),
                   (${TENANT_B}, 'Beta Inc', 'beta-f4', 'mixed')`;
  // Two distinct hostname styles: TENANT_A uses the *.platform.com.au
  // subdomain, TENANT_B uses a custom apex.
  await privilegedSql`
    INSERT INTO brand_config (
      tenant_id, display_name, primary_color, accent_color, logo_s3_key,
      custom_subdomain, custom_domain
    )
    VALUES
      (${TENANT_A}, 'Acme Brand', '#ff0000', '#00ff00', 'acme/logo.png', 'acme', NULL),
      (${TENANT_B}, 'Beta Brand', '#0000ff', '#ffff00', NULL, NULL, 'accounts.beta.com.au')
  `;
});

after(async () => {
  await cleanup();
  await sql.end();
  await privilegedSql.end();
});

/**
 * Build a tiny Fastify app with only the resolver registered — the test
 * route echoes whatever `req.resolvedBrand` ends up as so we can assert
 * the hook's effect without dragging in the rest of the app surface.
 */
const buildResolverApp = (): FastifyInstance => {
  const app = Fastify();
  registerHostnameTenantResolver(app);
  app.get('/probe', (req) => ({ resolved: req.resolvedBrand ?? null }));
  return app;
};

test('subdomain match populates req.resolvedBrand', async () => {
  const app = buildResolverApp();
  const res = await app.inject({
    method: 'GET',
    url: '/probe',
    headers: { host: 'acme.platform.com.au' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ resolved: ResolvedBrand | null }>();
  assert.ok(body.resolved);
  assert.equal(body.resolved.tenant_id, TENANT_A);
  assert.equal(body.resolved.display_name, 'Acme Brand');
  assert.equal(body.resolved.primary_color, '#ff0000');
  assert.equal(body.resolved.accent_color, '#00ff00');
  assert.equal(body.resolved.logo_s3_key, 'acme/logo.png');
  await app.close();
});

test('subdomain match is case-insensitive on hostname', async () => {
  const app = buildResolverApp();
  const res = await app.inject({
    method: 'GET',
    url: '/probe',
    headers: { host: 'AcMe.PLATFORM.com.au' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ resolved: ResolvedBrand | null }>();
  assert.ok(body.resolved);
  assert.equal(body.resolved.tenant_id, TENANT_A);
  await app.close();
});

test('custom_domain match populates req.resolvedBrand', async () => {
  const app = buildResolverApp();
  const res = await app.inject({
    method: 'GET',
    url: '/probe',
    headers: { host: 'accounts.beta.com.au' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ resolved: ResolvedBrand | null }>();
  assert.ok(body.resolved);
  assert.equal(body.resolved.tenant_id, TENANT_B);
  assert.equal(body.resolved.display_name, 'Beta Brand');
  assert.equal(body.resolved.logo_s3_key, null);
  await app.close();
});

test('unknown hostname → req.resolvedBrand stays undefined', async () => {
  const app = buildResolverApp();
  const res = await app.inject({
    method: 'GET',
    url: '/probe',
    headers: { host: 'somewhere-else.example.com' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ resolved: ResolvedBrand | null }>();
  assert.equal(body.resolved, null);
  await app.close();
});

test('unknown subdomain on platform.com.au → no resolution + no fallback to custom_domain', async () => {
  const app = buildResolverApp();
  const res = await app.inject({
    method: 'GET',
    url: '/probe',
    headers: { host: 'unconfigured.platform.com.au' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ resolved: ResolvedBrand | null }>();
  assert.equal(body.resolved, null);
  await app.close();
});

test('platform.com.au default host → no resolution', async () => {
  const app = buildResolverApp();
  const res = await app.inject({
    method: 'GET',
    url: '/probe',
    headers: { host: 'platform.com.au' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ resolved: ResolvedBrand | null }>();
  assert.equal(body.resolved, null);
  await app.close();
});

test('host with :port suffix is normalised before matching', async () => {
  const app = buildResolverApp();
  const res = await app.inject({
    method: 'GET',
    url: '/probe',
    headers: { host: 'acme.platform.com.au:3000' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ resolved: ResolvedBrand | null }>();
  assert.ok(body.resolved);
  assert.equal(body.resolved.tenant_id, TENANT_A);
  await app.close();
});

test('missing Host header → no resolution', async () => {
  const app = buildResolverApp();
  // fastify-inject always synthesises a Host header; pass empty string
  // explicitly to exercise the branch.
  const res = await app.inject({
    method: 'GET',
    url: '/probe',
    headers: { host: '' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ resolved: ResolvedBrand | null }>();
  assert.equal(body.resolved, null);
  await app.close();
});
