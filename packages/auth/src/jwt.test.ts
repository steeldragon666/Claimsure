import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signSession, verifySession, type SessionClaims } from './jwt.js';

const TEST_SECRET = 'test-secret-32-bytes-of-entropy!!';

const baseClaims: SessionClaims = {
  sub: '00000000-0000-4000-8000-000000000001',
  email: 'jane@example.com',
  primaryIdp: 'microsoft',
  activeTenantId: '00000000-0000-4000-8000-0000000000a1',
  activeRole: 'consultant',
  availableTenants: [
    {
      tenantId: '00000000-0000-4000-8000-0000000000a1',
      name: 'Firm A',
      slug: 'firm-a',
      role: 'consultant',
    },
  ],
};

test('signSession + verifySession: roundtrip preserves all claims', async () => {
  const jwt = await signSession(baseClaims, TEST_SECRET, { ttlSeconds: 3600 });
  assert.equal(typeof jwt, 'string');
  assert.ok(jwt.split('.').length === 3, 'is a JWT');

  const verified = await verifySession(jwt, TEST_SECRET);
  assert.equal(verified.sub, baseClaims.sub);
  assert.equal(verified.email, baseClaims.email);
  assert.equal(verified.primaryIdp, baseClaims.primaryIdp);
  assert.equal(verified.activeTenantId, baseClaims.activeTenantId);
  assert.equal(verified.activeRole, baseClaims.activeRole);
  assert.deepEqual(verified.availableTenants, baseClaims.availableTenants);
  assert.equal(typeof verified.iat, 'number');
  assert.equal(typeof verified.exp, 'number');
  assert.equal(verified.exp - verified.iat, 3600);
});

test('verifySession: rejects expired JWT', async () => {
  const jwt = await signSession(baseClaims, TEST_SECRET, { ttlSeconds: -1 });
  await assert.rejects(verifySession(jwt, TEST_SECRET), /expired|exp/i);
});

test('verifySession: rejects tampered signature', async () => {
  const jwt = await signSession(baseClaims, TEST_SECRET, { ttlSeconds: 3600 });
  const parts = jwt.split('.');
  const tamperedSig = parts[2]!.slice(0, -2) + 'xx';
  const tampered = `${parts[0]!}.${parts[1]!}.${tamperedSig}`;
  await assert.rejects(verifySession(tampered, TEST_SECRET), /signature/i);
});

test('verifySession: rejects wrong secret', async () => {
  const jwt = await signSession(baseClaims, TEST_SECRET, { ttlSeconds: 3600 });
  await assert.rejects(verifySession(jwt, 'different-secret-32-bytes-here!!'), /signature/i);
});

test('signSession: handles null activeTenantId for users with no tenant_user rows', async () => {
  const claims: SessionClaims = { ...baseClaims, activeTenantId: null, activeRole: null, availableTenants: [] };
  const jwt = await signSession(claims, TEST_SECRET, { ttlSeconds: 3600 });
  const verified = await verifySession(jwt, TEST_SECRET);
  assert.equal(verified.activeTenantId, null);
  assert.equal(verified.activeRole, null);
  assert.deepEqual(verified.availableTenants, []);
});
