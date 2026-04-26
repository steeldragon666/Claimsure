import type { FastifyInstance } from 'fastify';
import { lookupActiveTenant } from '@cpa/auth';

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
    return {
      user: {
        id: req.user.id,
        email: req.user.email,
        tenantId: req.user.tenantId,
        role: req.user.role,
      },
      availableTenants: active.availableTenants,
    };
  });
}
