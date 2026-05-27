import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { sql, privilegedSql } from '@cpa/db/client';
import {
  runEngagementLetterRenderPdfJob,
  handleEngagementLetterRenderPdfJob,
} from './engagement-letter-render-pdf.js';

/**
 * Engagement-letter PDF render job tests.
 *
 * Covers the documented acceptance criteria from
 * docs/plans/wizard-step-1/03-engagement-pdf-job.md:
 *   1. Happy path: signed letter -> rendered PDF + media_artefact row
 *      + engagement_letter.pdf_evidence_id back-link.
 *   2. Idempotency: re-running on the same engagement_letter_id is a
 *      no-op (no second media_artefact row created).
 *
 * Pinned UUID block `0e3` so a parallel suite seeding into
 * engagement_letter cannot collide with this file's fixtures (the
 * engagement-letter RLS suite uses `0e1`, the engagement-route suite
 * uses `0e2`).
 */

const TENANT = '00000000-0000-4000-8000-00000000e301';
const ADMIN_USER = '00000000-0000-4000-8000-00000000e310';
const SUBJECT = '00000000-0000-4000-8000-00000000e320';
const EMPLOYEE = '00000000-0000-4000-8000-00000000e330';
const CLAIM = '00000000-0000-4000-8000-00000000e340';
const LETTER = '00000000-0000-4000-8000-00000000e350';
const PRE_RENDERED_ARTEFACT = '00000000-0000-4000-8000-00000000e360';

const RENDERED_MARKDOWN = [
  '# Engagement Letter',
  '',
  'Engagement letter for Test Claimant Co (FY2025). Consultant: Test Firm Pty Ltd.',
  '',
  '## Scope',
  '',
  'The consultant agrees to prepare the R&DTI claim for the year ending 30 June 2025.',
  '',
  '## Fees',
  '',
  'Fees are charged on a success basis at 12% of the cash refund.',
].join('\n');

const cleanup = async (): Promise<void> => {
  // Order matters: media_artefact -> engagement_letter -> claim ->
  // subject_tenant_employee -> subject_tenant -> tenant_user / user
  // -> tenant. privilegedSql bypasses RLS.
  await privilegedSql`DELETE FROM media_artefact WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM engagement_letter WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM claim WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM subject_tenant_employee WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM subject_tenant WHERE id = ${SUBJECT}`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM "user" WHERE id = ${ADMIN_USER}`;
  await sql`DELETE FROM tenant WHERE id = ${TENANT}`;
};

before(async () => {
  await cleanup();

  await sql`
    INSERT INTO tenant (id, name, slug, primary_idp)
    VALUES (${TENANT}, 'PDF Render Firm', 'pdf-render-firm-e3', 'mixed')
  `;
  await sql`
    INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
    VALUES (${ADMIN_USER}, 'e3-admin@example.com', 'microsoft', 'microsoft:e3-admin', 'E3 Admin')
  `;
  await privilegedSql`
    INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
    VALUES (gen_random_uuid(), ${TENANT}, ${ADMIN_USER}, 'admin', true)
  `;
  await privilegedSql`
    INSERT INTO subject_tenant (id, tenant_id, name, kind)
    VALUES (${SUBJECT}, ${TENANT}, 'PDF Render Claimant Co', 'claimant')
  `;
  // media_artefact.uploaded_by_employee_id is NOT NULL — the job picks
  // the first non-deactivated employee on the claim's subject_tenant.
  await privilegedSql`
    INSERT INTO subject_tenant_employee (
      id, subject_tenant_id, tenant_id, email, name, invited_by_user_id
    ) VALUES (
      ${EMPLOYEE}, ${SUBJECT}, ${TENANT},
      'e3-emp@example.com', 'E3 Employee', ${ADMIN_USER}
    )
  `;
});

after(async () => {
  await cleanup();
  await sql.end();
  await privilegedSql.end();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedSignedLetter(): Promise<void> {
  await privilegedSql`DELETE FROM media_artefact WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM engagement_letter WHERE id = ${LETTER}`;
  await privilegedSql`DELETE FROM claim WHERE id = ${CLAIM}`;
  await privilegedSql`
    INSERT INTO claim (id, tenant_id, subject_tenant_id, fiscal_year, stage, engagement_status)
    VALUES (${CLAIM}, ${TENANT}, ${SUBJECT}, 2025, 'engagement', 'signed')
  `;
  await privilegedSql`
    INSERT INTO engagement_letter (
      id, tenant_id, claim_id, rendered_markdown, template_version,
      sent_to_claimant_at, signed_by_claimant_at, signed_by_claimant_name,
      signed_by_claimant_ip
    ) VALUES (
      ${LETTER}, ${TENANT}, ${CLAIM},
      ${RENDERED_MARKDOWN}, 'v1',
      NOW(), NOW(), 'Test Signer', '203.0.113.7'
    )
  `;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('invalid input: non-uuid engagement_letter_id returns failed (permanent)', async () => {
  const result = await runEngagementLetterRenderPdfJob({
    engagement_letter_id: 'not-a-uuid',
  });
  assert.equal(result.status, 'failed');
  if (result.status === 'failed') {
    assert.match(result.reason, /invalid job input/);
  }
});

test('row not found: returns failed (permanent)', async () => {
  const result = await runEngagementLetterRenderPdfJob({
    engagement_letter_id: '00000000-0000-4000-8000-00000000e399',
  });
  assert.equal(result.status, 'failed');
  if (result.status === 'failed') {
    assert.match(result.reason, /engagement_letter not found/);
  }
});

test('happy path: renders PDF, inserts media_artefact, back-links pdf_evidence_id', async () => {
  await seedSignedLetter();

  const result = await runEngagementLetterRenderPdfJob({
    engagement_letter_id: LETTER,
  });
  assert.equal(result.status, 'rendered', `unexpected result: ${JSON.stringify(result)}`);
  if (result.status !== 'rendered') return;
  const artefactId = result.media_artefact_id;
  assert.ok(artefactId.length === 36, 'media_artefact_id must be a uuid');

  // engagement_letter.pdf_evidence_id is set to the new artefact id.
  const letterRows = await privilegedSql<{ pdf_evidence_id: string | null }[]>`
    SELECT pdf_evidence_id FROM engagement_letter WHERE id = ${LETTER}
  `;
  assert.equal(letterRows[0]!.pdf_evidence_id, artefactId);

  // media_artefact row carries the expected shape: pdf mime,
  // subject_tenant scoped, deterministic s3_key, real byte payload.
  const artefactRows = await privilegedSql<
    {
      id: string;
      tenant_id: string;
      subject_tenant_id: string;
      uploaded_by_employee_id: string;
      s3_key: string;
      mime_type: string;
      size_bytes: string;
      content_hash: string;
      ocr_status: string;
      virus_scan_status: string;
    }[]
  >`
    SELECT id, tenant_id, subject_tenant_id, uploaded_by_employee_id,
           s3_key, mime_type, size_bytes::text AS size_bytes, content_hash,
           ocr_status, virus_scan_status
      FROM media_artefact
     WHERE id = ${artefactId}
  `;
  assert.equal(artefactRows.length, 1);
  const artefact = artefactRows[0]!;
  assert.equal(artefact.tenant_id, TENANT);
  assert.equal(artefact.subject_tenant_id, SUBJECT);
  assert.equal(artefact.uploaded_by_employee_id, EMPLOYEE);
  assert.equal(artefact.mime_type, 'application/pdf');
  assert.equal(artefact.s3_key, `engagement-letters/${TENANT}/${LETTER}.pdf`);
  assert.equal(artefact.ocr_status, 'skipped');
  assert.equal(artefact.virus_scan_status, 'clean');
  // PDF must have nonzero size and a sha256 hex content hash.
  assert.ok(Number(artefact.size_bytes) > 200, 'PDF size should exceed minimal header bytes');
  assert.match(artefact.content_hash, /^[0-9a-f]{64}$/);
});

test('idempotency: second run on the same letter is a no-op (no second media_artefact)', async () => {
  // The previous test left engagement_letter.pdf_evidence_id set and a
  // single media_artefact row. Re-run and assert no new row is created
  // and the same artefact id is returned.
  const beforeCount = await privilegedSql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM media_artefact WHERE tenant_id = ${TENANT}
  `;
  assert.equal(beforeCount[0]!.count, '1', 'precondition: exactly one artefact from happy-path');

  const result = await runEngagementLetterRenderPdfJob({
    engagement_letter_id: LETTER,
  });
  assert.equal(result.status, 'skipped_already_rendered');

  const afterCount = await privilegedSql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM media_artefact WHERE tenant_id = ${TENANT}
  `;
  assert.equal(afterCount[0]!.count, '1', 'second run must NOT insert another artefact');

  // Returned artefact id matches the one already stored on the letter.
  const letterRows = await privilegedSql<{ pdf_evidence_id: string | null }[]>`
    SELECT pdf_evidence_id FROM engagement_letter WHERE id = ${LETTER}
  `;
  if (result.status === 'skipped_already_rendered') {
    assert.equal(result.media_artefact_id, letterRows[0]!.pdf_evidence_id);
  }
});

test('idempotency: pre-set pdf_evidence_id short-circuits without rendering', async () => {
  // Seed a fresh letter row with pdf_evidence_id already populated.
  // The handler must NOT insert into media_artefact (the pre-set value
  // points at a uuid that doesn't exist as an artefact — the
  // short-circuit means we never try to read or write through it).
  const LETTER_2 = '00000000-0000-4000-8000-00000000e351';
  const CLAIM_2 = '00000000-0000-4000-8000-00000000e341';
  await privilegedSql`DELETE FROM engagement_letter WHERE id = ${LETTER_2}`;
  await privilegedSql`DELETE FROM claim WHERE id = ${CLAIM_2}`;
  await privilegedSql`
    INSERT INTO claim (id, tenant_id, subject_tenant_id, fiscal_year, stage, engagement_status)
    VALUES (${CLAIM_2}, ${TENANT}, ${SUBJECT}, 2024, 'engagement', 'signed')
  `;
  await privilegedSql`
    INSERT INTO engagement_letter (
      id, tenant_id, claim_id, rendered_markdown, template_version,
      pdf_evidence_id
    ) VALUES (
      ${LETTER_2}, ${TENANT}, ${CLAIM_2},
      'short circuit body', 'v1',
      ${PRE_RENDERED_ARTEFACT}
    )
  `;

  // Snapshot artefact count: should be unchanged across the call.
  const beforeCount = await privilegedSql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM media_artefact WHERE tenant_id = ${TENANT}
  `;

  const result = await runEngagementLetterRenderPdfJob({
    engagement_letter_id: LETTER_2,
  });
  assert.equal(result.status, 'skipped_already_rendered');
  if (result.status === 'skipped_already_rendered') {
    assert.equal(result.media_artefact_id, PRE_RENDERED_ARTEFACT);
  }

  const afterCount = await privilegedSql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM media_artefact WHERE tenant_id = ${TENANT}
  `;
  assert.equal(
    afterCount[0]!.count,
    beforeCount[0]!.count,
    'short-circuit path must NOT touch media_artefact',
  );

  // Tidy up so the next test starts from a known state.
  await privilegedSql`DELETE FROM engagement_letter WHERE id = ${LETTER_2}`;
  await privilegedSql`DELETE FROM claim WHERE id = ${CLAIM_2}`;
});

// ---------------------------------------------------------------------------
// Worker wrapper: permanent-vs-transient failure classification
// ---------------------------------------------------------------------------

test('handleEngagementLetterRenderPdfJob: permanent failure (invalid input) does NOT throw', async () => {
  const result = await handleEngagementLetterRenderPdfJob({
    engagement_letter_id: 'not-a-uuid',
  });
  assert.equal(result.status, 'failed');
  if (result.status === 'failed') {
    assert.match(result.reason, /invalid job input/);
  }
});

test('handleEngagementLetterRenderPdfJob: permanent failure (not found) does NOT throw', async () => {
  const result = await handleEngagementLetterRenderPdfJob({
    engagement_letter_id: '00000000-0000-4000-8000-00000000e398',
  });
  assert.equal(result.status, 'failed');
  if (result.status === 'failed') {
    assert.match(result.reason, /engagement_letter not found/);
  }
});
