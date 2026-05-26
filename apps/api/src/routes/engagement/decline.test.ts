import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../../app.js';
import { CLAIM_A, LETTER_A, cleanupFixtures, seedFixtures } from './_fixtures.js';

/**
 * POST /v1/engagement/:token/decline — happy path + invalid-token + lifecycle.
 *
 * Token-gated. Decline must:
 *   - persist declined_at + declined_reason
 *   - flip claim.engagement_status -> 'declined'
 */

const VALID_TOKEN = 'engapi-decl-token-aaaaaaaaaaaaaaaaaaaaaaaaaa';

before(async () => {
  await seedFixtures({ withEngagementLetter: true, sendToken: VALID_TOKEN });
});

after(async () => {
  await cleanupFixtures();
  await sql.end();
  await privilegedSql.end();
});

test('POST /engagement/:token/decline: 404 on unknown token', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/engagement/this-token-does-not-exist-zzzzzzzzzzzzzzzzz/decline',
    payload: { reason: 'no' },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('POST /engagement/:token/decline: 200 happy path with reason', async () => {
  await seedFixtures({ withEngagementLetter: true, sendToken: VALID_TOKEN });
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/engagement/${VALID_TOKEN}/decline`,
    payload: { reason: 'changed mind' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ declinedAt: string }>();
  assert.ok(new Date(body.declinedAt).getTime() > 0);

  const letterRows = await privilegedSql<
    {
      declined_at: Date | null;
      declined_reason: string | null;
    }[]
  >`
    SELECT declined_at, declined_reason FROM engagement_letter WHERE id = ${LETTER_A}
  `;
  assert.ok(letterRows[0]!.declined_at);
  assert.equal(letterRows[0]!.declined_reason, 'changed mind');

  const claimRows = await privilegedSql<{ engagement_status: string }[]>`
    SELECT engagement_status FROM claim WHERE id = ${CLAIM_A}
  `;
  assert.equal(claimRows[0]!.engagement_status, 'declined');
  await app.close();
});

test('POST /engagement/:token/decline: 200 with no reason (empty body)', async () => {
  await seedFixtures({ withEngagementLetter: true, sendToken: VALID_TOKEN });
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/engagement/${VALID_TOKEN}/decline`,
    payload: {},
  });
  assert.equal(res.statusCode, 200);
  await app.close();
});

test('POST /engagement/:token/decline: 404 on already-signed letter', async () => {
  await seedFixtures({
    withEngagementLetter: true,
    sendToken: VALID_TOKEN,
    signedByClaimant: true,
  });
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/engagement/${VALID_TOKEN}/decline`,
    payload: { reason: 'too late' },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});
