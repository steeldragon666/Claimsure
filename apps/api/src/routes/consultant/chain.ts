import type { FastifyInstance } from 'fastify';
import { requireSession } from '@cpa/auth';
import { sql } from '@cpa/db/client';

/**
 * GET /v1/consultant/chain/recent?limit=<n>
 *
 * Recent audit-chain blocks for the caller's tenant, plus the current
 * chain head height. Drives the `ChainPanel` on the consultant
 * dashboard.
 *
 * ┌─ STATUS: WIRED, EMPTY ─────────────────────────────────────────────
 * │ The audit-chain ingestion layer is not yet implemented — there is
 * │ no `audit_chain_block` table in `packages/db` (verified across all
 * │ 84 migrations as of 2026-05-25). The endpoint is shaped to its
 * │ eventual contract but returns `{ blocks: [], height: 0 }` for now.
 * │
 * │ The dashboard's ChainPanel renders the "Chain quiet — no blocks
 * │ today" empty state in this case, which is honest.
 * │
 * │ When the chain table lands:
 * │   1. Replace the `blocks` literal below with the SELECT … FROM
 * │      audit_chain_block JOIN claim …  (tenant-scoped via RLS GUC).
 * │   2. Replace `height` with `SELECT MAX(height) FROM audit_chain_block`
 * │      scoped to the tenant via the same JOIN.
 * │   3. Drop this banner.
 * │ See `docs/plans/consultant-wiring/d3-chain-panel.md`.
 * └────────────────────────────────────────────────────────────────────
 *
 * RLS: uses regular `sql` (NOT `privilegedSql`) — endpoint runs
 * post-session so `app.current_tenant_id` GUC is set by the session
 * middleware. Pattern mirrored from `signals.ts` (D2).
 */

const DEFAULT_LIMIT = 4;
const MAX_LIMIT = 50;

export function registerConsultantChain(app: FastifyInstance): void {
  app.get('/v1/consultant/chain/recent', { preHandler: requireSession }, async (req, reply) => {
    const limitRaw = (req.query as Record<string, string>).limit;
    const limit = limitRaw === undefined ? DEFAULT_LIMIT : Number(limitRaw);

    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return reply.status(400).send({
        error: 'invalid_query',
        message: `Query param "limit" must be an integer in [1, ${MAX_LIMIT}].`,
        requestId: req.id,
      });
    }

    const tenantId = req.user!.tenantId!;

    return await sql.begin(async (tx) => {
      // GUC is set even though there's no chain query yet — keeps the
      // transaction shape identical to what the real query will need,
      // so future maintainers don't accidentally drop RLS scoping when
      // they fill in the SELECT.
      await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;

      // TODO(audit-chain): replace with real SELECT once the
      // audit_chain_block table exists. See banner above.
      const blocks: Array<{
        id: string;
        kind: string;
        when: string;
        claim: string;
      }> = [];
      const height = 0;

      // `limit` is currently unused (no rows to slice). Reference it
      // here to avoid a TS unused-warning AND to document that the
      // real implementation must respect it.
      void limit;

      return { blocks, height };
    });
  });
}
