/**
 * GET /v1/claims/:id/prepared
 *
 * Returns the AI-prepared content for each of the wizard's 6 steps so the
 * consultant approve-wizard can show REAL content per step instead of the
 * "awaiting AI preparation" placeholder.
 *
 * Per docs/product/workflow.md (LOCKED): "Prepare claim" kicks off an AI
 * pipeline that AUTHORS the claim; the consultant then APPROVES it step by
 * step. The per-step approval state machine lives in
 * `routes/claim-workflow.ts` (GET /v1/claims/:id/workflow). This endpoint
 * is the missing READ surface for the AI-authored artefacts the consultant
 * judges:
 *
 *   step1_hypotheses     — hypotheses + their IP / prior-art verdicts
 *   step2_activities     — proposed Core / Supporting activities (Div 355)
 *   step3_apportionment  — ledger lines mapped to activities + $ totals
 *   step4_evidence       — artefacts bound to each activity
 *   step5_narrative      — drafted narrative segments w/ citations
 *   step6_review         — summary roll-up
 *
 * Each step carries a `prepared` flag (false + empty arrays when nothing
 * has been generated yet — the route NEVER fabricates content). See
 * `lib/prepared-content.ts` for the per-step data sources.
 *
 * All reads run inside `sql.begin` + `set_config('app.current_tenant_id')`
 * so the RLS policies attach; queries also carry explicit `tenant_id`
 * predicates (defence in depth). Auth: requireSession, role ∈
 * {admin, consultant} (viewers may read — same as the workflow GET? — no:
 * we mirror the workflow route's admin/consultant gate so the consultant
 * surface stays consistent).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireSession } from '@cpa/auth';
import { sql } from '@cpa/db/client';
import { loadPreparedContent, type PreparedContent } from '../lib/prepared-content.js';
import type { SqlClient } from '../lib/workflow.js';

const Uuid = z.string().uuid();

export function registerClaimPrepared(app: FastifyInstance): void {
  app.get<{ Params: { id: string } }>(
    '/v1/claims/:id/prepared',
    { preHandler: requireSession },
    async (req, reply) => {
      const role = req.user!.role;
      if (role !== 'admin' && role !== 'consultant') {
        return reply.status(403).send({
          error: 'forbidden',
          message: 'Admin or consultant role required',
          requestId: req.id,
        });
      }
      const tenantId = req.user!.tenantId!;
      const claimId = req.params.id;
      if (!Uuid.safeParse(claimId).success) {
        return reply.status(400).send({
          error: 'invalid_claim_id',
          message: 'claim id must be a uuid',
          requestId: req.id,
        });
      }

      type GetResult = { kind: 'not_found' } | { kind: 'ok'; prepared: PreparedContent };

      const result: GetResult = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        // Resolve the claim's subject_tenant — needed to scope unmapped
        // expenditures that haven't been bound to the claim row yet. A 404
        // here matches the workflow / budget routes' ergonomics.
        const claimRows = await tx<{ subject_tenant_id: string }[]>`
          SELECT subject_tenant_id::text AS subject_tenant_id
            FROM claim
           WHERE id = ${claimId} AND tenant_id = ${tenantId}
           LIMIT 1
        `;
        const claim = claimRows[0];
        if (!claim) return { kind: 'not_found' };

        // postgres-js's TransactionSql carries a helper overload that clashes
        // with the narrow SqlClient structural type — cast through unknown,
        // same as the workflow route does for loadWorkflowSnapshot.
        const prepared = await loadPreparedContent(
          tx as unknown as SqlClient,
          tenantId,
          claimId,
          claim.subject_tenant_id,
        );
        return { kind: 'ok', prepared };
      });

      if (result.kind === 'not_found') {
        return reply.status(404).send({
          error: 'claim_not_found',
          message: 'No claim with that id in this firm',
          requestId: req.id,
        });
      }

      return reply.status(200).send({ prepared: result.prepared });
    },
  );
}
