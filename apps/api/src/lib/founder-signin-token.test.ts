import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signFounderSigninToken, verifyFounderSigninToken } from './founder-signin-token.js';

const SECRET = 'test-founder-signin-secret-32+bytes-here-please!!';
const SUB = '00000000-0000-0000-0000-0000000000aa';
const EMAIL = 'applicant@example.com';
const TENANT_ID = '00000000-0000-0000-0000-0000000000bb';

test('signFounderSigninToken: round-trip preserves sub/email/tenantId', async () => {
  const jwt = await signFounderSigninToken({ sub: SUB, email: EMAIL, tenantId: TENANT_ID }, SECRET);
  const payload = await verifyFounderSigninToken(jwt, SECRET);
  assert.equal(payload.sub, SUB);
  assert.equal(payload.email, EMAIL);
  assert.equal(payload.tenantId, TENANT_ID);
  assert.ok(payload.exp > payload.iat);
});

test('verifyFounderSigninToken: rejects a token signed with a different secret', async () => {
  const jwt = await signFounderSigninToken(
    { sub: SUB, email: EMAIL, tenantId: TENANT_ID },
    'a-different-32+byte-secret-than-the-verify-side!!',
  );
  await assert.rejects(() => verifyFounderSigninToken(jwt, SECRET));
});

test('verifyFounderSigninToken: rejects an expired token', async () => {
  const jwt = await signFounderSigninToken(
    { sub: SUB, email: EMAIL, tenantId: TENANT_ID },
    SECRET,
    { ttlSeconds: -10 },
  );
  await assert.rejects(() => verifyFounderSigninToken(jwt, SECRET));
});

test('verifyFounderSigninToken: rejects a regular session JWT (wrong kind/aud)', async () => {
  // Mint a token with the right secret but a different audience — simulates
  // someone replaying a normal cpa_session cookie at this endpoint.
  const { SignJWT } = await import('jose');
  const secretKey = new TextEncoder().encode(SECRET);
  const fakeSession = await new SignJWT({ email: EMAIL, tenantId: TENANT_ID })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('cpa-platform')
    .setAudience('cpa-api') // <— normal session audience, NOT founder-issued-signin
    .setSubject(SUB)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(secretKey);
  await assert.rejects(() => verifyFounderSigninToken(fakeSession, SECRET));
});

test('signFounderSigninToken: empty secret throws', async () => {
  await assert.rejects(() =>
    signFounderSigninToken({ sub: SUB, email: EMAIL, tenantId: TENANT_ID }, ''),
  );
});
