import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../../app.js';
import {
  LETTER_A,
  cleanupFixtures,
  consultantJwt,
  seedFixtures,
  tenantBAdminJwt,
} from './_fixtures.js';

/**
 * GET /v1/engagement/:id — happy path + auth + cross-tenant.
 *
 * Session-required, RLS-scoped read. Returns the row plus a derived
 * `currentStep` summary for the consultant UI. Never returns
 * `send_token` (that's the claimant's credential).
 */

before(async () => {
  await seedFixtures({ withEngagementLetter: true });
});

after(async () => {
  await cleanupFixtures();
  await sql.end();
  await privilegedSql.end();
});

test('GET /engagement/:id: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/engagement/${LETTER_A}`,
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('GET /engagement/:id: 200 happy path returns row + derived currentStep', async () => {
  await seedFixtures({ withEngagementLetter: true });
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/engagement/${LETTER_A}`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    id: string;
    claimId: string;
    renderedMarkdown: string;
    currentStep: string;
  }>();
  assert.equal(body.id, LETTER_A);
  assert.equal(typeof body.renderedMarkdown, 'string');
  assert.equal(body.currentStep, 'sent');

  // Critical: send_token MUST NOT be in the response.
  const bodyKeys = Object.keys(body);
  assert.equal(bodyKeys.includes('sendToken'), false, 'sendToken must not be exposed');
  assert.equal(bodyKeys.includes('send_token'), false, 'send_token must not be exposed');
  await app.close();
});

test('GET /engagement/:id: 404 for cross-tenant id', async () => {
  await seedFixtures({ withEngagementLetter: true });
  const app = buildApp();
  // Firm B admin targets Firm A's letter.
  const res = await app.inject({
    method: 'GET',
    url: `/v1/engagement/${LETTER_A}`,
    cookies: { cpa_session: await tenantBAdminJwt() },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('GET /engagement/:id: derives currentStep=signed when claimant has signed', async () => {
  await seedFixtures({ withEngagementLetter: true, signedByClaimant: true });
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/engagement/${LETTER_A}`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ currentStep: string }>();
  assert.equal(body.currentStep, 'signed');
  await app.close();
});
