import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../../app.js';
import { MOBILE_AUDIENCE } from '../../middleware/mobile-jwt-verifier.js';
import {
  TENANT_A,
  TENANT_B,
  SUBJECT_A,
  SUBJECT_B,
  CLAIM_A,
  LETTER_A,
  cleanupFixtures,
  seedFixtures,
} from './_fixtures.js';

/**
 * GET /v1/me/pending-engagement — mobile-session-gated.
 *
 * Mirrors the shape of the mobile-events tests: mint a mobile JWT
 * directly via jose (no need for a real magic-link redeem round trip),
 * hit the route, assert on the body.
 *
 * Covers:
 *   - 401 without a Bearer token
 *   - 200 + null when no engagement_letter is in `sent` state
 *   - 200 + populated payload when one IS in `sent` state
 *   - 200 + null when the row exists but is already signed
 *   - cross-tenant isolation: a tenant-B mobile JWT cannot see
 *     tenant-A's pending engagement (returns null, not 200 + leak)
 */

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';
process.env['SESSION_JWT_SECRET'] = SESSION_SECRET;

const EMPLOYEE_A = '00000000-0000-4000-8000-00000000e2a8';
const EMPLOYEE_B = '00000000-0000-4000-8000-00000000e2b8';

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

const mobileToken = async (args: {
  employeeId: string;
  tenantId: string;
  subjectTenantId: string;
}): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  const key = new TextEncoder().encode(SESSION_SECRET);
  return await new SignJWT({
    tenant_id: args.tenantId,
    subject_tenant_id: args.subjectTenantId,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(args.employeeId)
    .setAudience(MOBILE_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + ACCESS_TOKEN_TTL_SECONDS)
    .sign(key);
};

const VALID_TOKEN = 'mepending-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';

before(async () => {
  // Seed a SENT, unsigned letter on tenant A. Tenant B has no letter.
  await seedFixtures({
    withEngagementLetter: true,
    sendToken: VALID_TOKEN,
    engagementStatus: 'sent',
  });
});

after(async () => {
  await cleanupFixtures();
  await sql.end();
  await privilegedSql.end();
});

test('GET /v1/me/pending-engagement: 401 without bearer token', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/me/pending-engagement',
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('GET /v1/me/pending-engagement: returns the pending letter for the mobile user', async () => {
  const token = await mobileToken({
    employeeId: EMPLOYEE_A,
    tenantId: TENANT_A,
    subjectTenantId: SUBJECT_A,
  });
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/me/pending-engagement',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    pendingEngagement: {
      engagementId: string;
      sendToken: string;
      claimId: string;
      renderedMarkdown: string;
      firmName: string;
      consultantName: string | null;
    } | null;
  }>();
  assert.ok(body.pendingEngagement, 'expected pendingEngagement to be present');
  assert.equal(body.pendingEngagement.engagementId, LETTER_A);
  assert.equal(body.pendingEngagement.claimId, CLAIM_A);
  assert.equal(body.pendingEngagement.sendToken, VALID_TOKEN);
  assert.equal(body.pendingEngagement.firmName, 'EngAPI Firm A');
  assert.equal(typeof body.pendingEngagement.renderedMarkdown, 'string');
  assert.ok(body.pendingEngagement.renderedMarkdown.length > 0);
  await app.close();
});

test('GET /v1/me/pending-engagement: cross-tenant mobile JWT sees no pending engagement', async () => {
  // A mobile user on tenant B (no engagement_letter row at all) must
  // see `null` — both because the RLS GUC scopes to TENANT_B and
  // because the subject_tenant_id filter scopes to SUBJECT_B. Either
  // alone is sufficient; we verify both gates by giving B a session
  // that COULDN'T see A's letter under any reasonable failure mode.
  const token = await mobileToken({
    employeeId: EMPLOYEE_B,
    tenantId: TENANT_B,
    subjectTenantId: SUBJECT_B,
  });
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/me/pending-engagement',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ pendingEngagement: unknown }>();
  assert.equal(body.pendingEngagement, null);
  await app.close();
});

test('GET /v1/me/pending-engagement: returns null once the letter is signed', async () => {
  // Re-seed the letter row as already-signed; the route's filter
  // (signed_by_claimant_at IS NULL) must hide it.
  await privilegedSql`
    UPDATE engagement_letter
       SET signed_by_claimant_at = NOW(),
           signed_by_claimant_name = 'Sig Tester'
     WHERE id = ${LETTER_A}
  `;
  await privilegedSql`
    UPDATE claim SET engagement_status = 'signed' WHERE id = ${CLAIM_A}
  `;
  const token = await mobileToken({
    employeeId: EMPLOYEE_A,
    tenantId: TENANT_A,
    subjectTenantId: SUBJECT_A,
  });
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/me/pending-engagement',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ pendingEngagement: unknown }>();
  assert.equal(body.pendingEngagement, null);
  await app.close();
});
