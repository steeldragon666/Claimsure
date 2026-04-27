import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import {
  MOBILE_AUDIENCE,
  requireMobileSession,
  type MobilePrincipal,
} from './mobile-jwt-verifier.js';

const SECRET = 'mobile-test-secret-32-bytes-pad!!';
const SECRET_KEY = new TextEncoder().encode(SECRET);

const EMPLOYEE_ID = '00000000-0000-4000-8000-0000000f5001';
const TENANT_ID = '00000000-0000-4000-8000-0000000f5002';
const SUBJECT_TENANT_ID = '00000000-0000-4000-8000-0000000f5003';

interface JwtClaimOverrides {
  audience?: string;
  ttlSeconds?: number;
  sub?: string;
  tenantId?: string;
  subjectTenantId?: string;
  omitTenantId?: boolean;
  omitSubjectTenantId?: boolean;
  omitSub?: boolean;
}

const mintJwt = async (opts: JwtClaimOverrides = {}): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  const ttl = opts.ttlSeconds ?? 3600;
  const builder = new SignJWT({
    ...(opts.omitTenantId ? {} : { tenant_id: opts.tenantId ?? TENANT_ID }),
    ...(opts.omitSubjectTenantId
      ? {}
      : { subject_tenant_id: opts.subjectTenantId ?? SUBJECT_TENANT_ID }),
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setAudience(opts.audience ?? MOBILE_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + ttl);
  if (!opts.omitSub) {
    builder.setSubject(opts.sub ?? EMPLOYEE_ID);
  }
  return await builder.sign(SECRET_KEY);
};

const buildVerifierApp = (): FastifyInstance => {
  process.env['SESSION_JWT_SECRET'] = SECRET;
  const app = Fastify();
  app.get('/probe', { preHandler: requireMobileSession }, (req) => ({
    mobileUser: req.mobileUser ?? null,
  }));
  return app;
};

test('valid aud=mobile token populates req.mobileUser', async () => {
  const app = buildVerifierApp();
  const token = await mintJwt();
  const res = await app.inject({
    method: 'GET',
    url: '/probe',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ mobileUser: MobilePrincipal | null }>();
  assert.ok(body.mobileUser);
  assert.equal(body.mobileUser.kind, 'employee');
  assert.equal(body.mobileUser.employeeId, EMPLOYEE_ID);
  assert.equal(body.mobileUser.tenantId, TENANT_ID);
  assert.equal(body.mobileUser.subjectTenantId, SUBJECT_TENANT_ID);
  await app.close();
});

test('missing Authorization header → 401 UNAUTHENTICATED', async () => {
  const app = buildVerifierApp();
  const res = await app.inject({ method: 'GET', url: '/probe' });
  assert.equal(res.statusCode, 401);
  const body = res.json<{ error: { code: string; message: string } }>();
  assert.equal(body.error.code, 'UNAUTHENTICATED');
  assert.equal(body.error.message, 'Bearer token required');
  await app.close();
});

test('non-Bearer scheme → 401', async () => {
  const app = buildVerifierApp();
  const token = await mintJwt();
  const res = await app.inject({
    method: 'GET',
    url: '/probe',
    headers: { authorization: `Basic ${token}` },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('Bearer with empty token → 401', async () => {
  const app = buildVerifierApp();
  const res = await app.inject({
    method: 'GET',
    url: '/probe',
    headers: { authorization: 'Bearer ' },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('expired token → 401 invalid or expired', async () => {
  const app = buildVerifierApp();
  // Negative TTL → exp is in the past, jose rejects on verify.
  const token = await mintJwt({ ttlSeconds: -10 });
  const res = await app.inject({
    method: 'GET',
    url: '/probe',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 401);
  const body = res.json<{ error: { code: string; message: string } }>();
  assert.equal(body.error.code, 'UNAUTHENTICATED');
  assert.equal(body.error.message, 'invalid or expired token');
  await app.close();
});

test("wrong audience (aud='web') → 401", async () => {
  const app = buildVerifierApp();
  const token = await mintJwt({ audience: 'web' });
  const res = await app.inject({
    method: 'GET',
    url: '/probe',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test("wrong audience (aud='cpa-api', the consultant audience) → 401", async () => {
  // Defends against the "leaked web cookie reused at /v1/mobile/*" path —
  // the consultant-session JWTs use AUDIENCE='cpa-api', not 'mobile'.
  const app = buildVerifierApp();
  const token = await mintJwt({ audience: 'cpa-api' });
  const res = await app.inject({
    method: 'GET',
    url: '/probe',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('malformed token (not three dots) → 401', async () => {
  const app = buildVerifierApp();
  const res = await app.inject({
    method: 'GET',
    url: '/probe',
    headers: { authorization: 'Bearer not.a.jwt-at-all' },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('signature mismatch (signed with different secret) → 401', async () => {
  const app = buildVerifierApp();
  const otherSecret = new TextEncoder().encode('a-totally-different-secret-32b!!');
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_TENANT_ID,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(EMPLOYEE_ID)
    .setAudience(MOBILE_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(otherSecret);
  const res = await app.inject({
    method: 'GET',
    url: '/probe',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('missing tenant_id claim → 401', async () => {
  const app = buildVerifierApp();
  const token = await mintJwt({ omitTenantId: true });
  const res = await app.inject({
    method: 'GET',
    url: '/probe',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('missing subject_tenant_id claim → 401', async () => {
  const app = buildVerifierApp();
  const token = await mintJwt({ omitSubjectTenantId: true });
  const res = await app.inject({
    method: 'GET',
    url: '/probe',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('missing sub claim → 401', async () => {
  const app = buildVerifierApp();
  const token = await mintJwt({ omitSub: true });
  const res = await app.inject({
    method: 'GET',
    url: '/probe',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});
