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
  viewerJwt,
} from './_fixtures.js';

/**
 * POST /v1/engagement/:id/countersign — happy path + auth + cross-tenant.
 *
 * Session-required. Admin/consultant only. Lifecycle gate: claimant
 * must have signed first; no double-countersign.
 */

before(async () => {
  await seedFixtures({ withEngagementLetter: true, signedByClaimant: true });
});

after(async () => {
  await cleanupFixtures();
  await sql.end();
  await privilegedSql.end();
});

test('POST /engagement/:id/countersign: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/engagement/${LETTER_A}/countersign`,
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /engagement/:id/countersign: 403 for viewer role', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/engagement/${LETTER_A}/countersign`,
    cookies: { cpa_session: await viewerJwt() },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('POST /engagement/:id/countersign: 200 happy path persists timestamp + user', async () => {
  await seedFixtures({ withEngagementLetter: true, signedByClaimant: true });
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/engagement/${LETTER_A}/countersign`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ countersignedAt: string }>();
  assert.ok(new Date(body.countersignedAt).getTime() > 0);

  const rows = await privilegedSql<
    {
      countersigned_at: Date | null;
      countersigned_by_user_id: string | null;
    }[]
  >`
    SELECT countersigned_at, countersigned_by_user_id::text
      FROM engagement_letter WHERE id = ${LETTER_A}
  `;
  assert.ok(rows[0]!.countersigned_at);
  assert.ok(rows[0]!.countersigned_by_user_id);
  await app.close();
});

test('POST /engagement/:id/countersign: 404 for cross-tenant id (RLS-invisible)', async () => {
  await seedFixtures({ withEngagementLetter: true, signedByClaimant: true });
  const app = buildApp();
  // Firm B admin session targets Firm A's letter id.
  const res = await app.inject({
    method: 'POST',
    url: `/v1/engagement/${LETTER_A}/countersign`,
    cookies: { cpa_session: await tenantBAdminJwt() },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('POST /engagement/:id/countersign: 409 when claimant has not signed yet', async () => {
  await seedFixtures({ withEngagementLetter: true, signedByClaimant: false });
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/v1/engagement/${LETTER_A}/countersign`,
    cookies: { cpa_session: await consultantJwt() },
  });
  assert.equal(res.statusCode, 409);
  await app.close();
});
