import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { signSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../../app.js';

// ---------------------------------------------------------------------------
// Fixtures — P9.3 namespace (prefix 000000093xxx)
// ---------------------------------------------------------------------------

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

// Source tenant (consultant firm)
const SOURCE_TENANT = '00000000-0000-4000-8000-000000093001';
const SOURCE_USER = '00000000-0000-4000-8000-000000093010';
// Target tenant (financier firm)
const TARGET_TENANT = '00000000-0000-4000-8000-000000093002';
const TARGET_USER = '00000000-0000-4000-8000-000000093020';
// Subject tenant (claimant entity)
const SUBJECT_TENANT = '00000000-0000-4000-8000-000000093100';

let dbAvailable = false;

const sourceSession = (): Promise<string> =>
  signSession(
    {
      sub: SOURCE_USER,
      email: 'consultant@example.com',
      primaryIdp: 'microsoft',
      activeTenantId: SOURCE_TENANT,
      activeRole: 'admin',
      availableTenants: [],
    },
    SESSION_SECRET,
    { ttlSeconds: 3600 },
  );

const targetSession = (): Promise<string> =>
  signSession(
    {
      sub: TARGET_USER,
      email: 'financier@example.com',
      primaryIdp: 'microsoft',
      activeTenantId: TARGET_TENANT,
      activeRole: 'admin',
      availableTenants: [],
    },
    SESSION_SECRET,
    { ttlSeconds: 3600 },
  );

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

before(async () => {
  try {
    await privilegedSql`SELECT 1`;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    return;
  }

  // Clean up any leftover fixtures
  await privilegedSql`DELETE FROM federation_invitation WHERE source_tenant_id = ${SOURCE_TENANT}`;
  await privilegedSql`DELETE FROM federation_share WHERE source_tenant_id = ${SOURCE_TENANT}`;
  await privilegedSql`DELETE FROM subject_tenant WHERE id = ${SUBJECT_TENANT}`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id IN (${SOURCE_TENANT}, ${TARGET_TENANT})`;
  await privilegedSql`DELETE FROM "user" WHERE id IN (${SOURCE_USER}, ${TARGET_USER})`;
  await privilegedSql`DELETE FROM tenant WHERE id IN (${SOURCE_TENANT}, ${TARGET_TENANT})`;

  // Create test fixtures
  await privilegedSql`
    INSERT INTO tenant (id, name, slug, primary_idp)
    VALUES (${SOURCE_TENANT}, 'Source Firm', 'source-firm', 'mixed'),
           (${TARGET_TENANT}, 'Target Financier', 'target-financier', 'mixed')
  `;
  await privilegedSql`
    INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
    VALUES (${SOURCE_USER}, 'consultant@example.com', 'microsoft', 'microsoft:src-user', 'Source Consultant'),
           (${TARGET_USER}, 'financier@example.com', 'microsoft', 'microsoft:tgt-user', 'Target Financier')
  `;
  await privilegedSql`
    INSERT INTO tenant_user (id, tenant_id, user_id, role)
    VALUES (gen_random_uuid(), ${SOURCE_TENANT}, ${SOURCE_USER}, 'admin'),
           (gen_random_uuid(), ${TARGET_TENANT}, ${TARGET_USER}, 'admin')
  `;
  await privilegedSql`
    INSERT INTO subject_tenant (id, tenant_id, name)
    VALUES (${SUBJECT_TENANT}, ${SOURCE_TENANT}, 'Test Entity Pty Ltd')
  `;
});

after(async () => {
  if (!dbAvailable) return;
  try {
    await privilegedSql`DELETE FROM federation_invitation WHERE source_tenant_id = ${SOURCE_TENANT}`;
    await privilegedSql`DELETE FROM federation_share WHERE source_tenant_id = ${SOURCE_TENANT}`;
    await privilegedSql`DELETE FROM subject_tenant WHERE id = ${SUBJECT_TENANT}`;
    await privilegedSql`DELETE FROM tenant_user WHERE tenant_id IN (${SOURCE_TENANT}, ${TARGET_TENANT})`;
    await privilegedSql`DELETE FROM "user" WHERE id IN (${SOURCE_USER}, ${TARGET_USER})`;
    await privilegedSql`DELETE FROM tenant WHERE id IN (${SOURCE_TENANT}, ${TARGET_TENANT})`;
    await privilegedSql.end();
    await sql.end();
  } catch {
    // ignore cleanup errors
  }
});

const skipIfNoDb = (t: { skip: (msg?: string) => void }): boolean => {
  if (!dbAvailable) {
    t.skip('Postgres not reachable — DB-gated test skipped');
    return true;
  }
  return false;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /v1/federation/invitations', () => {
  test('creates invitation and returns pending status', async (t) => {
    if (skipIfNoDb(t)) return;

    const app = buildApp();
    await app.ready();

    const cookie = await sourceSession();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/federation/invitations',
      headers: { cookie: `cpa_session=${cookie}` },
      payload: {
        subject_tenant_id: SUBJECT_TENANT,
        target_email: 'financier@example.com',
        expires_in_days: 7,
      },
    });

    assert.equal(res.statusCode, 201);
    const body = res.json<{ id: string; status: string; expires_at: string }>();
    assert.equal(body.status, 'pending');
    assert.ok(body.id);
    assert.ok(body.expires_at);

    await app.close();
  });

  test('rejects invitation for subject_tenant not owned by caller', async (t) => {
    if (skipIfNoDb(t)) return;

    const app = buildApp();
    await app.ready();

    // Target user tries to create invitation for source's subject_tenant
    const cookie = await targetSession();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/federation/invitations',
      headers: { cookie: `cpa_session=${cookie}` },
      payload: {
        subject_tenant_id: SUBJECT_TENANT,
        target_email: 'someone@example.com',
        expires_in_days: 7,
      },
    });

    assert.equal(res.statusCode, 404);
    await app.close();
  });
});

describe('POST /v1/federation/invitations/:id/accept', () => {
  test('accepts invitation and creates federation_share', async (t) => {
    if (skipIfNoDb(t)) return;

    const app = buildApp();
    await app.ready();

    // Step 1: Create invitation directly in DB for controlled token
    const tokenBytes = crypto.randomBytes(32);
    const tokenHex = tokenBytes.toString('hex');
    const tokenHash = crypto.createHash('sha256').update(tokenBytes).digest('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await privilegedSql`
      INSERT INTO federation_invitation (
        id, subject_tenant_id, source_tenant_id, target_email,
        invited_by_user_id, token_hash, expires_at
      )
      VALUES (
        '00000000-0000-4000-8000-000000093200',
        ${SUBJECT_TENANT}, ${SOURCE_TENANT}, 'financier@example.com',
        ${SOURCE_USER}, ${tokenHash}, ${expiresAt.toISOString()}::timestamptz
      )
    `;

    // Step 2: Accept as target tenant
    const cookie = await targetSession();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/federation/invitations/00000000-0000-4000-8000-000000093200/accept',
      headers: { cookie: `cpa_session=${cookie}` },
      payload: { token: tokenHex },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json<{ share_id: string; subject_tenant_id: string }>();
    assert.ok(body.share_id);
    assert.equal(body.subject_tenant_id, SUBJECT_TENANT);

    // Verify the share was created
    const shares = await privilegedSql<{ id: string }[]>`
      SELECT id FROM federation_share WHERE id = ${body.share_id}
    `;
    assert.equal(shares.length, 1);

    // Verify invitation is marked accepted
    const inv = await privilegedSql<{ status: string }[]>`
      SELECT status FROM federation_invitation WHERE id = '00000000-0000-4000-8000-000000093200'
    `;
    assert.equal(inv[0].status, 'accepted');

    await app.close();
  });

  test('rejects invalid token', async (t) => {
    if (skipIfNoDb(t)) return;

    const app = buildApp();
    await app.ready();

    // Create a valid invitation
    const tokenBytes = crypto.randomBytes(32);
    const tokenHash = crypto.createHash('sha256').update(tokenBytes).digest('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await privilegedSql`
      INSERT INTO federation_invitation (
        id, subject_tenant_id, source_tenant_id, target_email,
        invited_by_user_id, token_hash, expires_at
      )
      VALUES (
        '00000000-0000-4000-8000-000000093201',
        ${SUBJECT_TENANT}, ${SOURCE_TENANT}, 'financier@example.com',
        ${SOURCE_USER}, ${tokenHash}, ${expiresAt.toISOString()}::timestamptz
      )
    `;

    // Try to accept with wrong token
    const cookie = await targetSession();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/federation/invitations/00000000-0000-4000-8000-000000093201/accept',
      headers: { cookie: `cpa_session=${cookie}` },
      payload: { token: crypto.randomBytes(32).toString('hex') },
    });

    assert.equal(res.statusCode, 403);
    await app.close();
  });

  test('rejects expired invitation', async (t) => {
    if (skipIfNoDb(t)) return;

    const app = buildApp();
    await app.ready();

    const tokenBytes = crypto.randomBytes(32);
    const tokenHex = tokenBytes.toString('hex');
    const tokenHash = crypto.createHash('sha256').update(tokenBytes).digest('hex');
    const expiredAt = new Date(Date.now() - 1000); // already expired

    await privilegedSql`
      INSERT INTO federation_invitation (
        id, subject_tenant_id, source_tenant_id, target_email,
        invited_by_user_id, token_hash, expires_at
      )
      VALUES (
        '00000000-0000-4000-8000-000000093202',
        ${SUBJECT_TENANT}, ${SOURCE_TENANT}, 'financier@example.com',
        ${SOURCE_USER}, ${tokenHash}, ${expiredAt.toISOString()}::timestamptz
      )
    `;

    const cookie = await targetSession();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/federation/invitations/00000000-0000-4000-8000-000000093202/accept',
      headers: { cookie: `cpa_session=${cookie}` },
      payload: { token: tokenHex },
    });

    assert.equal(res.statusCode, 410);
    await app.close();
  });
});
