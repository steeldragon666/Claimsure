import { test, after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { signSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import { insertEventWithChain } from '@cpa/db';
import { buildApp } from '../app.js';

/**
 * P7 Theme C Task C.6 — Theme C contract tests.
 *
 * Validates the audit-timeline and multi-entity-comparison endpoints
 * against the compliance contract:
 *
 * 1. Verified chain → chain_verified=true on all event rows
 * 2. Tampered chain → chain_verified=false on all event rows
 * 3. Multi-entity endpoint → empty scores + similarity_available=false
 *    when multi_entity_similarity_score table doesn't exist (pre-p7d)
 *
 * Seeds BOTH verified-anchor AND tampered-anchor cases per C.6 spec.
 */

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

const TENANT_ID = '00000000-0000-4000-8000-000000c60001';
const USER_ID = '00000000-0000-4000-8000-000000c60010';
const SUBJECT_TENANT_ID = '00000000-0000-4000-8000-000000c60020';
const PROJECT_ID = '00000000-0000-4000-8000-000000c60030';
const CLAIM_ID = '00000000-0000-4000-8000-000000c60040';
const ACTIVITY_ID = '00000000-0000-4000-8000-000000c60050';

let dbAvailable = false;

const cleanup = async (): Promise<void> => {
  try {
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
            VALUES (${TENANT_ID}, 'Firm Contract', 'firm-contract', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${USER_ID}, 'contract@example.com', 'microsoft', 'microsoft:contract', 'Contract User')`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                      VALUES (gen_random_uuid(), ${TENANT_ID}, ${USER_ID}, 'consultant', true)`;
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                      VALUES (${SUBJECT_TENANT_ID}, ${TENANT_ID}, 'Contract Claimant', 'claimant')`;
  await privilegedSql`INSERT INTO project (id, tenant_id, subject_tenant_id, name, started_at)
                      VALUES (${PROJECT_ID}, ${TENANT_ID}, ${SUBJECT_TENANT_ID}, 'Contract Project', NOW())`;
  await privilegedSql`INSERT INTO claim (id, tenant_id, subject_tenant_id, project_id, fiscal_year, stage)
                      VALUES (${CLAIM_ID}, ${TENANT_ID}, ${SUBJECT_TENANT_ID}, ${PROJECT_ID}, 2025, 'activity_capture')`;
  await privilegedSql`INSERT INTO activity (id, tenant_id, project_id, claim_id, code, kind, title, fy_label, hypothesis_formed_at)
                      VALUES (${ACTIVITY_ID}, ${TENANT_ID}, ${PROJECT_ID}, ${CLAIM_ID}, 'CA-01', 'core', 'Contract Activity', 'FY25', NOW())`;

  // Seed 3 events in the chain
  const baseTime = new Date('2025-07-01T00:00:00Z');
  for (let i = 0; i < 3; i++) {
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
      email: 'contract@example.com',
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

describe('Contract: audit-timeline chain verification', () => {
  test('verified-anchor: chain_verified=true when chain is intact', async (t) => {
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
      timeline: { kind: string; chain_verified?: boolean }[];
      chain_status: { verified: boolean; first_break_at: number | null };
    };

    // Chain status at top level
    assert.equal(
      body.chain_status.verified,
      true,
      'chain_status.verified must be true for intact chain',
    );
    assert.equal(body.chain_status.first_break_at, null, 'no break in intact chain');

    // All event rows must have chain_verified=true
    const eventRows = body.timeline.filter((r) => r.kind === 'event');
    assert.ok(eventRows.length >= 3, 'should have at least 3 event rows');
    for (const row of eventRows) {
      assert.equal(row.chain_verified, true, 'each event row must have chain_verified=true');
    }

    await app.close();
  });

  test('tampered-anchor: chain_verified=false when first event hash is corrupted', async (t) => {
    if (skipIfNoDb(t)) return;

    // Tamper: corrupt the hash of the first event
    const [firstEvent] = await privilegedSql<{ id: string; hash: string }[]>`
      SELECT id, hash FROM event
       WHERE subject_tenant_id = ${SUBJECT_TENANT_ID}
       ORDER BY captured_at, received_at, id
       LIMIT 1
    `;
    assert.ok(firstEvent, 'first event must exist');
    const originalHash = firstEvent.hash;

    await privilegedSql`UPDATE event SET hash = 'deadbeef' || substring(hash from 9) WHERE id = ${firstEvent.id}`;

    try {
      const app = buildApp();
      await app.ready();
      const res = await app.inject({
        method: 'GET',
        url: `/v1/audit/activity/${ACTIVITY_ID}/timeline`,
        cookies: { cpa_session: await consultantJwt() },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload) as {
        timeline: { kind: string; chain_verified?: boolean }[];
        chain_status: { verified: boolean; first_break_at: number | null };
      };

      // Chain status should be broken
      assert.equal(
        body.chain_status.verified,
        false,
        'chain_status.verified must be false for tampered chain',
      );
      assert.equal(body.chain_status.first_break_at, 0, 'break at position 0 (first event)');

      // All event rows must have chain_verified=false
      const eventRows = body.timeline.filter((r) => r.kind === 'event');
      for (const row of eventRows) {
        assert.equal(
          row.chain_verified,
          false,
          'event rows must have chain_verified=false when chain is broken',
        );
      }

      await app.close();
    } finally {
      // Restore original hash so other tests don't break
      await privilegedSql`UPDATE event SET hash = ${originalHash} WHERE id = ${firstEvent.id}`;
    }
  });
});

describe('Contract: multi-entity-comparison pre-p7d', () => {
  test('returns empty scores + similarity_available=false when table does not exist', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildApp();
    await app.ready();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/multi-entity-comparison/${ACTIVITY_ID}`,
      cookies: { cpa_session: await consultantJwt() },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload) as {
      activities: { id: string }[];
      scores: unknown[];
      similarity_available: boolean;
    };

    assert.equal(body.similarity_available, false, 'similarity_available must be false pre-p7d');
    assert.ok(Array.isArray(body.scores), 'scores must be an array');
    assert.equal(body.scores.length, 0, 'scores must be empty pre-p7d');

    await app.close();
  });
});
