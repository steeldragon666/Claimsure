import type { FastifyInstance } from 'fastify';
import { sql } from '@cpa/db/client';

/**
 * P9 Phase 3 — Federation share revocation.
 *
 * POST /v1/federation/shares/:id/revoke
 *
 * Source tenant consultant revokes a previously granted federation share.
 * Sets revoked_at, revoked_by_user_id, and optional revoked_reason.
 * Also inserts a federation_audit row with action='revoked'.
 *
 * RLS WITH CHECK on federation_share ensures only the source tenant can
 * write (revoke) — the endpoint doesn't need an additional ownership guard.
 */

export function registerFederationRevocation(app: FastifyInstance): void {
  app.post<{
    Params: { id: string };
    Body: { reason?: string };
  }>('/v1/federation/shares/:id/revoke', async (req, reply) => {
    const { id } = req.params;
    const reason = req.body?.reason ?? null;

    // RLS scopes the UPDATE to source_tenant_id = current tenant (via WITH CHECK).
    // If the share doesn't exist or doesn't belong to the caller, 0 rows updated.
    const updated = await sql<{ revoked_at: string }[]>`
      UPDATE federation_share
      SET revoked_at = now(),
          revoked_by_user_id = ${req.user!.id},
          revoked_reason = ${reason},
          updated_at = now()
      WHERE id = ${id}
        AND revoked_at IS NULL
      RETURNING revoked_at
    `;

    if (updated.length === 0) {
      return reply.code(404).send({
        error: 'not_found',
        message: 'Share not found, already revoked, or not owned by your organisation',
      });
    }

    // Insert audit row recording the revocation
    await sql`
      INSERT INTO federation_audit (
        federation_share_id, accessed_by_user_id, resource_type, resource_id, action
      )
      VALUES (
        ${id}, ${req.user!.id}, 'federation_share', ${id}, 'revoked'
      )
    `;

    return reply.send({ revoked_at: updated[0]!.revoked_at });
  });
}
