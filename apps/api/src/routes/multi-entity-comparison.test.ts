import { test, after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { signSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../app.js';

/**
 * P7 Theme C Task C.4 — multi-entity comparison endpoint tests.
 *
 * Tests the GET /v1/multi-entity-comparison/:activityId endpoint which:
 *   1. Fetches activities in the same project as the target activity
 *   2. Joins multi_entity_similarity_score if the table exists (p7d)
 *   3. Returns null scores gracefully when the table doesn't exist
 *
 * The key pre-p7d test: when `multi_entity_similarity_score` does not exist,
 * the endpoint returns an empty scores array with a "not_available" status.
 */

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

const TENANT_ID = '00000000-0000-4000-8000-000000c40001';
const USER_ID = '00000000-0000-4000-8000-000000c40010';
const SUBJECT_TENANT_ID = '00000000-0000-4000-8000-000000c40020';
const PROJECT_ID = '00000000-0000-4000-8000-000000c40030';
const CLAIM_ID = '00000000-0000-4000-8000-000000c40040';
const ACTIVITY_A_ID = '00000000-0000-4000-8000-000000c40050';
const ACTIVITY_B_ID = '00000000-0000-4000-8000-000000c40051';

let dbAvailable = false;

const cleanup = async (): Promise<void> => {
  try {
    await privilegedSql`DELETE FROM activity WHERE tenant_id = ${TENANT_ID}`;
    await privilegedSql`DELETE FROM claim WHERE tenant_id = ${TENANT_ID}`;
    await privilegedSql`DELETE FROM project WHERE tenant_id = ${TENANT_ID}`;
    await privilegedSql`DELETE FROM subject_tenant WHERE tenant_id = ${TENANT_ID}`;
    await privilegedSql`DELETE FROM tenant_user WHERE tenant_id = ${TENANT_ID}`;
    await sql`DELETE FROM "user" WHERE id = ${USER_ID}`;
    await sql`DELETE FROM tenant WHERE id = ${TENANT_ID}`;
  } catch {
    // ignore — DB unreachable
  }
};

before(async () => {
  try {
    await privilegedSql`SELECT 1`;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    return;
  }
  await cleanup();

  // Seed: tenant → user → tenant_user → subject_tenant → project → claim → 2 activities
  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT_ID}, 'Firm MultiEntity', 'firm-multientity', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${USER_ID}, 'multientity@example.com', 'microsoft', 'microsoft:multientity', 'Multi Entity User')`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                      VALUES (gen_random_uuid(), ${TENANT_ID}, ${USER_ID}, 'consultant', true)`;
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                      VALUES (${SUBJECT_TENANT_ID}, ${TENANT_ID}, 'Multi Claimant', 'claimant')`;
  await privilegedSql`INSERT INTO project (id, tenant_id, subject_tenant_id, name, started_at)
                      VALUES (${PROJECT_ID}, ${TENANT_ID}, ${SUBJECT_TENANT_ID}, 'Multi Project', NOW())`;
  await privilegedSql`INSERT INTO claim (id, tenant_id, subject_tenant_id, project_id, fiscal_year, stage)
                      VALUES (${CLAIM_ID}, ${TENANT_ID}, ${SUBJECT_TENANT_ID}, ${PROJECT_ID}, 2025, 'activity_capture')`;
  await privilegedSql`INSERT INTO activity (id, tenant_id, project_id, claim_id, code, kind, title, fy_label, hypothesis_formed_at)
                      VALUES (${ACTIVITY_A_ID}, ${TENANT_ID}, ${PROJECT_ID}, ${CLAIM_ID}, 'CA-01', 'core', 'Activity A', 'FY25', NOW())`;
  await privilegedSql`INSERT INTO activity (id, tenant_id, project_id, claim_id, code, kind, title, fy_label, hypothesis_formed_at)
                      VALUES (${ACTIVITY_B_ID}, ${TENANT_ID}, ${PROJECT_ID}, ${CLAIM_ID}, 'CA-02', 'core', 'Activity B', 'FY25', NOW())`;
});

after(async () => {
  if (dbAvailable) await cleanup();
  try {
    await sql.end();
    await privilegedSql.end();
  } catch {
    // ignore
  }
});

const consultantJwt = (): Promise<string> =>
  signSession(
    {
      sub: USER_ID,
      email: 'multientity@example.com',
      primaryIdp: 'microsoft',
      activeTenantId: TENANT_ID,
      activeRole: 'consultant',
      availableTenants: [],
    },
    SESSION_SECRET,
    { ttlSeconds: 3600 },
  );

const skipIfNoDb = (t: { skip: (msg?: string) => void }): boolean => {
  if (!dbAvailable) {
    t.skip('Postgres not reachable — DB-gated test skipped');
    return true;
  }
  return false;
};

describe('GET /v1/multi-entity-comparison/:activityId', () => {
  test('returns 401 without session', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildApp();
    await app.ready();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/multi-entity-comparison/${ACTIVITY_A_ID}`,
    });
    assert.equal(res.statusCode, 401);
    await app.close();
  });

  test('returns 404 for non-existent activity', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildApp();
    await app.ready();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/multi-entity-comparison/00000000-0000-4000-8000-000000000000',
      cookies: { cpa_session: await consultantJwt() },
    });
    assert.equal(res.statusCode, 404);
    await app.close();
  });

  test('returns comparison grid with activities in the same project', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildApp();
    await app.ready();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/multi-entity-comparison/${ACTIVITY_A_ID}`,
      cookies: { cpa_session: await consultantJwt() },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload) as {
      activities: { id: string; title: string; code: string }[];
      scores: { activity_a_id: string; activity_b_id: string; score: number | null }[];
      similarity_available: boolean;
    };

    // Should include both activities
    assert.ok(Array.isArray(body.activities), 'activities should be an array');
    assert.equal(body.activities.length, 2, 'should have 2 activities in comparison');

    // Since multi_entity_similarity_score table doesn't exist (pre-p7d),
    // scores should be empty and similarity_available should be false
    assert.equal(body.similarity_available, false, 'similarity not available pre-p7d');
    assert.ok(Array.isArray(body.scores), 'scores should be an array');
    assert.equal(body.scores.length, 0, 'no scores pre-p7d');

    await app.close();
  });

  test('returns activities sorted by code', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildApp();
    await app.ready();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/multi-entity-comparison/${ACTIVITY_A_ID}`,
      cookies: { cpa_session: await consultantJwt() },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload) as {
      activities: { id: string; code: string }[];
    };
    const codes = body.activities.map((a) => a.code);
    assert.deepEqual(codes, ['CA-01', 'CA-02']);
    await app.close();
  });
});
