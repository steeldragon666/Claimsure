import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { insertEventWithChain } from '@cpa/db';
import { sql } from '@cpa/db/client';

/**
 * P9 Phase 3 — Federation audit hook.
 *
 * Fastify `onResponse` hook registered on federation read routes.
 * After a successful federated read response:
 *   1. INSERT into federation_audit (share_id, user_id, resource_type, resource_id)
 *   2. Emit FEDERATION_READ event to the event chain via insertEventWithChain
 *
 * The hook reads federation context stashed on the request object by the
 * shares.ts route handlers (federationShareId, federationResourceType,
 * federationResourceId).
 */

interface FederationRequestContext {
  federationShareId?: string;
  federationResourceType?: string;
  federationResourceId?: string;
}

/**
 * Register the federation audit onResponse hook on the given Fastify instance.
 *
 * Only fires when federation context is present on the request (set by
 * shares.ts handlers). Non-federation requests pass through unaffected.
 */
export function registerFederationAuditHook(app: FastifyInstance): void {
  app.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = req as unknown as FederationRequestContext;

    // Only fire for federated reads that succeeded
    if (!ctx.federationShareId || !ctx.federationResourceType) return;
    if (reply.statusCode >= 400) return;
    if (!req.user) return;

    const shareId = ctx.federationShareId;
    const resourceType = ctx.federationResourceType;
    const resourceId = ctx.federationResourceId;

    try {
      // 1. INSERT into federation_audit
      if (resourceId) {
        await sql`
          INSERT INTO federation_audit (
            federation_share_id, accessed_by_user_id, resource_type, resource_id, action
          )
          VALUES (
            ${shareId}, ${req.user.id}, ${resourceType}, ${resourceId}, 'read'
          )
        `;
      }

      // 2. Look up the share for event chain emission
      const shares = await sql<{ source_tenant_id: string; subject_tenant_id: string }[]>`
        SELECT source_tenant_id, subject_tenant_id
        FROM federation_share
        WHERE id = ${shareId}
      `;

      if (shares.length === 0) return;
      const share = shares[0]!;

      // 3. Emit FEDERATION_READ event to the event chain
      await insertEventWithChain({
        tenant_id: share.source_tenant_id,
        subject_tenant_id: share.subject_tenant_id,
        kind: 'FEDERATION_READ',
        payload: {
          share_id: shareId,
          accessed_by_tenant_id: req.user.tenantId,
          accessed_by_user_id: req.user.id,
          resource_type: resourceType,
          resource_id: resourceId ?? null,
        },
        classification: null,
        captured_at: new Date(),
        captured_by_user_id: req.user.id,
        override_of_event_id: null,
        override_new_kind: null,
        override_reason: null,
      });
    } catch (err) {
      // Audit failures should not break the response — log and continue
      app.log.error({ err, shareId, resourceType, resourceId }, 'Federation audit hook failed');
    }
  });
}
