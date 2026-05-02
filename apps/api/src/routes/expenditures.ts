import type { FastifyInstance } from 'fastify';
import { requireSession } from '@cpa/auth';
import { sql } from '@cpa/db/client';
import { isAgentEnabled, isTenantAllowed } from '@cpa/agents';
import { enqueueExpenditureClassify } from '../lib/enqueue-classify.js';

/**
 * Expenditure routes (Task 3.5 — manual reclassify endpoint).
 *
 * Today this file owns one route:
 *
 *   POST /v1/expenditures/:id/reclassify  — admin / consultant
 *
 * Other expenditure-related verbs already live elsewhere by P5
 * convention:
 *   - `POST /v1/expenditures/:id/apply-rules`  →  routes/apply-rules.ts
 *   - Xero-driven INSERTs                      →  jobs/xero-accounting-sync.ts
 *     (the manual-create POST anticipated by Task 3.4 does not yet exist
 *     in P5 — the only insert path is the Xero sync).
 *
 * **202 Accepted, not 200.** The handler does NOT block on the
 * classifier. It enqueues a job via `enqueueExpenditureClassify` (which
 * today runs the handler inline; tomorrow swaps to `pgBoss.send`) and
 * returns immediately with a `requestId` correlation handle. Match the
 * existing 202 convention from `POST /v1/employees/.../send-magic-link`
 * (employees.ts) — the only other accepted-but-not-yet-completed
 * mutation in the API today.
 *
 * **503 when feature flag disabled.** When `P6_AGENT_A_ENABLED=false`
 * (or the tenant is outside the allowlist), we surface a 503 rather
 * than silently 202'ing on a no-op. Callers should treat the agent as a
 * platform service that may be off; a 503 lets the consultant UI render
 * a "classifier temporarily unavailable" banner instead of pretending
 * the job is in flight.
 *
 * **Why not a /v1/expenditures resource POST too?** The Task 3.4 spec
 * names a "manual-create POST handler" but no such route exists in the
 * P5 codebase — expenditures only enter the system via the Xero sync.
 * If a manual-create endpoint lands later (e.g. for ad-hoc consultant
 * data entry), it should also call `enqueueExpenditureClassify` after
 * its `EXPENDITURE_INGESTED` insert; the shim is the single seam.
 */
export function registerExpenditures(app: FastifyInstance): void {
  app.post<{ Params: { id: string } }>(
    '/v1/expenditures/:id/reclassify',
    { preHandler: requireSession },
    async (req, reply) => {
      // ---------------------------------------------------------------
      // Step 1 — role gate. Admin / consultant only. Viewer 403s.
      // Matches the convention in apply-rules.ts and claims.ts.
      // ---------------------------------------------------------------
      const role = req.user!.role;
      if (role !== 'admin' && role !== 'consultant') {
        return reply.status(403).send({
          error: 'forbidden',
          message: 'Admin or consultant role required',
          requestId: req.id,
        });
      }

      const { id } = req.params;
      const tenantId = req.user!.tenantId!;

      // ---------------------------------------------------------------
      // Step 2 — feature-flag + allowlist gate. Prefer 503 over silent
      // no-op. We check the gates BEFORE the existence lookup so a
      // disabled-tenant consultant doesn't get a 404-vs-503 oracle that
      // could leak existence; the lookup runs only after this gate
      // passes. (RLS would also prevent cross-firm leak, but defense-
      // in-depth is cheap here.)
      // ---------------------------------------------------------------
      if (!isAgentEnabled('A') || !isTenantAllowed(tenantId)) {
        return reply.status(503).send({
          error: 'agent_disabled',
          message: 'The expenditure classifier (Agent A) is not available for this caller',
          requestId: req.id,
        });
      }

      // ---------------------------------------------------------------
      // Step 3 — existence + cross-firm guard. RLS scopes the SELECT to
      // the caller's tenant; a row in a different firm comes back as 0
      // rows here, producing a 404 (not 403). This matches apply-rules
      // and other expenditure-id'd routes.
      // ---------------------------------------------------------------
      const expenditureExists = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<{ id: string }[]>`
          SELECT id FROM expenditure
           WHERE id = ${id} AND tenant_id = ${tenantId}
        `;
        return rows[0] != null;
      });
      if (!expenditureExists) {
        return reply.status(404).send({
          error: 'expenditure_not_found',
          message: 'No expenditure with that id in this firm',
          requestId: req.id,
        });
      }

      // ---------------------------------------------------------------
      // Step 4 — enqueue and return 202. Fire-and-forget per the shim's
      // contract; tests can `await app.inject(...)` and then poll for
      // the EXPENDITURE_CLASSIFIED event since the inline-handler
      // implementation has finished writing the chain row by the time
      // the next tick runs (best-effort, but sufficient for our test
      // patterns — see expenditures.test.ts for the deterministic
      // path that awaits the shim explicitly).
      // ---------------------------------------------------------------
      void enqueueExpenditureClassify({
        tenant_id: tenantId,
        expenditure_ids: [id],
      }).catch(() => {
        // Errors are logged inside the shim. The 202 has already gone
        // back to the caller; nothing useful to do here besides
        // suppress the unhandled-rejection warning.
      });

      return reply.status(202).send({ requestId: req.id });
    },
  );
}
