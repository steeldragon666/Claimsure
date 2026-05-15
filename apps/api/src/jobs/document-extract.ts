import type { PgBoss } from 'pg-boss';
import { privilegedSql, sql } from '@cpa/db/client';
import { makeDocumentAnalyzer, recordUsage, type TaggedSql } from '@cpa/agents';

/**
 * Queue name used by both the sender (route) and the subscriber (this worker).
 * Keep as a single constant so a rename is one line, not a grep-and-replace.
 */
export const DOCUMENT_EXTRACT_QUEUE = 'document-extract';

/**
 * Job payload emitted by the POST /v1/events handler after inserting a
 * file-upload event. The worker uses event_id to load the event, reads
 * the extracted text from payload.extracted_text, runs the document
 * analyzer, and writes the result back to the event row.
 */
export type DocumentExtractJobInput = {
  event_id: string;
  tenant_id: string;
  subject_tenant_id: string;
};

/**
 * Register the document-extract pg-boss worker.
 *
 * Called from server.ts after getBoss() so the worker is live
 * whenever the API process is running in non-test mode.
 */
export async function registerDocumentExtractJob(boss: PgBoss): Promise<void> {
  await boss.createQueue(DOCUMENT_EXTRACT_QUEUE);
  await boss.work<DocumentExtractJobInput>(DOCUMENT_EXTRACT_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const input = job.data;
      await runDocumentExtractJob(input);
    }
  });
}

/**
 * Lazy singleton for the document analyzer — mirrors the classifier/allocator
 * pattern in events.ts.
 */
let analyzerInstance: ReturnType<typeof makeDocumentAnalyzer> | null = null;
const getAnalyzer = () => {
  if (!analyzerInstance) {
    // DIAGNOSTIC: surface what env the worker actually sees at runtime.
    // Observed bug: stub analyzer running on production despite
    // DOCUMENT_ANALYZER_IMPL=haiku set on the Railway service. Either the
    // env var isn't propagating to the container, or some other code path
    // is instantiating the stub. This log proves which.
    console.log(
      '[document-extract][DIAG] instantiating analyzer:',
      JSON.stringify({
        DOCUMENT_ANALYZER_IMPL: process.env.DOCUMENT_ANALYZER_IMPL ?? '<unset>',
        CLASSIFIER_IMPL: process.env.CLASSIFIER_IMPL ?? '<unset>',
        CI: process.env.CI ?? '<unset>',
        NODE_ENV: process.env.NODE_ENV ?? '<unset>',
        ANTHROPIC_KEY_PRESENT: !!process.env.ANTHROPIC_API_KEY,
      }),
    );
    analyzerInstance = makeDocumentAnalyzer();
    console.log(
      '[document-extract][DIAG] analyzer constructor:',
      analyzerInstance.constructor.name,
    );
  }
  return analyzerInstance;
};

/**
 * Run document extraction for a single file-upload event.
 *
 * Sequence:
 *   1. Load the event row (privileged — no tenant GUC in worker context).
 *   2. Check extraction_status — skip if already 'complete'.
 *   3. Extract the raw_text from the payload and parse out the
 *      'Extracted-Text:' section appended by the client-side extractor.
 *   4. Load existing activities for the subject tenant so the analyzer
 *      can dedupe proposals.
 *   5. Run the document analyzer.
 *   6. Persist the result (extracted_content + extraction_status='complete')
 *      and emit an EXTRACTION_COMPLETED chain event.
 *
 * On any error: sets extraction_status='failed' and stores error details
 * in extracted_content so the UI can surface a meaningful message.
 */
export async function runDocumentExtractJob(input: DocumentExtractJobInput): Promise<void> {
  const { event_id, tenant_id, subject_tenant_id } = input;

  // Step 0: claim this event under a postgres advisory lock so we
  // don't double-bill on retry storms. Caught by
  // document-extract.stress.test.ts ("10x concurrent same-event"
  // dispatch produced 10 ledger rows before this fix).
  //
  // Flow inside the lock:
  //   1. pg_advisory_xact_lock keyed on hashtext(event_id). Auto-
  //      released when the wrapping tx commits.
  //   2. Read current extraction_status.
  //   3. If 'complete' or 'processing' -> some other worker already
  //      has this; short-circuit with skip.
  //   4. Otherwise UPDATE to 'processing' and proceed. The next
  //      worker that acquires the lock will see 'processing' and
  //      skip via step 3.
  //
  // We use `sql` (cpa_app role) NOT privilegedSql for the lock tx
  // so the GUC + lock live in the same session. The rest of the
  // worker uses privilegedSql for writes — postgres advisory locks
  // are per-database (not per-session) so the lock serialises across
  // both roles correctly.
  //
  // The CHECK constraint for 'processing' was added in migration
  // 0083_event_extraction_processing_state.sql.
  const lockResult = await sql.begin(async (tx) => {
    // Set the tenant GUC so RLS lets us see the row. The @cpa/db
    // sql.begin wrapper auto-runs SET LOCAL ROLE cpa_app first, so
    // we now need the tenant context too — otherwise RLS filters
    // the event row to zero and the worker bails as 'not_found'.
    await tx`SELECT set_config('app.current_tenant_id', ${tenant_id}, true)`;
    await tx`SELECT pg_advisory_xact_lock(hashtext(${event_id})::bigint)`;
    const rows = await tx<{ id: string; payload: unknown; extraction_status: string | null }[]>`
      SELECT id, payload, extraction_status
        FROM event
       WHERE id = ${event_id} AND tenant_id = ${tenant_id}
    `;
    const r = rows[0];
    if (!r) return { kind: 'not_found' as const };
    if (r.extraction_status === 'complete' || r.extraction_status === 'processing') {
      return { kind: 'already_claimed' as const };
    }
    await tx`
      UPDATE event SET extraction_status = 'processing'
       WHERE id = ${event_id} AND tenant_id = ${tenant_id}
    `;
    return { kind: 'claimed' as const, row: r };
  });

  if (lockResult.kind === 'not_found') {
    console.error(`[document-extract] event ${event_id} not found`);
    return;
  }
  if (lockResult.kind === 'already_claimed') {
    return;
  }
  const row = lockResult.row;

  const payload = row.payload as Record<string, unknown> | null;
  const rawText = typeof payload?.raw_text === 'string' ? payload.raw_text : '';

  // Step 3: parse file metadata and extracted text from raw_text.
  const { filename, mimeType, extractedText } = parseFileUploadPayload(rawText);

  if (!extractedText || extractedText.length < 50) {
    // No extracted text — mark as failed with a descriptive reason.
    const noTextPayload: Record<string, unknown> = {
      error: 'no_extracted_text',
      reason:
        'File upload did not include extracted text. Re-upload the file using a browser that supports text extraction (DOCX, PDF, XLSX).',
    };
    await privilegedSql`
      UPDATE event
         SET extraction_status  = 'failed',
             extracted_content  = ${privilegedSql.json(noTextPayload as Record<string, never>)}
       WHERE id = ${event_id}
    `;
    return;
  }

  // Step 4: load existing activities for this subject_tenant (for deduplication).
  const activities = await privilegedSql<
    {
      code: string;
      kind: string;
      title: string;
      hypothesis: string | null;
    }[]
  >`
    SELECT a.code, a.kind, a.title, a.hypothesis
      FROM activity a
      JOIN claim    c ON c.id = a.claim_id
     WHERE c.subject_tenant_id = ${subject_tenant_id}
       AND a.tenant_id         = ${tenant_id}
       AND c.stage NOT IN ('submitted', 'audit_defence')
     ORDER BY c.fiscal_year DESC, a.code ASC
     LIMIT 50
  `;

  // Step 5: run analyzer.
  let analyzerResult;
  try {
    analyzerResult = await getAnalyzer().analyze({
      filename: filename || 'document',
      mime_type: mimeType || 'application/octet-stream',
      raw_text: extractedText,
      existing_activities: activities.map((a) => ({
        code: a.code,
        kind: a.kind as 'core' | 'supporting',
        title: a.title,
        hypothesis: a.hypothesis,
      })),
    });
  } catch (err) {
    const analyzerErrPayload: Record<string, unknown> = {
      error: 'analyzer_error',
      reason: err instanceof Error ? err.message : String(err),
    };
    await privilegedSql`
      UPDATE event
         SET extraction_status  = 'failed',
             extracted_content  = ${privilegedSql.json(analyzerErrPayload as Record<string, never>)}
       WHERE id = ${event_id}
    `;
    return;
  }

  const result = analyzerResult.output;

  // Step 5b: ledger the token usage. Extraction runs BEFORE evidence is
  // bound to a specific claim (claim_id is not in the job payload), so
  // we record with claim_id=null — these calls bill against the tenant's
  // global pool, not any one claim's A$50 envelope. The ledger row is
  // forensic-grade regardless; if we later decide to associate extraction
  // costs to a specific claim, we can do so by joining via subject_tenant_id.
  if (analyzerResult.usage) {
    await recordUsage(privilegedSql as unknown as TaggedSql, {
      tenant_id,
      claim_id: null,
      subject_tenant_id,
      agent_name: 'document-analyzer',
      model: analyzerResult.usage.model,
      tokens_in: analyzerResult.usage.tokens_in,
      tokens_out: analyzerResult.usage.tokens_out,
    });
  }

  // Step 6: persist result.
  await privilegedSql`
    UPDATE event
       SET extraction_status  = 'complete',
           extracted_content  = ${privilegedSql.json(result)}
     WHERE id = ${event_id}
  `;

  // Emit EXTRACTION_COMPLETED chain event (metadata-only; does not break the
  // append-only chain invariant because we are emitting a NEW event, not
  // mutating an existing one).
  // Using privilegedSql here because the worker has no session/tenant GUC.
  // We emit directly rather than via insertEventWithChain to keep the worker
  // simple and avoid the advisory-lock overhead for a metadata event.
  try {
    // Look up the prev_hash for this subject_tenant for the new chain link.
    const prevRows = await privilegedSql<{ hash: string }[]>`
      SELECT hash
        FROM event
       WHERE subject_tenant_id = ${subject_tenant_id}
         AND tenant_id         = ${tenant_id}
       ORDER BY captured_at DESC, received_at DESC
       LIMIT 1
    `;
    const prevHash = prevRows[0]?.hash ?? null;

    // Find the system user or the user who uploaded the file.
    const uploadedByRows = await privilegedSql<{ captured_by_user_id: string }[]>`
      SELECT captured_by_user_id FROM event WHERE id = ${event_id}
    `;
    const capturedByUserId = uploadedByRows[0]?.captured_by_user_id;
    if (!capturedByUserId) return;

    const newId = crypto.randomUUID();
    const hashInput = JSON.stringify({
      id: newId,
      subject_tenant_id,
      kind: 'EXTRACTION_COMPLETED',
      event_id,
      prev_hash: prevHash,
    });
    const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(hashInput));
    const hash = Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    const completedPayload: Record<string, unknown> = {
      _v: 1,
      source: 'extraction_completed',
      source_event_id: event_id,
      activity_count: result.activities.length,
      invoice_count: result.invoices.length,
      document_summary: result.document_summary,
    };
    await privilegedSql`
      INSERT INTO event (
        id, tenant_id, subject_tenant_id, kind, payload,
        classification, prev_hash, hash, idempotency_key,
        captured_at, received_at, captured_by_user_id
      ) VALUES (
        ${newId}::uuid,
        ${tenant_id}::uuid,
        ${subject_tenant_id}::uuid,
        'SUPPORTING',
        ${privilegedSql.json(completedPayload as Record<string, never>)},
        NULL,
        ${prevHash},
        ${hash},
        NULL,
        NOW(),
        NOW(),
        ${capturedByUserId}::uuid
      )
      ON CONFLICT DO NOTHING
    `;
  } catch {
    // Chain event emission failure is non-fatal for extraction — the
    // extracted_content is already persisted. Log and continue.
    console.warn(`[document-extract] chain event emit failed for event ${event_id}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a file-upload raw_text payload into its constituent parts.
 *
 * The raw_text format is:
 *   [FILE UPLOAD] filename.docx
 *   Type: application/...
 *   Size: 123.4 KB
 *   SHA-256: abc123...
 *   Description: optional note
 *   Extracted-Text:
 *   <actual document text>
 */
function parseFileUploadPayload(rawText: string): {
  filename: string;
  mimeType: string;
  extractedText: string | null;
} {
  const lines = rawText.split('\n');
  const firstLine = lines[0] ?? '';
  const filename = firstLine.startsWith('[FILE UPLOAD] ')
    ? firstLine.slice('[FILE UPLOAD] '.length).trim()
    : '';

  let mimeType = 'application/octet-stream';
  let extractedTextStartIdx = -1;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.startsWith('Type: ')) {
      mimeType = line.slice('Type: '.length).trim();
    } else if (line.startsWith('Extracted-Text:')) {
      extractedTextStartIdx = i + 1;
      break;
    }
  }

  const extractedText =
    extractedTextStartIdx >= 0 ? lines.slice(extractedTextStartIdx).join('\n').trim() : null;

  return { filename, mimeType, extractedText };
}
