import { privilegedSql } from '@cpa/db/client';

/**
 * OCR + virus-scan job (T-A9).
 *
 * Triggered by the S3 finalize hook (or, for v1, called directly from
 * the media finalize route's best-effort enqueue path — same shape as
 * the transcribe job so future pg-boss wiring lifts both at once).
 *
 * For v1 this is a STUB:
 *   - The S3 byte-fetch is not implemented. Real impl will use the S3
 *     SDK + the row's s3_key.
 *   - AWS Textract is not called. Real impl will POST bytes to Textract
 *     with a sync DetectDocumentText (image) or async StartDocumentText-
 *     Detection (PDF) request.
 *   - ClamAV is not called. Real impl will hit the on-cluster scanner
 *     ClusterIP service.
 *
 * Behaviour the stub mimics deterministically:
 *   - image/* + application/pdf → ocr_status='complete', ocr_text =
 *     `stub-ocr-${s3_key}` (so tests can assert text was set).
 *   - anything else (audio, video, octet-stream) → ocr_status='skipped',
 *     ocr_text = null.
 *   - virus_scan_status always flips to 'clean' for v1 — there's no
 *     traffic from a real malicious sample test corpus yet.
 *
 * Idempotency: if ocr_status is anything other than 'pending' the job
 * exits without touching the row. This makes the future pg-boss retry
 * path safe (the same job_id can re-run without double-scanning), and
 * lets the route layer enqueue eagerly without checking state itself.
 *
 * OTel: this handler intentionally does not start a manual span. Fastify
 * auto-instrumentation captures the upstream HTTP call that triggered
 * the enqueue, and postgres-js auto-instrumentation captures the
 * SELECT/UPDATE pair. The handler runs synchronously inside that trace
 * context so child spans appear under the parent automatically. A
 * dedicated `ocr-scan` span gets added when this job moves into a
 * pg-boss subscriber (background context loses the parent trace) — see
 * the same TODO on transcribe.ts.
 */
export type OcrScanInput = {
  media_artefact_id: string;
};

export type OcrScanResult = {
  /** OCR text, when produced (image/pdf path); null otherwise. */
  ocr_text: string | null;
  /**
   * Outcome marker:
   *   - 'complete' — bytes were OCR'd, text persisted.
   *   - 'skipped'  — mime-type not OCR-eligible.
   *   - 'noop'     — row was already processed; no DB write.
   */
  ocr_status: 'complete' | 'skipped' | 'noop';
  virus_scan_status: 'clean' | 'infected' | 'failed';
};

/**
 * Run the OCR + virus-scan job.
 *
 * Sequence:
 *   1. Privileged-load the media_artefact row by id (worker has no
 *      request-scoped tenant context, but the id is the bind so cross-
 *      tenant leakage isn't a risk).
 *   2. If ocr_status !== 'pending', return a no-op result.
 *   3. STUB: derive ocr_text + ocr_status from mime_type.
 *   4. UPDATE the row with the new ocr_text / ocr_status / virus_scan_status.
 *   5. Return the new state for callers that want to short-circuit a
 *      follow-up read.
 *
 * Throws if the media_artefact_id doesn't resolve. The route layer
 * doesn't enqueue for nonexistent ids, so a throw indicates a real
 * race (row deleted between finalize and OCR drain).
 */
export async function runOcrScanJob(input: OcrScanInput): Promise<OcrScanResult> {
  const rows = await privilegedSql<
    Array<{
      id: string;
      s3_key: string;
      mime_type: string;
      ocr_status: 'pending' | 'complete' | 'failed' | 'skipped';
    }>
  >`
    SELECT id, s3_key, mime_type, ocr_status
      FROM media_artefact
     WHERE id = ${input.media_artefact_id}
  `;
  const row = rows[0];
  if (!row) {
    throw new Error(`media_artefact not found: ${input.media_artefact_id}`);
  }

  // Idempotency / re-entry guard: only act on rows still 'pending'.
  // Anything else is a no-op (the prior run won the race or succeeded).
  if (row.ocr_status !== 'pending') {
    return { ocr_text: null, ocr_status: 'noop', virus_scan_status: 'clean' };
  }

  // STUB: real bytes fetch + Textract + ClamAV come in a later task.
  // The discriminator is mime-type for v1 — image/* and application/pdf
  // get OCR'd, everything else is skipped.
  const isImage = row.mime_type.startsWith('image/');
  const isPdf = row.mime_type === 'application/pdf';
  const ocrEligible = isImage || isPdf;

  const ocrText = ocrEligible ? `stub-ocr-${row.s3_key}` : null;
  const ocrStatus: 'complete' | 'skipped' = ocrEligible ? 'complete' : 'skipped';
  const virusScanStatus = 'clean' as const;

  await privilegedSql`
    UPDATE media_artefact
       SET ocr_text = ${ocrText},
           ocr_status = ${ocrStatus},
           virus_scan_status = ${virusScanStatus}
     WHERE id = ${input.media_artefact_id}
  `;

  return {
    ocr_text: ocrText,
    ocr_status: ocrStatus,
    virus_scan_status: virusScanStatus,
  };
}
