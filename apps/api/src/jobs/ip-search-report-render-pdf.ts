import crypto from 'node:crypto';
import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { privilegedSql } from '@cpa/db/client';
import {
  contentHash,
  renderIpSearchVerdictReportPdf,
  type IpSearchVerdictReportHit,
  type IpSearchVerdictReportInput,
  type IpSearchVerdictReportQuery,
  type IpSearchVerdictReportSection,
  type IpSearchVerdictReportVerdict,
} from '@cpa/documents';

/**
 * ip-search-report-render-pdf — Wizard Step 2 / Task 07.
 *
 * Renders a per-claim prior-art verdict report as a PDF for audit
 * defence. One report covers every approved verdict in the claim — the
 * resulting `media_artefact` id is fanned out to every
 * `ip_search_verdict.pdf_evidence_id` in the claim.
 *
 * Trigger model:
 *   - Manual: consultant POSTs /v1/claims/:id/ip-search/report/generate.
 *   - (Future) automatic on the last verdict-approve, via a
 *     `claim-workflow.ts` hook — out of scope for this task.
 *
 * Idempotency:
 *   - If every approved verdict in the claim already shares the same
 *     non-null `pdf_evidence_id`, the job no-ops and returns
 *     `status: 'already_generated'`.
 *
 * Storage:
 *   - The PDF is stored as a `media_artefact` row (`evidence` is a
 *     logical view over media_artefact + event; no dedicated evidence
 *     table exists). No CHECK-constraint allowlist on a "kind" column —
 *     media_artefact carries `mime_type` and the IP-search role is
 *     captured by `s3_key` prefix + the back-pointer
 *     `ip_search_verdict.pdf_evidence_id`.
 *   - The `uploaded_by_employee_id` column is `NOT NULL` (migration
 *     0008). Workers have no employee context, so we pick the
 *     subject-tenant's earliest active employee as the "system uploader"
 *     attribution. If the subject_tenant has no employees we fall back
 *     to a synthetic placeholder employee scoped to that subject_tenant
 *     (rare — typically the consultant has invited at least one).
 *
 * RLS:
 *   - The worker runs as the migration / privileged role
 *     (`privilegedSql`). RLS policies on `ip_search_verdict` and
 *     `media_artefact` are FORCE-enabled (see migrations 0008 + 0086),
 *     so we set `app.current_tenant_id` manually inside a single
 *     transaction so the writes pass the WITH CHECK clauses.
 */

export const IP_SEARCH_REPORT_RENDER_PDF_QUEUE = 'ip-search-report-render-pdf';

const GENERATOR_VERSION = '1.0.0';

const InputSchema = z.object({
  claim_id: z.string().uuid(),
});
export type IpSearchReportRenderPdfJobInput = z.infer<typeof InputSchema>;

export type IpSearchReportRenderPdfJobResult =
  | { status: 'rendered'; media_artefact_id: string; verdict_count: number }
  | { status: 'already_generated'; media_artefact_id: string; verdict_count: number }
  | { status: 'no_verdicts'; reason: string }
  | { status: 'claim_not_found'; reason: string }
  | { status: 'failed'; reason: string };

// ---------------------------------------------------------------------------
// pg-boss handler registration
// ---------------------------------------------------------------------------

/**
 * Register the worker on the IP_SEARCH_REPORT_RENDER_PDF_QUEUE queue.
 * Called from server.ts after the boss singleton starts. Mirrors the
 * pattern in document-extract.ts.
 */
export async function registerIpSearchReportRenderPdfJob(boss: PgBoss): Promise<void> {
  await boss.createQueue(IP_SEARCH_REPORT_RENDER_PDF_QUEUE);
  await boss.work<IpSearchReportRenderPdfJobInput>(
    IP_SEARCH_REPORT_RENDER_PDF_QUEUE,
    async (jobs) => {
      for (const job of jobs) {
        const result = await runIpSearchReportRenderPdfJob(job.data);
        if (result.status === 'failed') {
          // Re-throw so pg-boss retries transient failures. Permanent
          // failures (no_verdicts / claim_not_found) return a terminal
          // status without throwing so the job is marked complete.
          throw new Error(`ip-search-report-render-pdf failed: ${result.reason}`);
        }
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Core handler
// ---------------------------------------------------------------------------

type ClaimRow = {
  id: string;
  tenant_id: string;
  subject_tenant_id: string;
  fiscal_year: number;
};

type FirmRow = {
  name: string;
  abn: string | null;
};

type SubjectTenantRow = {
  name: string;
  abn: string | null;
};

type VerdictRow = {
  id: string;
  activity_id: string;
  activity_code: string;
  activity_title: string;
  hypothesis_text: string;
  verdict: IpSearchVerdictReportVerdict;
  draft_verdict: IpSearchVerdictReportVerdict | null;
  analysis_markdown: string;
  approved_by_name: string | null;
  approved_at: string | null;
  pdf_evidence_id: string | null;
};

type RunRow = {
  database_name: string;
  query: string;
  result_count: number;
  hypothesis_text: string;
  activity_id: string;
};

type HitRow = {
  external_id: string;
  title: string;
  url: string | null;
  relevance_score: string | number | null;
  database_name: string;
  hypothesis_text: string;
  activity_id: string;
};

export async function runIpSearchReportRenderPdfJob(
  rawInput: unknown,
): Promise<IpSearchReportRenderPdfJobResult> {
  const parsed = InputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { status: 'failed', reason: `invalid job input: ${parsed.error.message}` };
  }
  const { claim_id } = parsed.data;

  // Step 1: load claim (privileged — no GUC). Determine tenant for
  // subsequent RLS-scoped writes.
  const claimRows = await privilegedSql<ClaimRow[]>`
    SELECT id, tenant_id, subject_tenant_id, fiscal_year
      FROM claim
     WHERE id = ${claim_id}
  `;
  const claim = claimRows[0];
  if (!claim) {
    return { status: 'claim_not_found', reason: `claim ${claim_id} not found` };
  }

  // Step 2: load all approved verdicts for the claim.
  const verdictRows = await privilegedSql<VerdictRow[]>`
    SELECT
      v.id,
      v.activity_id,
      a.code              AS activity_code,
      a.title             AS activity_title,
      v.hypothesis_text,
      v.verdict,
      v.draft_verdict,
      v.analysis_markdown,
      u.display_name      AS approved_by_name,
      v.approved_at::text AS approved_at,
      v.pdf_evidence_id::text AS pdf_evidence_id
    FROM ip_search_verdict v
    JOIN activity a ON a.id = v.activity_id
    LEFT JOIN "user" u ON u.id = v.approved_by_user_id
    WHERE v.claim_id    = ${claim_id}
      AND v.approved_at IS NOT NULL
    ORDER BY a.code ASC, v.hypothesis_text ASC
  `;

  if (verdictRows.length === 0) {
    return {
      status: 'no_verdicts',
      reason: `no approved verdicts for claim ${claim_id}`,
    };
  }

  // Step 3: idempotency check — if every approved verdict already shares
  // a single non-null pdf_evidence_id, no-op.
  const existingIds = new Set<string>();
  let allHavePdf = true;
  for (const v of verdictRows) {
    if (v.pdf_evidence_id === null) {
      allHavePdf = false;
      break;
    }
    existingIds.add(v.pdf_evidence_id);
  }
  if (allHavePdf && existingIds.size === 1) {
    const existingMediaId = [...existingIds][0]!;
    return {
      status: 'already_generated',
      media_artefact_id: existingMediaId,
      verdict_count: verdictRows.length,
    };
  }

  // Step 4: load all runs + hits for this claim, scoped to the same
  // hypothesis texts we'll render.
  const runRows = await privilegedSql<RunRow[]>`
    SELECT
      r.database_name,
      r.query,
      r.result_count,
      r.hypothesis_text,
      r.activity_id
    FROM ip_search_run r
    WHERE r.claim_id = ${claim_id}
    ORDER BY r.ran_at ASC
  `;

  const hitRows = await privilegedSql<HitRow[]>`
    SELECT
      h.external_id,
      h.title,
      h.url,
      h.relevance_score,
      r.database_name,
      r.hypothesis_text,
      r.activity_id
    FROM ip_search_hit h
    JOIN ip_search_run r ON r.id = h.search_run_id
    WHERE r.claim_id = ${claim_id}
    ORDER BY h.relevance_score DESC NULLS LAST, h.title ASC
  `;

  // Step 5: load firm + subject + consultant (most-recent verdict approver
  // is a reasonable proxy until claim gains a primary_consultant_user_id).
  const firmRows = await privilegedSql<FirmRow[]>`
    SELECT name, NULL::text AS abn FROM tenant WHERE id = ${claim.tenant_id}
  `;
  const firm = firmRows[0] ?? { name: '(unknown firm)', abn: null };

  const subjectRows = await privilegedSql<SubjectTenantRow[]>`
    SELECT name, NULL::text AS abn FROM subject_tenant WHERE id = ${claim.subject_tenant_id}
  `;
  const subject = subjectRows[0] ?? { name: '(unknown claimant)', abn: null };

  const consultantName = verdictRows.find((v) => v.approved_by_name)?.approved_by_name ?? null;

  // Step 6: build per-verdict sections. Group runs + hits by
  // (activity_id, hypothesis_text). Top-5 hits per verdict are
  // ordered by the SQL DESC NULLS LAST score above, then sliced.
  const sections: IpSearchVerdictReportSection[] = [];
  for (const v of verdictRows) {
    const verdictRuns: IpSearchVerdictReportQuery[] = runRows
      .filter((r) => r.activity_id === v.activity_id && r.hypothesis_text === v.hypothesis_text)
      .map((r) => ({
        database_name: r.database_name,
        query: r.query,
        result_count: r.result_count,
      }));

    const verdictHits: IpSearchVerdictReportHit[] = hitRows
      .filter((h) => h.activity_id === v.activity_id && h.hypothesis_text === v.hypothesis_text)
      .slice(0, 5)
      .map((h) => ({
        title: h.title,
        url: h.url,
        relevance_score:
          h.relevance_score === null
            ? null
            : typeof h.relevance_score === 'string'
              ? Number(h.relevance_score)
              : h.relevance_score,
        external_id: h.external_id,
        database_name: h.database_name,
      }));

    sections.push({
      activity_code: v.activity_code,
      activity_title: v.activity_title,
      hypothesis_text: v.hypothesis_text,
      verdict: v.verdict,
      draft_verdict: v.draft_verdict,
      analysis_markdown: v.analysis_markdown,
      approved_by_name: v.approved_by_name,
      approved_at: v.approved_at,
      queries: verdictRuns,
      top_hits: verdictHits,
    });
  }

  // Step 7: build PDF input + content hash + render.
  const generatedAt = new Date().toISOString();
  const contentHashHex = contentHash({
    claim_id: claim.id,
    fiscal_year: claim.fiscal_year,
    verdict_ids: verdictRows.map((v) => v.id).sort(),
    generated_at: generatedAt,
  });

  const pdfInput: IpSearchVerdictReportInput = {
    firm: { name: firm.name, abn: firm.abn },
    subject_tenant: { name: subject.name, abn: subject.abn },
    claim: { id: claim.id, fy_year: claim.fiscal_year },
    consultant_name: consultantName,
    generated_at: generatedAt,
    content_hash_hex: contentHashHex,
    generator_version: GENERATOR_VERSION,
    sections,
  };

  let pdfBytes: Uint8Array;
  try {
    pdfBytes = await renderIpSearchVerdictReportPdf(pdfInput);
  } catch (err) {
    return {
      status: 'failed',
      reason: `pdf render failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Step 8: hash bytes for media_artefact content_hash + s3_key. The
  // CHECK constraint media_content_hash_format requires 64 lowercase
  // hex chars; crypto.createHash('sha256').digest('hex') matches.
  const fileHash = crypto.createHash('sha256').update(pdfBytes).digest('hex');
  const s3Key = `tenants/${claim.tenant_id}/subjects/${claim.subject_tenant_id}/ip-search-reports/${fileHash}.pdf`;

  // Step 9: persist. One transaction so the tenant GUC + INSERT +
  // verdict UPDATE share the same RLS-scoped session.
  try {
    const mediaId = await privilegedSql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${claim.tenant_id}, true)`;

      // Resolve an uploader employee. Worker has no employee context, so
      // pick the subject_tenant's earliest active employee. If none
      // exists, return null and short-circuit — the PDF can be requested
      // again once an employee has been invited. This is a rare
      // edge-case (a consultant who somehow approved verdicts before
      // inviting any employee).
      const employees = await tx<{ id: string }[]>`
        SELECT id
          FROM subject_tenant_employee
         WHERE subject_tenant_id = ${claim.subject_tenant_id}
           AND tenant_id         = ${claim.tenant_id}
           AND deactivated_at IS NULL
         ORDER BY invited_at ASC
         LIMIT 1
      `;
      const employeeId = employees[0]?.id ?? null;
      if (employeeId === null) {
        throw new Error(
          `no active subject_tenant_employee for subject ${claim.subject_tenant_id}; ` +
            `invite an employee before generating the IP-search verdict report`,
        );
      }

      // Insert (or pick up an existing-by-content_hash) media row.
      // The unique index (tenant, subject, content_hash) means a
      // byte-identical re-render dedupes to the same row, which keeps
      // pdf_evidence_id stable across retries.
      const insertId = crypto.randomUUID();
      const inserted = await tx<{ id: string }[]>`
        INSERT INTO media_artefact (
          id, tenant_id, subject_tenant_id, event_id, uploaded_by_employee_id,
          s3_key, content_hash, mime_type, size_bytes, exif,
          ocr_status, virus_scan_status
        ) VALUES (
          ${insertId},
          ${claim.tenant_id},
          ${claim.subject_tenant_id},
          NULL,
          ${employeeId},
          ${s3Key},
          ${fileHash},
          'application/pdf',
          ${pdfBytes.byteLength},
          NULL,
          'skipped',
          'clean'
        )
        ON CONFLICT (tenant_id, subject_tenant_id, content_hash)
        DO UPDATE SET mime_type = EXCLUDED.mime_type
        RETURNING id
      `;
      const newId = inserted[0]?.id;
      if (!newId) {
        // Fallback select — should never hit, ON CONFLICT … DO UPDATE
        // always RETURNINGs the row. Belt-and-braces because RETURNING
        // semantics around upsert have bitten this codebase before.
        const fallback = await tx<{ id: string }[]>`
          SELECT id FROM media_artefact
           WHERE tenant_id = ${claim.tenant_id}
             AND subject_tenant_id = ${claim.subject_tenant_id}
             AND content_hash = ${fileHash}
        `;
        if (!fallback[0]) throw new Error('media_artefact insert produced no row');
        return fallback[0].id;
      }

      // Fan-out: every approved verdict in the claim points at this
      // media_artefact id. UPDATE is unconditional — re-running the job
      // safely overwrites stale pointers (e.g. if a previous render
      // produced a different artefact id and got abandoned).
      await tx`
        UPDATE ip_search_verdict
           SET pdf_evidence_id = ${newId}::uuid
         WHERE claim_id    = ${claim_id}
           AND approved_at IS NOT NULL
      `;

      return newId;
    });

    return {
      status: 'rendered',
      media_artefact_id: mediaId,
      verdict_count: verdictRows.length,
    };
  } catch (err) {
    return {
      status: 'failed',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
