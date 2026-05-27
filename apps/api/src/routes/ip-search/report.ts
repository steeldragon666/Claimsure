import type { FastifyInstance } from 'fastify';
import { requireSession } from '@cpa/auth';
import { sql } from '@cpa/db/client';
import { getBoss } from '../../lib/pg-boss-client.js';
import {
  IP_SEARCH_REPORT_RENDER_PDF_QUEUE,
  runIpSearchReportRenderPdfJob,
  type IpSearchReportRenderPdfJobInput,
} from '../../jobs/ip-search-report-render-pdf.js';

/**
 * POST /v1/claims/:id/ip-search/report/generate
 *
 * Enqueues the IP-search verdict report PDF job for the given claim.
 *
 * - Session-required (admin/consultant; viewers cannot trigger).
 * - Cross-tenant: the claim lookup is RLS-scoped, so a caller from
 *   firm B asking for firm A's claim sees a 404 (no leakage).
 * - In `NODE_ENV=test` the job runs synchronously inline so the API
 *   `app.inject()` tests don't need a live pg-boss instance. In
 *   production, the body returns `{ enqueued: true }` and the worker
 *   picks it up off the IP_SEARCH_REPORT_RENDER_PDF_QUEUE queue.
 */
export function registerIpSearchReportRoute(app: FastifyInstance): void {
  app.post<{ Params: { id: string } }>(
    '/v1/claims/:id/ip-search/report/generate',
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

      const claimId = req.params.id;
      const tenantId = req.user!.tenantId!;

      // Confirm the claim is visible to the caller's firm before
      // enqueueing — otherwise we'd leak claim ids by triggering work
      // for a foreign tenant.
      const exists = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<{ id: string }[]>`
          SELECT id FROM claim
           WHERE id = ${claimId}
             AND tenant_id = ${tenantId}
           LIMIT 1
        `;
        return rows[0] ?? null;
      });
      if (!exists) {
        return reply.status(404).send({
          error: 'claim_not_found',
          message: 'No claim with that id in this firm',
          requestId: req.id,
        });
      }

      const payload: IpSearchReportRenderPdfJobInput = { claim_id: claimId };

      if (process.env['NODE_ENV'] === 'test') {
        // Synchronous path: tests assert immediately on the job result.
        const result = await runIpSearchReportRenderPdfJob(payload);
        return reply.status(202).send({ enqueued: true, inline: true, result });
      }

      const boss = await getBoss();
      const jobId = await boss.send(IP_SEARCH_REPORT_RENDER_PDF_QUEUE, payload);
      return reply.status(202).send({ enqueued: true, job_id: jobId });
    },
  );
}
