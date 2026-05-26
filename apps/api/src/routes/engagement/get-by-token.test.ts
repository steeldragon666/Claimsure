import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../../app.js';
import { LETTER_A, cleanupFixtures, seedFixtures } from './_fixtures.js';

/**
 * GET /v1/engagement/by-token/:token — happy path + invalid-token + lifecycle.
 *
 * No session required — the token IS the auth signal. Invalid / expired /
 * lifecycle-blocked tokens all return 404 to avoid token-state leakage.
 */

const VALID_TOKEN = 'engapi-get-by-token-aaaaaaaaaaaaaaaaaaaaaaaa';

before(async () => {
  await seedFixtures({ withEngagementLetter: true, sendToken: VALID_TOKEN });
});

after(async () => {
  await cleanupFixtures();
  await sql.end();
  await privilegedSql.end();
});

test('GET /engagement/by-token/:token: 404 on unknown token', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/engagement/by-token/this-token-does-not-exist-zzzzzzzzzzzzzzzzz',
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('GET /engagement/by-token/:token: 404 on malformed (too-short) token', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/v1/engagement/by-token/short',
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('GET /engagement/by-token/:token: 200 returns rendered markdown + firm name', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/engagement/by-token/${VALID_TOKEN}`,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    renderedMarkdown: string;
    firmName: string;
    status: string;
  }>();
  assert.equal(typeof body.renderedMarkdown, 'string');
  assert.ok(body.renderedMarkdown.length > 0);
  assert.equal(body.firmName, 'EngAPI Firm A');
  assert.equal(body.status, 'sent');
  await app.close();
});

test('GET /engagement/by-token/:token: 404 on already-signed letter', async () => {
  await seedFixtures({
    withEngagementLetter: true,
    sendToken: VALID_TOKEN,
    signedByClaimant: true,
  });
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/engagement/by-token/${VALID_TOKEN}`,
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('GET /engagement/by-token/:token: 404 on expired send_token', async () => {
  await seedFixtures({ withEngagementLetter: true, sendToken: VALID_TOKEN });
  // Backdate the expiry.
  await privilegedSql`
    UPDATE engagement_letter SET send_token_expires_at = NOW() - INTERVAL '1 day'
     WHERE id = ${LETTER_A}
  `;
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/engagement/by-token/${VALID_TOKEN}`,
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});
