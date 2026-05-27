import type { FastifyInstance } from 'fastify';
import { requireSession } from '@cpa/auth';
import { sql } from '@cpa/db/client';

/**
 * GET /v1/engagement/:id
 *
 * Session-required, RLS-scoped read for the consultant dashboard
 * view of an engagement letter. Returns the full row plus a derived
 * `current_step` that the consultant UI uses to show the letter's
 * position in the lifecycle.
 *
 * `current_step` is derived from the row's timestamps + the
 * `send_token_expires_at` clock:
 *   - signed_by_claimant_at + countersigned_at  → 'countersigned'
 *   - signed_by_claimant_at                     → 'signed'
 *   - declined_at                               → 'declined'
 *   - expired_at OR token past expiry           → 'expired'
 *   - sent_to_claimant_at                       → 'sent'
 *   - otherwise                                  → 'pending_send'
 *
 * Cross-tenant ids → 404 (RLS makes them invisible).
 *
 * `send_token` is intentionally NOT returned to the consultant —
 * that's the claimant's credential, and exposing it on this endpoint
 * would let a consultant impersonate the claimant by replaying the
 * token at /sign. The consultant can re-trigger send via the send
 * endpoint instead.
 */
type CurrentStep = 'pending_send' | 'sent' | 'signed' | 'countersigned' | 'declined' | 'expired';

interface GetResponse {
  id: string;
  tenantId: string;
  claimId: string;
  renderedMarkdown: string;
  templateVersion: string;
  sendTokenExpiresAt: string | null;
  createdAt: string;
  sentToClaimantAt: string | null;
  signedByClaimantAt: string | null;
  signedByClaimantName: string | null;
  signedByClaimantIp: string | null;
  signedByClaimantUa: string | null;
  countersignedByUserId: string | null;
  countersignedAt: string | null;
  pdfEvidenceId: string | null;
  declinedAt: string | null;
  declinedReason: string | null;
  expiredAt: string | null;
  currentStep: CurrentStep;
}

interface Row {
  id: string;
  tenant_id: string;
  claim_id: string;
  rendered_markdown: string;
  template_version: string;
  send_token_expires_at: Date | null;
  created_at: Date;
  sent_to_claimant_at: Date | null;
  signed_by_claimant_at: Date | null;
  signed_by_claimant_name: string | null;
  signed_by_claimant_ip: string | null;
  signed_by_claimant_ua: string | null;
  countersigned_by_user_id: string | null;
  countersigned_at: Date | null;
  pdf_evidence_id: string | null;
  declined_at: Date | null;
  declined_reason: string | null;
  expired_at: Date | null;
}

function deriveCurrentStep(row: Row): CurrentStep {
  if (row.declined_at !== null) return 'declined';
  if (row.countersigned_at !== null) return 'countersigned';
  if (row.signed_by_claimant_at !== null) return 'signed';
  if (row.expired_at !== null) return 'expired';
  if (row.send_token_expires_at !== null && row.send_token_expires_at.getTime() <= Date.now()) {
    return 'expired';
  }
  if (row.sent_to_claimant_at !== null) return 'sent';
  return 'pending_send';
}

export function registerEngagementGet(app: FastifyInstance): void {
  app.get<{ Params: { id: string } }>(
    '/v1/engagement/:id',
    { preHandler: requireSession },
    async (req, reply) => {
      const tenantId = req.user!.tenantId!;
      const engagementId = req.params.id;

      const rows = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        return tx<Row[]>`
          SELECT id::text,
                 tenant_id::text,
                 claim_id::text,
                 rendered_markdown,
                 template_version,
                 send_token_expires_at,
                 created_at,
                 sent_to_claimant_at,
                 signed_by_claimant_at,
                 signed_by_claimant_name,
                 signed_by_claimant_ip,
                 signed_by_claimant_ua,
                 countersigned_by_user_id::text,
                 countersigned_at,
                 pdf_evidence_id::text,
                 declined_at,
                 declined_reason,
                 expired_at
            FROM engagement_letter
           WHERE id = ${engagementId}
           LIMIT 1
        `;
      });

      const row = rows[0];
      if (!row) {
        return reply
          .status(404)
          .send({ error: 'not_found', message: 'engagement letter not found', requestId: req.id });
      }

      return reply.status(200).send({
        id: row.id,
        tenantId: row.tenant_id,
        claimId: row.claim_id,
        renderedMarkdown: row.rendered_markdown,
        templateVersion: row.template_version,
        sendTokenExpiresAt: row.send_token_expires_at?.toISOString() ?? null,
        createdAt: row.created_at.toISOString(),
        sentToClaimantAt: row.sent_to_claimant_at?.toISOString() ?? null,
        signedByClaimantAt: row.signed_by_claimant_at?.toISOString() ?? null,
        signedByClaimantName: row.signed_by_claimant_name,
        signedByClaimantIp: row.signed_by_claimant_ip,
        signedByClaimantUa: row.signed_by_claimant_ua,
        countersignedByUserId: row.countersigned_by_user_id,
        countersignedAt: row.countersigned_at?.toISOString() ?? null,
        pdfEvidenceId: row.pdf_evidence_id,
        declinedAt: row.declined_at?.toISOString() ?? null,
        declinedReason: row.declined_reason,
        expiredAt: row.expired_at?.toISOString() ?? null,
        currentStep: deriveCurrentStep(row),
      } satisfies GetResponse);
    },
  );
}
