import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../../app.js';
import {
  CLAIM_A,
  CLAIM_B,
  TENANT_A,
  cleanupFixtures,
  consultantJwt,
  seedFixtures,
} from './_fixtures.js';

/**
 * POST /v1/claims/:id/engagement/send — happy path + auth + cross-tenant.
 *
 * Cross-tenant isolation lives at the RLS layer (the cross-tenant claim id
 * is invisible to firm A's session → 404). The migration test
 * (engagement-letter.test.ts) already proves the policy; this test
 * proves the route honours it.
 */

before(async () => {
  await seedFixtures();
});

after(async () => {
  await cleanupFixtures();
  await sql.end();
  await privilegedSql.end();
});

test('POST /claims/:id/engagement/send: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_A}/engagement/send`,
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /claims/:id/engagement/send: 200 happy path inserts letter + flips claim status', async () => {
  // Re-seed to ensure clean state for this test.
  await seedFixtures();
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_A}/engagement/send`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ engagementId: string; sendToken: string; expiresAt: string }>();
  assert.ok(body.engagementId);
  assert.ok(body.sendToken);
  assert.ok(body.sendToken.length >= 32); // base64url of 32 bytes ≈ 43 chars
  assert.ok(new Date(body.expiresAt).getTime() > Date.now());

  // DB invariants: letter row written, claim status flipped.
  const letterRows = await privilegedSql<{ tenant_id: string }[]>`
    SELECT tenant_id::text FROM engagement_letter WHERE id = ${body.engagementId}
  `;
  assert.equal(letterRows.length, 1);
  assert.equal(letterRows[0]!.tenant_id, TENANT_A);

  const claimRows = await privilegedSql<{ engagement_status: string }[]>`
    SELECT engagement_status FROM claim WHERE id = ${CLAIM_A}
  `;
  assert.equal(claimRows[0]!.engagement_status, 'sent');
  await app.close();
});

test('POST /claims/:id/engagement/send: 404 for cross-tenant claim (RLS-invisible)', async () => {
  await seedFixtures();
  const app = buildApp();
  // Firm A session tries to send for Firm B's claim id.
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_B}/engagement/send`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('POST /claims/:id/engagement/send: 422 when tenant has no template configured', async () => {
  await seedFixtures();
  // Null out the template for firm A.
  await privilegedSql`
    UPDATE tenant SET engagement_letter_template_md = NULL WHERE id = ${TENANT_A}
  `;
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/claims/${CLAIM_A}/engagement/send`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(res.statusCode, 422);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'template_missing');
  await app.close();
});
