/**
 * Pipeline status endpoint — surfaces what the async agent pipeline is doing
 * for a subject_tenant so the wizard can render a "what's happening" banner.
 *
 * Without this, users see a green upload checkmark and then silence while
 * Haiku (extraction + classification) and Sonnet (synthesis + narrative)
 * run in the background. They had no way to know if the pipeline was
 * working, stuck, or failed. The wizard step 2 panel only renders proposals
 * AFTER everything is done, leading to a "Rubik's cube" experience.
 *
 * THIS ENDPOINT IS A READ-ONLY DERIVATION from event + pgboss.job state. It
 * stores nothing. It just answers: "right now, for this claimant, what's
 * happening + how many items remain + what does the next phase look like?"
 *
 *   GET /v1/subject-tenants/:id/pipeline-status
 *
 * Auth: requireSession. RLS: enforced via tenant_id predicate (same pattern
 * as other read endpoints).
 *
 * Polling: the wizard should hit this every 3-5 seconds while a phase is
 * active. Returns 200 with a discriminator + counts; the frontend maps the
 * discriminator to prose via lib/pipeline-phases.ts.
 */
import type { FastifyInstance } from 'fastify';
import { requireSession } from '@cpa/auth';
import { sql } from '@cpa/db/client';

type PipelinePhase =
  | 'idle'
  | 'extracting'
  | 'extraction_complete'
  | 'narrative_pending'
  | 'narrative_approved'
  | 'generating_application';

interface PipelineStatusResponse {
  phase: PipelinePhase;
  counts: {
    total_evidence_events: number;
    extraction_pending: number;
    extraction_complete: number;
    extraction_failed: number;
    with_activity_proposals: number;
    activity_proposals_total: number;
    invoice_proposals_total: number;
  };
  narrative: {
    last_approval_at: string | null;
  };
  eta_items: number;
  updated_at: string;
}

export function registerPipelineStatus(app: FastifyInstance): void {
  app.get<{ Params: { id: string } }>(
    '/v1/subject-tenants/:id/pipeline-status',
    { preHandler: requireSession },
    async (req, reply) => {
      const subjectTenantId = req.params.id;
      const tenantId = req.user!.tenantId!;

      // Verify subject_tenant exists in this tenant. Pattern matches the
      // pending-narrative endpoint — same RLS approach.
      const stRow = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<{ id: string }[]>`
          SELECT id
            FROM subject_tenant
           WHERE id        = ${subjectTenantId}
             AND tenant_id = ${tenantId}
           LIMIT 1
        `;
        return rows[0] ?? null;
      });
      if (!stRow) {
        return reply.status(404).send({
          error: 'subject_tenant_not_found',
          message: 'No subject tenant with that id in this firm',
          requestId: req.id,
        });
      }

      // Derive counts + last-approval timestamp in a single transaction so the
      // numbers are mutually consistent.
      const result = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;

        const counts = await tx<
          {
            total: string;
            pending: string;
            complete: string;
            failed: string;
            with_proposals: string;
            activity_proposals: string;
            invoice_proposals: string;
          }[]
        >`
          SELECT
            COUNT(*) FILTER (WHERE extraction_status IS NOT NULL)::text AS total,
            COUNT(*) FILTER (WHERE extraction_status = 'pending')::text  AS pending,
            COUNT(*) FILTER (WHERE extraction_status = 'complete')::text AS complete,
            COUNT(*) FILTER (WHERE extraction_status = 'failed')::text   AS failed,
            COUNT(*) FILTER (
              WHERE extraction_status = 'complete'
                AND jsonb_array_length(COALESCE(extracted_content -> 'activities', '[]'::jsonb)) > 0
            )::text AS with_proposals,
            COALESCE(SUM(jsonb_array_length(COALESCE(extracted_content -> 'activities', '[]'::jsonb))), 0)::text AS activity_proposals,
            COALESCE(SUM(jsonb_array_length(COALESCE(extracted_content -> 'invoices', '[]'::jsonb))), 0)::text   AS invoice_proposals
          FROM event
          WHERE tenant_id         = ${tenantId}
            AND subject_tenant_id = ${subjectTenantId}
        `;

        const approval = await tx<{ captured_at: Date | string }[]>`
          SELECT captured_at
            FROM event
           WHERE tenant_id         = ${tenantId}
             AND subject_tenant_id = ${subjectTenantId}
             AND kind              = 'NARRATIVE_APPROVED'
           ORDER BY captured_at DESC
           LIMIT 1
        `;

        return { counts: counts[0]!, approval: approval[0] ?? null };
      });

      // Parse string bigints to numbers (Postgres returns COUNT/SUM as bigint
      // which postgres-js serialises as string for safety).
      const c = result.counts;
      const total = parseInt(c.total, 10);
      const pending = parseInt(c.pending, 10);
      const complete = parseInt(c.complete, 10);
      const failed = parseInt(c.failed, 10);
      const withProposals = parseInt(c.with_proposals, 10);
      const activityProposals = parseInt(c.activity_proposals, 10);
      const invoiceProposals = parseInt(c.invoice_proposals, 10);

      const lastApprovalAt = result.approval?.captured_at
        ? typeof result.approval.captured_at === 'string'
          ? result.approval.captured_at
          : result.approval.captured_at.toISOString()
        : null;

      // Phase derivation. The order of these branches matters — they are
      // checked from "still working" to "all done".
      let phase: PipelinePhase;
      let etaItems: number;
      if (pending > 0) {
        phase = 'extracting';
        etaItems = pending;
      } else if (total === 0) {
        phase = 'idle';
        etaItems = 0;
      } else if (lastApprovalAt) {
        // The most recent NARRATIVE_APPROVED is older than the latest
        // upload? Then we're in a re-narrative cycle and still pending.
        // Simple heuristic: if the user has uploaded MORE evidence since
        // the last approval, we're back in extraction_complete / pending.
        // For now: if approval exists AND no new pending docs, we're done.
        phase = 'narrative_approved';
        etaItems = 0;
      } else if (withProposals > 0) {
        // Extraction done, some proposals exist — narrative panel will
        // pop up on next pending-narrative call.
        phase = 'narrative_pending';
        etaItems = 0;
      } else if (complete > 0) {
        // Extraction done but no proposals — either docs were summaries
        // (low signal) or the analyzer failed silently. Surface as
        // extraction_complete so the user sees something happened.
        phase = 'extraction_complete';
        etaItems = 0;
      } else {
        phase = 'idle';
        etaItems = 0;
      }

      const resp: PipelineStatusResponse = {
        phase,
        counts: {
          total_evidence_events: total,
          extraction_pending: pending,
          extraction_complete: complete,
          extraction_failed: failed,
          with_activity_proposals: withProposals,
          activity_proposals_total: activityProposals,
          invoice_proposals_total: invoiceProposals,
        },
        narrative: { last_approval_at: lastApprovalAt },
        eta_items: etaItems,
        updated_at: new Date().toISOString(),
      };

      return reply.status(200).send(resp);
    },
  );
}
