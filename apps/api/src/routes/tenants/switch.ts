import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { lookupActiveTenant, requireSession, signSession } from '@cpa/auth';
import { privilegedSql } from '@cpa/db/client';

const SwitchBody = z.object({
  tenantId: z
    .string()
    .regex(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      'must be a UUID v4',
    ),
});

interface UserCoreRow {
  email: string;
  primary_idp: 'microsoft' | 'google' | 'email' | 'auth0';
  display_name: string | null;
}

export interface SwitchTenantConfig {
  sessionSecret: string;
  cookieName: string;
  cookieSecure: boolean;
  ttlSeconds: number;
}

const sessionCookieAttrs = (cfg: SwitchTenantConfig): string =>
  `Path=/; HttpOnly; SameSite=Lax; Max-Age=${cfg.ttlSeconds}${cfg.cookieSecure ? '; Secure' : ''}`;

/**
 * Register POST /v1/tenants/switch — change active firm mid-session.
 *
 * Body: { tenantId: UUID v4 }.
 *
 * Behaviour:
 *   1. Validate the requested tenantId is one of the user's current firm
 *      memberships (re-queried via privilegedSql; we don't trust the
 *      JWT's possibly-stale availableTenants claim).
 *   2. Re-sign the session JWT with the new activeTenantId + activeRole.
 *      The 24h expiry resets (per W3 design Q-parking decision: no
 *      sliding extension; switch resets the clock fresh, like re-login).
 *   3. Set the new cpa_session cookie with the same flags as the
 *      original login.
 *   4. Return the new whoami shape: { user, activeTenant, availableTenants }.
 *
 * preHandler: requireSession.
 *
 * Errors:
 *   - 400 invalid_body if tenantId not a UUID
 *   - 404 tenant_not_found if user has no membership in the requested tenant
 */
export function registerSwitchTenant(app: FastifyInstance, cfg: SwitchTenantConfig): void {
  app.post('/v1/tenants/switch', { preHandler: requireSession }, async (req, reply) => {
    const parsed = SwitchBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'invalid_body',
        message: 'Body must be { tenantId: UUID v4 }',
        requestId: req.id,
      });
    }
    const { tenantId } = parsed.data;
    const userId = req.user!.id;

    // Re-fetch memberships — caller may have been added to or removed
    // from firms since their JWT was issued.
    const active = await lookupActiveTenant(userId);
    const target = active.availableTenants.find((t) => t.tenantId === tenantId);
    if (!target) {
      return reply.status(404).send({
        error: 'tenant_not_found',
        message: 'You are not a member of that firm',
        requestId: req.id,
      });
    }

    // Need email + primaryIdp + displayName from user row to re-sign the JWT.
    // These are not on req.user (sessionPlugin only attaches the active-tenant
    // subset). Use privilegedSql since the user table is GLOBAL (no RLS).
    const userRows = await privilegedSql<UserCoreRow[]>`
      SELECT email, primary_idp, display_name
        FROM "user"
       WHERE id = ${userId} AND deleted_at IS NULL
    `;
    if (!userRows[0]) {
      // Race: user was soft-deleted between session middleware and here
      return reply.status(401).send({
        error: 'user_not_found',
        message: 'User no longer exists',
        requestId: req.id,
      });
    }

    const newJwt = await signSession(
      {
        sub: userId,
        email: userRows[0].email,
        primaryIdp: userRows[0].primary_idp,
        activeTenantId: target.tenantId,
        activeRole: target.role,
        availableTenants: active.availableTenants.map(({ tenantId, name, slug, role }) => ({
          tenantId,
          name,
          slug,
          role,
        })),
      },
      cfg.sessionSecret,
      { ttlSeconds: cfg.ttlSeconds },
    );

    void reply.header('set-cookie', `${cfg.cookieName}=${newJwt}; ${sessionCookieAttrs(cfg)}`);

    return {
      user: {
        id: userId,
        email: userRows[0].email,
        displayName: userRows[0].display_name,
        primaryIdp: userRows[0].primary_idp,
      },
      activeTenant: {
        id: target.tenantId,
        name: target.name,
        slug: target.slug,
        role: target.role,
      },
      availableTenants: active.availableTenants,
    };
  });
}
