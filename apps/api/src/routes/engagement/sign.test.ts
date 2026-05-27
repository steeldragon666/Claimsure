import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../../app.js';
import { CLAIM_A, LETTER_A, cleanupFixtures, seedFixtures } from './_fixtures.js';

/**
 * POST /v1/engagement/:token/sign — happy path + invalid-token + lifecycle.
 *
 * Token-gated. No session required. Sign event must:
 *   - persist signed_by_claimant_* columns
 *   - flip claim.engagement_status -> 'signed'
 * pg-boss enqueue is best-effort; if the queue is unreachable the
 * route still returns 200 (a sweep job re-enqueues based on
 * `pdf_evidence_id IS NULL`).
 */

const VALID_TOKEN = 'engapi-sign-token-aaaaaaaaaaaaaaaaaaaaaaaaaa';

before(async () => {
  await seedFixtures({ withEngagementLetter: true, sendToken: VALID_TOKEN });
});

after(async () => {
  await cleanupFixtures();
  await sql.end();
  await privilegedSql.end();
});

test('POST /engagement/:token/sign: 404 on unknown token', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/engagement/this-token-does-not-exist-zzzzzzzzzzzzzzzzz/sign',
    payload: { typedName: 'A Director' },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('POST /engagement/:token/sign: 400 on missing/empty typedName', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/engagement/${VALID_TOKEN}/sign`,
    payload: { typedName: '' },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /engagement/:token/sign: 200 happy path persists signature + flips status', async () => {
  await seedFixtures({ withEngagementLetter: true, sendToken: VALID_TOKEN });
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/engagement/${VALID_TOKEN}/sign`,
    payload: { typedName: 'A Director' },
    headers: { 'user-agent': 'EngAPISignTest/1.0' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ engagementId: string; signedAt: string }>();
  assert.equal(body.engagementId, LETTER_A);
  assert.ok(new Date(body.signedAt).getTime() > 0);

  // Persistence invariants.
  const letterRows = await privilegedSql<
    {
      signed_by_claimant_at: Date | null;
      signed_by_claimant_name: string | null;
      signed_by_claimant_ua: string | null;
    }[]
  >`
    SELECT signed_by_claimant_at, signed_by_claimant_name, signed_by_claimant_ua
      FROM engagement_letter WHERE id = ${LETTER_A}
  `;
  assert.ok(letterRows[0]!.signed_by_claimant_at);
  assert.equal(letterRows[0]!.signed_by_claimant_name, 'A Director');
  assert.equal(letterRows[0]!.signed_by_claimant_ua, 'EngAPISignTest/1.0');

  const claimRows = await privilegedSql<{ engagement_status: string }[]>`
    SELECT engagement_status FROM claim WHERE id = ${CLAIM_A}
  `;
  assert.equal(claimRows[0]!.engagement_status, 'signed');
  await app.close();
});

test('POST /engagement/:token/sign: 404 on already-signed letter (no double-sign)', async () => {
  await seedFixtures({
    withEngagementLetter: true,
    sendToken: VALID_TOKEN,
    signedByClaimant: true,
  });
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/engagement/${VALID_TOKEN}/sign`,
    payload: { typedName: 'Another Sig' },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});
