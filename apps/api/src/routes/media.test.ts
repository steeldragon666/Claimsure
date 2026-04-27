import crypto from 'node:crypto';
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { signSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../app.js';
import { MOBILE_AUDIENCE } from '../middleware/mobile-jwt-verifier.js';

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';
process.env['SESSION_JWT_SECRET'] = SESSION_SECRET;

const TENANT_A = '00000000-0000-4000-8000-0000000a6001';
const TENANT_B = '00000000-0000-4000-8000-0000000a6002';
const ADMIN_USER = '00000000-0000-4000-8000-0000000a6010';
const SUBJECT_A1 = '00000000-0000-4000-8000-0000000a6021';
const SUBJECT_B1 = '00000000-0000-4000-8000-0000000a6022';
const EMPLOYEE_A = '00000000-0000-4000-8000-0000000a6030';

// 64-hex stand-in. SHA-256 of "test" so it's reproducible.
const FAKE_SHA = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
const FAKE_SHA_2 = '8855508aade16ec573d21e6a485dfd0a7624085c1a14b5ecdd6485de0c6839a4';

const cleanup = async (): Promise<void> => {
  await privilegedSql`DELETE FROM media_artefact WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM event WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM subject_tenant_employee WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM subject_tenant_user WHERE subject_tenant_id IN (
    SELECT id FROM subject_tenant WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})
  )`;
  await privilegedSql`DELETE FROM subject_tenant WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await sql`DELETE FROM "user" WHERE id = ${ADMIN_USER}`;
  await sql`DELETE FROM tenant WHERE id IN (${TENANT_A}, ${TENANT_B})`;
};

before(async () => {
  await cleanup();
  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT_A}, 'Firm A', 'firm-a-a6', 'mixed'),
                   (${TENANT_B}, 'Firm B', 'firm-b-a6', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${ADMIN_USER}, 'a6-admin@example.com', 'microsoft', 'microsoft:a6-admin', 'A6 Admin')`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT_A}, ${ADMIN_USER}, 'admin', true)`;
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                       VALUES (${SUBJECT_A1}, ${TENANT_A}, 'Acme Co', 'claimant'),
                              (${SUBJECT_B1}, ${TENANT_B}, 'Other Corp', 'claimant')`;
  await privilegedSql`
    INSERT INTO subject_tenant_employee (
      id, subject_tenant_id, tenant_id, email, name, invited_by_user_id
    ) VALUES (
      ${EMPLOYEE_A}, ${SUBJECT_A1}, ${TENANT_A},
      'a6-emp@example.com', 'A6 Employee', ${ADMIN_USER}
    )
  `;
});

after(async () => {
  await cleanup();
  await sql.end();
  await privilegedSql.end();
});

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

const mobileToken = async (
  args: {
    employeeId?: string;
    tenantId?: string;
    subjectTenantId?: string;
  } = {},
): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  const key = new TextEncoder().encode(SESSION_SECRET);
  return await new SignJWT({
    tenant_id: args.tenantId ?? TENANT_A,
    subject_tenant_id: args.subjectTenantId ?? SUBJECT_A1,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(args.employeeId ?? EMPLOYEE_A)
    .setAudience(MOBILE_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + ACCESS_TOKEN_TTL_SECONDS)
    .sign(key);
};

// ---------------- presigned-upload ----------------

test('POST /v1/media/presigned-upload: 401 without bearer token', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/media/presigned-upload',
    payload: { content_type: 'image/jpeg', size_bytes: 1024, sha256: FAKE_SHA },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /v1/media/presigned-upload: 200 returns stub URL + canonical s3_key', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/media/presigned-upload',
    headers: { authorization: `Bearer ${await mobileToken()}` },
    payload: { content_type: 'image/jpeg', size_bytes: 12345, sha256: FAKE_SHA },
  });
  assert.equal(res.statusCode, 200);
  const j = res.json<{
    upload_url: string;
    s3_key: string;
    content_hash_required: string;
  }>();
  assert.match(j.upload_url, /^https:\/\/placeholder\.s3\.amazonaws\.com\//);
  assert.equal(j.s3_key, `tenants/${TENANT_A}/subjects/${SUBJECT_A1}/${FAKE_SHA}`);
  assert.equal(j.content_hash_required, FAKE_SHA);
  await app.close();
});

test('POST /v1/media/presigned-upload: 400 size > 50MB', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/media/presigned-upload',
    headers: { authorization: `Bearer ${await mobileToken()}` },
    payload: {
      content_type: 'image/jpeg',
      size_bytes: 60 * 1024 * 1024,
      sha256: FAKE_SHA,
    },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /v1/media/presigned-upload: 400 bad sha256 format', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/media/presigned-upload',
    headers: { authorization: `Bearer ${await mobileToken()}` },
    payload: {
      content_type: 'image/jpeg',
      size_bytes: 1024,
      sha256: 'not-a-real-hash',
    },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /v1/media/presigned-upload: 400 bad content_type (text/plain)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/media/presigned-upload',
    headers: { authorization: `Bearer ${await mobileToken()}` },
    payload: {
      content_type: 'text/plain',
      size_bytes: 1024,
      sha256: FAKE_SHA,
    },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

// ---------------- finalize ----------------

test('POST /v1/media/finalize: 401 without bearer token', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/media/finalize',
    payload: {
      s3_key: `tenants/${TENANT_A}/subjects/${SUBJECT_A1}/${FAKE_SHA}`,
      content_hash: FAKE_SHA,
      mime_type: 'image/jpeg',
      size_bytes: 1024,
    },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /v1/media/finalize: 201 + media row with ocr_status pending', async () => {
  const app = buildApp();
  const sha = '11' + FAKE_SHA.slice(2); // unique per-test sha
  const s3Key = `tenants/${TENANT_A}/subjects/${SUBJECT_A1}/${sha}`;
  const res = await app.inject({
    method: 'POST',
    url: '/v1/media/finalize',
    headers: { authorization: `Bearer ${await mobileToken()}` },
    payload: {
      s3_key: s3Key,
      content_hash: sha,
      mime_type: 'image/jpeg',
      size_bytes: 12345,
      exif: { Orientation: 1, GPS: { lat: -33.86 } },
    },
  });
  assert.equal(res.statusCode, 201);
  const j = res.json<{
    media: {
      id: string;
      tenant_id: string;
      subject_tenant_id: string;
      event_id: string | null;
      uploaded_by_employee_id: string;
      s3_key: string;
      content_hash: string;
      mime_type: string;
      ocr_status: string;
      virus_scan_status: string;
    };
  }>();
  assert.equal(j.media.tenant_id, TENANT_A);
  assert.equal(j.media.subject_tenant_id, SUBJECT_A1);
  assert.equal(j.media.uploaded_by_employee_id, EMPLOYEE_A);
  assert.equal(j.media.s3_key, s3Key);
  assert.equal(j.media.content_hash, sha);
  assert.equal(j.media.event_id, null);
  assert.equal(j.media.ocr_status, 'pending');
  assert.equal(j.media.virus_scan_status, 'pending');

  // Confirm the row landed in the DB.
  const rows = await privilegedSql<{ id: string; exif: unknown }[]>`
    SELECT id, exif FROM media_artefact WHERE id = ${j.media.id}
  `;
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]?.exif, { Orientation: 1, GPS: { lat: -33.86 } });

  await app.close();
});

test('POST /v1/media/finalize: 400 mismatched content_hash format', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/media/finalize',
    headers: { authorization: `Bearer ${await mobileToken()}` },
    payload: {
      s3_key: `tenants/${TENANT_A}/subjects/${SUBJECT_A1}/${FAKE_SHA}`,
      content_hash: 'NOT_HEX',
      mime_type: 'image/jpeg',
      size_bytes: 1024,
    },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /v1/media/finalize: 403 cross-tenant s3_key', async () => {
  const app = buildApp();
  // Forge a key under TENANT_B + SUBJECT_B1; the EMPLOYEE_A JWT is
  // bound to TENANT_A + SUBJECT_A1, so the prefix check rejects.
  const res = await app.inject({
    method: 'POST',
    url: '/v1/media/finalize',
    headers: { authorization: `Bearer ${await mobileToken()}` },
    payload: {
      s3_key: `tenants/${TENANT_B}/subjects/${SUBJECT_B1}/${FAKE_SHA_2}`,
      content_hash: FAKE_SHA_2,
      mime_type: 'image/jpeg',
      size_bytes: 1024,
    },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('POST /v1/media/finalize: 400 hash does not match s3_key suffix', async () => {
  const app = buildApp();
  // s3_key claims one hash; content_hash claims another.
  const res = await app.inject({
    method: 'POST',
    url: '/v1/media/finalize',
    headers: { authorization: `Bearer ${await mobileToken()}` },
    payload: {
      s3_key: `tenants/${TENANT_A}/subjects/${SUBJECT_A1}/${FAKE_SHA}`,
      content_hash: FAKE_SHA_2,
      mime_type: 'image/jpeg',
      size_bytes: 1024,
    },
  });
  assert.equal(res.statusCode, 400);
  const j = res.json<{ error: { code: string } }>();
  assert.equal(j.error.code, 'HASH_MISMATCH');
  await app.close();
});

test('POST /v1/media/finalize: idempotent on (tenant, subject, hash)', async () => {
  const app = buildApp();
  const sha = '22' + FAKE_SHA.slice(2);
  const payload = {
    s3_key: `tenants/${TENANT_A}/subjects/${SUBJECT_A1}/${sha}`,
    content_hash: sha,
    mime_type: 'image/jpeg',
    size_bytes: 1024,
  };
  const headers = { authorization: `Bearer ${await mobileToken()}` };

  const first = await app.inject({
    method: 'POST',
    url: '/v1/media/finalize',
    headers,
    payload,
  });
  assert.equal(first.statusCode, 201);
  const firstId = first.json<{ media: { id: string } }>().media.id;

  const second = await app.inject({
    method: 'POST',
    url: '/v1/media/finalize',
    headers,
    payload,
  });
  assert.equal(second.statusCode, 200);
  const j = second.json<{ media: { id: string }; duplicate?: boolean }>();
  assert.equal(j.media.id, firstId);
  assert.equal(j.duplicate, true);

  await app.close();
});

// ---------------- Consultant CRUD (T-A8) ----------------

const adminJwt = (): Promise<string> =>
  signSession(
    {
      sub: ADMIN_USER,
      email: 'a6-admin@example.com',
      primaryIdp: 'microsoft',
      activeTenantId: TENANT_A,
      activeRole: 'admin',
      availableTenants: [],
    },
    SESSION_SECRET,
    { ttlSeconds: 3600 },
  );

/**
 * Helper: directly insert a media_artefact row via privilegedSql so
 * the CRUD tests have something to read without re-running the
 * mobile presign + finalize ceremony.
 */
async function seedMedia(args: {
  tenantId: string;
  subjectTenantId: string;
  contentHash: string;
}): Promise<string> {
  // We seed with EMPLOYEE_A regardless of tenant — the FK only
  // requires the row exists, and we delete all media_artefact rows
  // in cleanup so leakage isn't an issue. The cross-firm test seed
  // still has correct (tenant, subject) for RLS coverage.
  // Migration 0008 declares media_artefact.id PRIMARY KEY NOT NULL with
  // no DB-level default — Drizzle's $defaultFn only fires for
  // db.insert() paths, not raw SQL. Supply id explicitly here for the
  // same reason routes/media.ts:226 does on the production INSERT.
  const rows = await privilegedSql<{ id: string }[]>`
    INSERT INTO media_artefact (
      id, tenant_id, subject_tenant_id, uploaded_by_employee_id,
      s3_key, content_hash, mime_type, size_bytes
    ) VALUES (
      ${crypto.randomUUID()},
      ${args.tenantId},
      ${args.subjectTenantId},
      ${EMPLOYEE_A},
      ${`tenants/${args.tenantId}/subjects/${args.subjectTenantId}/${args.contentHash}`},
      ${args.contentHash},
      'image/jpeg',
      ${1024}
    )
    RETURNING id
  `;
  return rows[0]!.id;
}

test('GET /v1/media: 401 without session', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/media?subject_tenant_id=${SUBJECT_A1}`,
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('GET /v1/media: 200 RLS-scoped list', async () => {
  // Seed two rows under TENANT_A and one under TENANT_B; the
  // admin's RLS scope (TENANT_A) should see only the first two.
  const sha1 = '33' + FAKE_SHA.slice(2);
  const sha2 = '44' + FAKE_SHA.slice(2);
  const sha3 = '55' + FAKE_SHA.slice(2);
  await seedMedia({ tenantId: TENANT_A, subjectTenantId: SUBJECT_A1, contentHash: sha1 });
  await seedMedia({ tenantId: TENANT_A, subjectTenantId: SUBJECT_A1, contentHash: sha2 });
  await seedMedia({ tenantId: TENANT_B, subjectTenantId: SUBJECT_B1, contentHash: sha3 });

  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/media?subject_tenant_id=${SUBJECT_A1}`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const j = res.json<{ media: { id: string; content_hash: string }[] }>();
  // We may have leftover rows from earlier finalize tests under
  // SUBJECT_A1 — assert at least the two we seeded are visible and
  // none from TENANT_B leak.
  const hashes = j.media.map((m) => m.content_hash);
  assert.ok(hashes.includes(sha1));
  assert.ok(hashes.includes(sha2));
  assert.ok(!hashes.includes(sha3));
  await app.close();
});

test('GET /v1/media/:id: 200 with row + stub download URL', async () => {
  const sha = '66' + FAKE_SHA.slice(2);
  const id = await seedMedia({
    tenantId: TENANT_A,
    subjectTenantId: SUBJECT_A1,
    contentHash: sha,
  });

  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/media/${id}`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const j = res.json<{
    media: { id: string; content_hash: string };
    download_url: string;
  }>();
  assert.equal(j.media.id, id);
  assert.equal(j.media.content_hash, sha);
  assert.match(j.download_url, /^https:\/\/placeholder\.s3\.amazonaws\.com\//);
  await app.close();
});

test('GET /v1/media/:id: 404 cross-firm', async () => {
  const sha = '77' + FAKE_SHA.slice(2);
  const id = await seedMedia({
    tenantId: TENANT_B,
    subjectTenantId: SUBJECT_B1,
    contentHash: sha,
  });
  // ADMIN_USER is bound to TENANT_A; reading a TENANT_B row → 404.
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/media/${id}`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('GET /v1/media/:id: 400 non-uuid', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/media/not-a-uuid`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('DELETE /v1/media/:id: 200 removes row', async () => {
  const sha = '88' + FAKE_SHA.slice(2);
  const id = await seedMedia({
    tenantId: TENANT_A,
    subjectTenantId: SUBJECT_A1,
    contentHash: sha,
  });

  const app = buildApp();
  const res = await app.inject({
    method: 'DELETE',
    url: `/v1/media/${id}`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);

  const rows = await privilegedSql<{ id: string }[]>`
    SELECT id FROM media_artefact WHERE id = ${id}
  `;
  assert.equal(rows.length, 0);
  await app.close();
});

test('DELETE /v1/media/:id: 404 cross-firm', async () => {
  const sha = '99' + FAKE_SHA.slice(2);
  const id = await seedMedia({
    tenantId: TENANT_B,
    subjectTenantId: SUBJECT_B1,
    contentHash: sha,
  });
  const app = buildApp();
  const res = await app.inject({
    method: 'DELETE',
    url: `/v1/media/${id}`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 404);

  // Row should still exist in TENANT_B.
  const rows = await privilegedSql<{ id: string }[]>`
    SELECT id FROM media_artefact WHERE id = ${id}
  `;
  assert.equal(rows.length, 1);
  await app.close();
});
