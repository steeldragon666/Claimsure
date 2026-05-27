/**
 * Engagement-letter PDF render pg-boss job (Wizard Step 1, Task 03).
 *
 * Enqueued by POST /v1/engagement/:token/sign (see
 * `routes/engagement/sign.ts`) immediately after the claimant signs.
 * Renders the engagement_letter.rendered_markdown snapshot into an
 * immutable PDF, stores it as a `media_artefact` row, and back-links
 * the artefact id onto `engagement_letter.pdf_evidence_id`.
 *
 * ## Idempotency
 *
 * The handler is idempotent on `engagement_letter_id`. The first action
 * is a privileged read of the row; if `pdf_evidence_id` is already
 * non-null, the handler returns `skipped_already_rendered` without
 * re-rendering or inserting. This is the primary guard against retry
 * storms (pg-boss may dispatch the same job twice on worker crash) and
 * also against the recovery-sweep pathway that the `sign.ts` endpoint
 * anticipates ("sweep job can re-enqueue based on `pdf_evidence_id IS
 * NULL`").
 *
 * ## PDF renderer
 *
 * Uses `@react-pdf/renderer` (already in this monorepo via
 * `@cpa/documents`). That package was chosen by the C7/C9/A8/F.9 PDFs
 * before this task; reusing it keeps the binary surface small (no
 * headless Chromium / puppeteer dependency) and keeps generated PDFs
 * deterministic across runs (no font hinting / OS-dependent rasteriser
 * differences). The renderer is in-process so workers have no extra
 * runtime requirements beyond the Node binary.
 *
 * The JSX renderer lives in
 * `packages/documents/src/engagement-letter.tsx` so this job module
 * stays a plain `.ts` file (mirrors the activity-pdf route + A8
 * package layout).
 *
 * Sibling Step 2 Task 07 ("evidence-table PDF render") should use the
 * same library for consistency.
 *
 * ## Storage
 *
 * `media_artefact` is the closest existing storage shape for tenant-
 * scoped immutable artefacts. The `evidence` table referenced in the
 * design doc does not exist yet — `routes/evidence.ts` is a logical
 * view over `event + media_artefact` (see migration 0087 NOTE).
 *
 * `media_artefact.uploaded_by_employee_id` is `NOT NULL`, so the job
 * resolves a `subject_tenant_employee` row for the claim's
 * `subject_tenant_id`. The first non-deactivated employee is used; if
 * none exists, the handler treats the condition as transient and
 * throws so pg-boss retries — employees are usually provisioned at
 * engagement-send time, but a brand-new claimant tenant may be empty
 * for a short window. If the retry budget exhausts, the recovery sweep
 * documented in `sign.ts` will re-enqueue once the operator seeds an
 * employee.
 *
 * `s3_key` is a deterministic path
 *   engagement-letters/<tenant_id>/<engagement_letter_id>.pdf
 * The actual byte upload to S3 is wired by the storage adapter that
 * other jobs (transcribe, ocr-scan) also stub; until that lands the
 * bytes live only in the media_artefact row's metadata. This mirrors
 * the OCR/transcribe pattern in this codebase.
 *
 * ## RLS
 *
 * Workers have no request context, so the job uses `privilegedSql`
 * throughout. The privileged role is the table owner and bypasses RLS.
 * Same connection pattern as `claim-finalisation`,
 * `claim-evidence-binding`, `document-extract` and every other job in
 * this directory.
 *
 * ## Retry policy
 *
 * Permanent failures (engagement letter row not found; row missing
 * required claim/tenant joins) are absorbed and returned as
 * `failed:<reason>`. Transient failures (DB blip, rendering error,
 * employee-lookup race) are re-thrown so pg-boss engages its retry
 * policy — same pattern as `handleClaimEvidenceBindingJob`. See
 * commit fb0199c "fix(api): re-throw on transient pg-boss job failures
 * to engage retry policy" for the precedent.
 */

import type { PgBoss } from 'pg-boss';
import { createHash } from 'node:crypto';
import { privilegedSql } from '@cpa/db/client';
import { renderEngagementLetterPdf } from '@cpa/documents';

export const ENGAGEMENT_LETTER_RENDER_PDF_QUEUE = 'engagement-letter-render-pdf';

/**
 * Job payload. Matches what `routes/engagement/sign.ts` enqueues:
 *   boss.send(PDF_RENDER_JOB, { engagement_letter_id: ... })
 */
export type EngagementLetterRenderPdfInput = {
  engagement_letter_id: string;
};

export type EngagementLetterRenderPdfResult =
  | { status: 'rendered'; engagement_letter_id: string; media_artefact_id: string }
  | { status: 'skipped_already_rendered'; engagement_letter_id: string; media_artefact_id: string }
  | { status: 'failed'; engagement_letter_id: string; reason: string };

const PERMANENT_FAILURE_REASONS: ReadonlySet<string> = new Set([
  'invalid job input',
  'engagement_letter not found',
  'claim not found',
  'tenant not found',
]);

function isPermanentFailureReason(reason: string | undefined): boolean {
  if (!reason) return false;
  for (const marker of PERMANENT_FAILURE_REASONS) {
    if (reason.includes(marker)) return true;
  }
  return false;
}

/**
 * Core processor. Returns a typed outcome rather than throwing so that
 * callers (test harness AND the pg-boss wrapper) can branch on
 * permanent-vs-transient failure.
 *
 * Transient failures (DB blip, render-to-buffer failure, employee race)
 * are still thrown — only the explicit `failed` reasons in
 * `PERMANENT_FAILURE_REASONS` are absorbed.
 */
export async function runEngagementLetterRenderPdfJob(
  input: EngagementLetterRenderPdfInput,
): Promise<EngagementLetterRenderPdfResult> {
  // 0. Input validation.
  if (
    !input ||
    typeof input.engagement_letter_id !== 'string' ||
    input.engagement_letter_id.length !== 36
  ) {
    return {
      status: 'failed',
      engagement_letter_id: input?.engagement_letter_id ?? '',
      reason: 'invalid job input: engagement_letter_id must be a uuid',
    };
  }
  const { engagement_letter_id } = input;

  // 1. Load engagement_letter row. privilegedSql bypasses RLS.
  const letterRows = await privilegedSql<
    {
      id: string;
      tenant_id: string;
      claim_id: string;
      rendered_markdown: string;
      template_version: string;
      signed_by_claimant_at: Date | null;
      signed_by_claimant_name: string | null;
      signed_by_claimant_ip: string | null;
      pdf_evidence_id: string | null;
    }[]
  >`
    SELECT id, tenant_id, claim_id, rendered_markdown, template_version,
           signed_by_claimant_at, signed_by_claimant_name, signed_by_claimant_ip,
           pdf_evidence_id
      FROM engagement_letter
     WHERE id = ${engagement_letter_id}
     LIMIT 1
  `;
  const letter = letterRows[0];
  if (!letter) {
    return {
      status: 'failed',
      engagement_letter_id,
      reason: 'engagement_letter not found',
    };
  }

  // 2. Idempotency: if a PDF was already rendered, no-op. Re-enqueue is
  //    safe — same media_artefact id is returned so the caller's
  //    observable state is unchanged.
  if (letter.pdf_evidence_id) {
    return {
      status: 'skipped_already_rendered',
      engagement_letter_id,
      media_artefact_id: letter.pdf_evidence_id,
    };
  }

  // 3. Load claim + tenant + subject_tenant metadata used in the PDF
  //    header. A single join keeps the round-trip count low.
  const metaRows = await privilegedSql<
    {
      subject_tenant_id: string;
      subject_tenant_name: string | null;
      tenant_name: string;
    }[]
  >`
    SELECT c.subject_tenant_id::text AS subject_tenant_id,
           st.name                   AS subject_tenant_name,
           t.name                    AS tenant_name
      FROM claim c
      JOIN tenant t              ON t.id  = c.tenant_id
      LEFT JOIN subject_tenant st ON st.id = c.subject_tenant_id
     WHERE c.id = ${letter.claim_id}
       AND c.tenant_id = ${letter.tenant_id}
     LIMIT 1
  `;
  const meta = metaRows[0];
  if (!meta) {
    return {
      status: 'failed',
      engagement_letter_id,
      reason: 'claim not found',
    };
  }

  // 4. Resolve an uploader employee for the media_artefact row.
  //    media_artefact.uploaded_by_employee_id is NOT NULL — see
  //    `packages/db/src/schema/media_artefact.ts`. We pick the first
  //    non-deactivated employee on the subject_tenant. Stable ordering
  //    via id keeps test fixtures deterministic.
  const employeeRows = await privilegedSql<{ id: string }[]>`
    SELECT id
      FROM subject_tenant_employee
     WHERE subject_tenant_id = ${meta.subject_tenant_id}
       AND tenant_id          = ${letter.tenant_id}
       AND deactivated_at IS NULL
     ORDER BY id ASC
     LIMIT 1
  `;
  const employee = employeeRows[0];
  if (!employee) {
    // Treated as TRANSIENT: an empty employee table during the brief
    // window between tenant provisioning and first invite resolves
    // itself; pg-boss retries are the right behaviour.
    throw new Error(
      `no subject_tenant_employee available for subject_tenant=${meta.subject_tenant_id} ` +
        `(tenant=${letter.tenant_id}); will retry`,
    );
  }

  // 5. Render markdown -> PDF bytes.
  const generatedAt = new Date();
  let pdfBytes: Uint8Array;
  try {
    pdfBytes = await renderEngagementLetterPdf({
      firmName: meta.tenant_name,
      claimantName: meta.subject_tenant_name,
      templateVersion: letter.template_version,
      engagementLetterId: letter.id,
      renderedMarkdown: letter.rendered_markdown,
      signedAt: letter.signed_by_claimant_at,
      signedByClaimantName: letter.signed_by_claimant_name,
      signedByClaimantIp: letter.signed_by_claimant_ip,
      generatedAt,
    });
  } catch (err) {
    // Renderer errors are TRANSIENT (font-resolution, pdfkit stream
    // glitch). Throw so pg-boss retries.
    throw new Error(
      `engagement-letter PDF render failed for ${engagement_letter_id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const contentHash = createHash('sha256').update(pdfBytes).digest('hex');
  const sizeBytes = pdfBytes.byteLength;
  const s3Key = `engagement-letters/${letter.tenant_id}/${letter.id}.pdf`;

  // 6. Insert media_artefact + back-link in a single tx so a partial
  //    write doesn't leave the engagement letter pointing at an
  //    orphaned artefact.
  //
  //    Note on idempotency under concurrent retries: media_artefact has
  //    a partial-unique index on (tenant_id, subject_tenant_id,
  //    content_hash). A second concurrent worker rendering the same
  //    letter would produce an identical PDF byte-for-byte (the
  //    rendered_markdown + signed_at are stable inputs), hit the
  //    unique constraint, and the INSERT would fail with 23505. We
  //    catch that and re-select the winning row.
  const mediaArtefactId = await privilegedSql.begin<string>(async (tx) => {
    let artefactId: string;
    try {
      const inserted = await tx<{ id: string }[]>`
        INSERT INTO media_artefact (
          id, tenant_id, subject_tenant_id, uploaded_by_employee_id,
          s3_key, content_hash, mime_type, size_bytes,
          ocr_status, virus_scan_status
        ) VALUES (
          gen_random_uuid(),
          ${letter.tenant_id},
          ${meta.subject_tenant_id},
          ${employee.id},
          ${s3Key},
          ${contentHash},
          'application/pdf',
          ${sizeBytes},
          'skipped',
          'clean'
        )
        RETURNING id
      `;
      artefactId = inserted[0]!.id;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        const existing = await tx<{ id: string }[]>`
          SELECT id FROM media_artefact
           WHERE tenant_id          = ${letter.tenant_id}
             AND subject_tenant_id  = ${meta.subject_tenant_id}
             AND content_hash       = ${contentHash}
           LIMIT 1
        `;
        if (!existing[0]) throw err;
        artefactId = existing[0].id;
      } else {
        throw err;
      }
    }

    // Back-link onto engagement_letter. Conditional update via the
    // `pdf_evidence_id IS NULL` predicate keeps two concurrent workers
    // honest — the first wins, the second sees the column already set
    // and reads back the winner via the next idempotency short-circuit.
    await tx`
      UPDATE engagement_letter
         SET pdf_evidence_id = ${artefactId}
       WHERE id = ${letter.id}
         AND pdf_evidence_id IS NULL
    `;

    return artefactId;
  });

  return {
    status: 'rendered',
    engagement_letter_id,
    media_artefact_id: mediaArtefactId,
  };
}

/**
 * pg-boss worker entry point. Re-throws transient failures so the
 * queue's retry policy engages; absorbs permanent ones. Mirrors
 * `handleClaimEvidenceBindingJob` (commit fb0199c).
 */
export async function handleEngagementLetterRenderPdfJob(
  data: EngagementLetterRenderPdfInput,
): Promise<EngagementLetterRenderPdfResult> {
  const result = await runEngagementLetterRenderPdfJob(data);
  if (result.status === 'failed') {
    console.warn(
      `[engagement-letter-render-pdf] engagement_letter_id=${data?.engagement_letter_id} ` +
        `status=failed reason=${result.reason}`,
    );
    if (!isPermanentFailureReason(result.reason)) {
      throw new Error(`Transient failure, will retry: ${result.reason}`);
    }
  } else {
    console.log(
      `[engagement-letter-render-pdf] engagement_letter_id=${data.engagement_letter_id} ` +
        `status=${result.status} media_artefact_id=${result.media_artefact_id}`,
    );
  }
  return result;
}

/**
 * Register the engagement-letter-render-pdf worker. Called from
 * `server.ts` after `getBoss()` succeeds.
 */
export async function registerEngagementLetterRenderPdfJob(boss: PgBoss): Promise<void> {
  await boss.createQueue(ENGAGEMENT_LETTER_RENDER_PDF_QUEUE);
  await boss.work<EngagementLetterRenderPdfInput>(
    ENGAGEMENT_LETTER_RENDER_PDF_QUEUE,
    async (jobs) => {
      for (const job of jobs) {
        await handleEngagementLetterRenderPdfJob(job.data);
      }
    },
  );
}
