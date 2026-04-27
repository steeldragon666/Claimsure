import crypto from 'node:crypto';
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { sql, privilegedSql } from '@cpa/db/client';
import { runOcrScanJob } from './ocr-scan.js';

// Pinned UUIDs so cleanup is precise. The 0a9 segment groups all A9
// fixtures so a partial failure leaves identifiable orphans.
const TENANT = '00000000-0000-4000-8000-0000000a9001';
const ADMIN_USER = '00000000-0000-4000-8000-0000000a9010';
const SUBJECT = '00000000-0000-4000-8000-0000000a9021';
const EMPLOYEE = '00000000-0000-4000-8000-0000000a9030';

// Per-test artefact ids — pinned so we don't have to thread RETURNING
// through every fixture, and so failed runs leave deterministic rows
// for cleanup.
const ART_IMAGE = '00000000-0000-4000-8000-0000000a9040';
const ART_PDF = '00000000-0000-4000-8000-0000000a9041';
const ART_AUDIO = '00000000-0000-4000-8000-0000000a9042';
const ART_ALREADY_DONE = '00000000-0000-4000-8000-0000000a9043';

const cleanup = async (): Promise<void> => {
  await privilegedSql`DELETE FROM media_artefact WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM subject_tenant_employee WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM subject_tenant WHERE id = ${SUBJECT}`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM "user" WHERE id = ${ADMIN_USER}`;
  await sql`DELETE FROM tenant WHERE id = ${TENANT}`;
};

const insertArtefact = async (args: {
  id: string;
  mimeType: string;
  ocrStatus?: 'pending' | 'complete' | 'failed' | 'skipped';
}): Promise<void> => {
  // content_hash is partial-unique per (tenant, subject, hash) so each
  // row needs a distinct 64-hex string; derive deterministically from
  // the artefact id.
  const hash = crypto.createHash('sha256').update(args.id).digest('hex');
  await privilegedSql`
    INSERT INTO media_artefact (
      id, tenant_id, subject_tenant_id, uploaded_by_employee_id,
      s3_key, content_hash, mime_type, size_bytes, ocr_status, virus_scan_status
    ) VALUES (
      ${args.id}, ${TENANT}, ${SUBJECT}, ${EMPLOYEE},
      ${`tenants/${TENANT}/subjects/${SUBJECT}/${hash}`},
      ${hash}, ${args.mimeType}, 1024,
      ${args.ocrStatus ?? 'pending'}, 'pending'
    )
  `;
};

before(async () => {
  await cleanup();
  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT}, 'Firm A', 'firm-a-a9', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${ADMIN_USER}, 'a9-admin@example.com', 'microsoft', 'microsoft:a9-admin', 'A9 Admin')`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT}, ${ADMIN_USER}, 'admin', true)`;
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                       VALUES (${SUBJECT}, ${TENANT}, 'Acme Co', 'claimant')`;
  await privilegedSql`
    INSERT INTO subject_tenant_employee (
      id, subject_tenant_id, tenant_id, email, name, invited_by_user_id
    ) VALUES (
      ${EMPLOYEE}, ${SUBJECT}, ${TENANT},
      'a9-emp@example.com', 'A9 Employee', ${ADMIN_USER}
    )
  `;

  // Seed all four artefacts — each test owns a distinct row so we don't
  // need per-test setup. Tests assert the post-state of "their" id.
  await insertArtefact({ id: ART_IMAGE, mimeType: 'image/jpeg' });
  await insertArtefact({ id: ART_PDF, mimeType: 'application/pdf' });
  await insertArtefact({ id: ART_AUDIO, mimeType: 'audio/m4a' });
  await insertArtefact({
    id: ART_ALREADY_DONE,
    mimeType: 'image/png',
    ocrStatus: 'complete',
  });
});

after(async () => {
  await cleanup();
  await sql.end();
  await privilegedSql.end();
});

test('runOcrScanJob: image → ocr_status=complete + ocr_text populated + virus_scan=clean', async () => {
  const result = await runOcrScanJob({ media_artefact_id: ART_IMAGE });
  assert.equal(result.ocr_status, 'complete');
  assert.ok(result.ocr_text !== null && result.ocr_text.startsWith('stub-ocr-'));
  assert.equal(result.virus_scan_status, 'clean');

  const rows = await privilegedSql<
    { ocr_text: string | null; ocr_status: string; virus_scan_status: string }[]
  >`
    SELECT ocr_text, ocr_status, virus_scan_status FROM media_artefact WHERE id = ${ART_IMAGE}
  `;
  assert.equal(rows[0]?.ocr_status, 'complete');
  assert.ok(rows[0]?.ocr_text?.startsWith('stub-ocr-tenants/'));
  assert.equal(rows[0]?.virus_scan_status, 'clean');
});

test('runOcrScanJob: PDF → ocr_status=complete + ocr_text populated', async () => {
  const result = await runOcrScanJob({ media_artefact_id: ART_PDF });
  assert.equal(result.ocr_status, 'complete');
  assert.ok(result.ocr_text !== null);

  const rows = await privilegedSql<{ ocr_status: string; ocr_text: string | null }[]>`
    SELECT ocr_status, ocr_text FROM media_artefact WHERE id = ${ART_PDF}
  `;
  assert.equal(rows[0]?.ocr_status, 'complete');
  assert.ok(rows[0]?.ocr_text?.includes('.pdf') === false); // s3_key has no extension
  assert.ok(rows[0]?.ocr_text?.startsWith('stub-ocr-'));
});

test('runOcrScanJob: non-image / non-PDF → ocr_status=skipped + ocr_text=null', async () => {
  const result = await runOcrScanJob({ media_artefact_id: ART_AUDIO });
  assert.equal(result.ocr_status, 'skipped');
  assert.equal(result.ocr_text, null);
  assert.equal(result.virus_scan_status, 'clean');

  const rows = await privilegedSql<
    { ocr_status: string; ocr_text: string | null; virus_scan_status: string }[]
  >`
    SELECT ocr_status, ocr_text, virus_scan_status FROM media_artefact WHERE id = ${ART_AUDIO}
  `;
  assert.equal(rows[0]?.ocr_status, 'skipped');
  assert.equal(rows[0]?.ocr_text, null);
  assert.equal(rows[0]?.virus_scan_status, 'clean');
});

test('runOcrScanJob: already-processed row → no-op (ocr_text + ocr_status preserved)', async () => {
  // Pre-populate ocr_text on the already-complete row so we can assert
  // the no-op path doesn't clobber it.
  await privilegedSql`
    UPDATE media_artefact
       SET ocr_text = 'preexisting-text', virus_scan_status = 'clean'
     WHERE id = ${ART_ALREADY_DONE}
  `;

  const result = await runOcrScanJob({ media_artefact_id: ART_ALREADY_DONE });
  assert.equal(result.ocr_status, 'noop');

  const rows = await privilegedSql<{ ocr_status: string; ocr_text: string | null }[]>`
    SELECT ocr_status, ocr_text FROM media_artefact WHERE id = ${ART_ALREADY_DONE}
  `;
  assert.equal(rows[0]?.ocr_status, 'complete');
  assert.equal(rows[0]?.ocr_text, 'preexisting-text');
});

test('runOcrScanJob: throws on unknown media_artefact_id', async () => {
  await assert.rejects(
    runOcrScanJob({ media_artefact_id: '00000000-0000-4000-8000-0000000a90ff' }),
    /media_artefact not found/,
  );
});
