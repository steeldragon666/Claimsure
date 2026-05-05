import { test, after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { signSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import { insertEventWithChain } from '@cpa/db';
import { buildApp } from '../app.js';

/**
 * P7 Theme C Task C.1 — audit-timeline route tests.
 *
 * Live-DB tests use the same fixture pattern as prompt-suggestions.test.ts:
 * seed tenant + user + subject_tenant + project + claim + activity, exercise
 * the route via `app.inject()`, then teardown.
 *
 * Test shape: 5 events + 3 narrative_draft_versions + 2 audit_log rows = 10
 * timeline rows in chronological order. Chain verification is batched (one
 * verifyChain call per request, not per-row).
 */

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

const TENANT_ID = '00000000-0000-4000-8000-000000c30001';
const USER_ID = '00000000-0000-4000-8000-000000c30010';
const SUBJECT_TENANT_ID = '00000000-0000-4000-8000-000000c30020';
const PROJECT_ID = '00000000-0000-4000-8000-000000c30030';
const CLAIM_ID = '00000000-0000-4000-8000-000000c30040';
const ACTIVITY_ID = '00000000-0000-4000-8000-000000c30050';
const DRAFT_ID = '00000000-0000-4000-8000-000000c30060';

let dbAvailable = false;

const cleanup = async (): Promise<void> => {
  try {
    await privilegedSql`DELETE FROM audit_log WHERE firm_id = ${TENANT_ID}`;
    await privilegedSql`DELETE FROM narrative_draft_version WHERE tenant_id = ${TENANT_ID}`;
    await privilegedSql`DELETE FROM narrative_draft WHERE tenant_id = ${TENANT_ID}`;
    await privilegedSql`DELETE FROM event WHERE tenant_id = ${TENANT_ID}`;
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

  // Seed: tenant → user → tenant_user → subject_tenant → project → claim → activity
  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT_ID}, 'Firm Timeline', 'firm-timeline', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${USER_ID}, 'timeline@example.com', 'microsoft', 'microsoft:timeline', 'Timeline User')`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                      VALUES (gen_random_uuid(), ${TENANT_ID}, ${USER_ID}, 'consultant', true)`;
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                      VALUES (${SUBJECT_TENANT_ID}, ${TENANT_ID}, 'Timeline Claimant', 'claimant')`;
  await privilegedSql`INSERT INTO project (id, tenant_id, subject_tenant_id, name, started_at)
                      VALUES (${PROJECT_ID}, ${TENANT_ID}, ${SUBJECT_TENANT_ID}, 'Timeline Project', NOW())`;
  await privilegedSql`INSERT INTO claim (id, tenant_id, subject_tenant_id, project_id, fiscal_year, stage)
                      VALUES (${CLAIM_ID}, ${TENANT_ID}, ${SUBJECT_TENANT_ID}, ${PROJECT_ID}, 2025, 'activity_capture')`;
  await privilegedSql`INSERT INTO activity (id, tenant_id, project_id, claim_id, code, kind, title, fy_label, hypothesis_formed_at)
                      VALUES (${ACTIVITY_ID}, ${TENANT_ID}, ${PROJECT_ID}, ${CLAIM_ID}, 'CA-01', 'core', 'Test Activity', 'FY25', NOW())`;

  // Seed 5 events referencing the activity (spaced 1 second apart for chronological order)
  const baseTime = new Date('2025-06-01T00:00:00Z');
  for (let i = 0; i < 5; i++) {
    const capturedAt = new Date(baseTime.getTime() + i * 1000);
    await insertEventWithChain({
      tenant_id: TENANT_ID,
      subject_tenant_id: SUBJECT_TENANT_ID,
      project_id: PROJECT_ID,
      kind: i === 0 ? 'ACTIVITY_CREATED' : 'ACTIVITY_UPDATED',
      payload: { activity_id: ACTIVITY_ID, index: i },
      classification: null,
      captured_at: capturedAt,
      captured_by_user_id: USER_ID,
      override_of_event_id: null,
      override_new_kind: null,
      override_reason: null,
    });
  }

  // Seed narrative_draft (parent) then 3 versions
  await privilegedSql`INSERT INTO narrative_draft (tenant_id, id, activity_id, section_kind, segments, content_hash, model, prompt_version, current_version, status, created_by_user_id)
                      VALUES (${TENANT_ID}, ${DRAFT_ID}, ${ACTIVITY_ID}, 'hypothesis', '[]'::jsonb, 'abc123', 'sonnet-4', '1.0.0', 3, 'complete', ${USER_ID})`;
  for (let v = 1; v <= 3; v++) {
    const versionId = `00000000-0000-4000-8000-000000c3006${v}`;
    const createdAt = new Date(baseTime.getTime() + (5 + v) * 1000).toISOString();
    await privilegedSql`INSERT INTO narrative_draft_version (tenant_id, id, draft_id, version, segments, content_hash, model, prompt_version, parent_version, generation_kind, created_at, created_by_user_id)
                        VALUES (${TENANT_ID}, ${versionId}, ${DRAFT_ID}, ${v}, '[]'::jsonb, ${'hash_v' + v}, 'sonnet-4', '1.0.0', ${v === 1 ? null : v - 1}, ${v === 1 ? 'initial' : 'section_regen'}, ${createdAt}::timestamptz, ${USER_ID})`;
  }

  // Seed 2 audit_log rows
  for (let i = 0; i < 2; i++) {
    const createdAt = new Date(baseTime.getTime() + (9 + i) * 1000).toISOString();
    await privilegedSql`INSERT INTO audit_log (id, firm_id, kind, payload, actor_user_id, created_at)
                        VALUES (gen_random_uuid(), ${TENANT_ID}, 'HYPOTHESIS_FORMED_AT_IMMUTABILITY_VIOLATION', ${JSON.stringify({ activity_id: ACTIVITY_ID, old_hypothesis_formed_at: '2025-01-01T00:00:00Z', new_hypothesis_formed_at: '2025-02-01T00:00:00Z' })}::text::jsonb, ${USER_ID}, ${createdAt}::timestamptz)`;
  }
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
      email: 'timeline@example.com',
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

describe('GET /v1/audit/activity/:activityId/timeline', () => {
  test('returns 401 without session', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildApp();
    await app.ready();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/audit/activity/${ACTIVITY_ID}/timeline`,
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
      url: '/v1/audit/activity/00000000-0000-4000-8000-000000000000/timeline',
      cookies: { cpa_session: await consultantJwt() },
    });
    assert.equal(res.statusCode, 404);
    await app.close();
  });

  test('returns 10 timeline rows in chronological order with chain_verified=true', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildApp();
    await app.ready();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/audit/activity/${ACTIVITY_ID}/timeline`,
      cookies: { cpa_session: await consultantJwt() },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload) as {
      timeline: { kind: string; timestamp: string; chain_verified?: boolean }[];
      chain_status: { verified: boolean };
    };
    assert.ok(Array.isArray(body.timeline), 'timeline should be an array');
    assert.equal(body.timeline.length, 10, 'should return 10 rows');

    // Verify chronological order
    for (let i = 1; i < body.timeline.length; i++) {
      const prev = new Date(body.timeline[i - 1]!.timestamp).getTime();
      const curr = new Date(body.timeline[i]!.timestamp).getTime();
      assert.ok(prev <= curr, `row ${i} should be >= row ${i - 1} chronologically`);
    }

    // Verify chain_verified on event rows
    const eventRows = body.timeline.filter((r) => r.kind === 'event');
    assert.equal(eventRows.length, 5, 'should have 5 event rows');
    for (const row of eventRows) {
      assert.equal(row.chain_verified, true, 'all event rows should have chain_verified=true');
    }

    // Verify narrative_version rows
    const narrativeRows = body.timeline.filter((r) => r.kind === 'narrative_version');
    assert.equal(narrativeRows.length, 3, 'should have 3 narrative_version rows');

    // Verify audit_log rows
    const auditRows = body.timeline.filter((r) => r.kind === 'audit_log');
    assert.equal(auditRows.length, 2, 'should have 2 audit_log rows');

    // Chain status should be present at the top level
    assert.ok(body.chain_status, 'response should include chain_status');
    assert.equal(body.chain_status.verified, true);

    await app.close();
  });
});
