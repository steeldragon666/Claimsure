import type { FastifyInstance } from 'fastify';
import { lookupActiveTenant } from '@cpa/auth';
import { privilegedSql } from '@cpa/db/client';

/**
 * Register GET /v1/whoami — returns the current user's identity, active
 * tenant, and full firm membership list.
 *
 * Requires a valid session JWT. The session middleware (sessionPlugin)
 * runs as preHandler and populates req.user; this route is a thin
 * wrapper that 401s if req.user is unset, otherwise re-queries the
 * tenant list (rather than reading from the cookie's availableTenants
 * claim — gives the client the freshest membership view, especially if
 * a firm admin just added them).
 *
 * The lookupActiveTenant call uses the privileged DB client (RLS-bypass)
 * because firm membership is the thing that determines tenant scope, not
 * a thing scoped BY a tenant.
 */
export function registerWhoami(app: FastifyInstance): void {
  app.get('/v1/whoami', async (req, reply) => {
    if (!req.user) {
      return reply
        .status(401)
        .send({ error: 'unauthenticated', message: 'No session', requestId: req.id });
    }
    const active = await lookupActiveTenant(req.user.id);

    // The session JWT carries only stable identity (id/email/tenant/role),
    // not the user's editable display_name — so re-query it here (privileged,
    // because identity isn't tenant-scoped) to give the client the freshest
    // name without re-minting tokens on every rename. Same rationale as
    // re-querying availableTenants above rather than trusting the cookie.
    const userRows = await privilegedSql<{ display_name: string | null }[]>`
      SELECT display_name FROM "user" WHERE id = ${req.user.id} LIMIT 1
    `;

    return {
      user: {
        id: req.user.id,
        email: req.user.email,
        displayName: userRows[0]?.display_name ?? null,
        tenantId: req.user.tenantId,
        role: req.user.role,
      },
      availableTenants: active.availableTenants,
    };
  });
}
