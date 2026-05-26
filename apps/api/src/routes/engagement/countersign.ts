import type { FastifyInstance } from 'fastify';
import { requireSession } from '@cpa/auth';
import { sql } from '@cpa/db/client';

/**
 * POST /v1/engagement/:id/countersign
 *
 * Session-required. The consultant (or admin) counter-signs an
 * already-signed engagement letter — bilateral consent for the legal
 * record. Records the actor's user id and a server-side timestamp on
 * the engagement_letter row.
 *
 * **Role gate:** `admin` or `consultant` only. `viewer` is rejected
 * 403 because viewers cannot bind the firm to an engagement.
 *
 * **Lifecycle gate:** the letter must already be signed by the
 * claimant. Counter-signing before claimant signature is nonsensical
 * (and would mis-order the legal record). We also block double
 * counter-sign — once countersigned, the row is terminal for this
 * action.
 *
 * RLS-scoped: cross-tenant ids are 404 not 403.
 */
interface CountersignResponse {
  countersignedAt: string;
}

export function registerEngagementCountersign(app: FastifyInstance): void {
  app.post<{ Params: { id: string } }>(
    '/v1/engagement/:id/countersign',
    { preHandler: requireSession },
    async (req, reply) => {
      const user = req.user!;
      if (user.role !== 'admin' && user.role !== 'consultant') {
        return reply.status(403).send({
          error: 'forbidden',
          message: 'admin or consultant role required',
          requestId: req.id,
        });
      }

      const tenantId = user.tenantId!;
      const userId = user.id;
      const engagementId = req.params.id;

      const result = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;

        // Conditional UPDATE in one round-trip — return the new
        // timestamp via RETURNING. Filters:
        //   - id match (RLS narrows tenant scope)
        //   - signed by claimant (precondition)
        //   - not already countersigned (no double-sign)
        //   - not declined / expired (terminal-status guard)
        const updated = await tx<{ countersigned_at: Date }[]>`
          UPDATE engagement_letter
             SET countersigned_by_user_id = ${userId},
                 countersigned_at = NOW()
           WHERE id = ${engagementId}
             AND signed_by_claimant_at IS NOT NULL
             AND countersigned_at IS NULL
             AND declined_at IS NULL
             AND expired_at IS NULL
          RETURNING countersigned_at
        `;
        if (updated.length === 0) {
          // Distinguish 404 (no such row visible to this tenant) from
          // 409 (row exists but failed precondition). RLS-scoped lookup
          // tells us which.
          const probe = await tx<{ id: string }[]>`
            SELECT id FROM engagement_letter WHERE id = ${engagementId}
          `;
          if (probe.length === 0) return { kind: 'not_found' as const };
          return { kind: 'conflict' as const };
        }
        return { kind: 'ok' as const, countersignedAt: updated[0]!.countersigned_at };
      });

      if (result.kind === 'not_found') {
        return reply
          .status(404)
          .send({ error: 'not_found', message: 'engagement letter not found', requestId: req.id });
      }
      if (result.kind === 'conflict') {
        return reply.status(409).send({
          error: 'conflict',
          message:
            'engagement letter is not in a state that can be countersigned (must be signed by claimant, not already countersigned, not declined/expired)',
          requestId: req.id,
        });
      }

      return reply.status(200).send({
        countersignedAt: result.countersignedAt.toISOString(),
      } satisfies CountersignResponse);
    },
  );
}
