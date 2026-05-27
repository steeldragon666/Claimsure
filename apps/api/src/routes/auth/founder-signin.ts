/**
 * GET /v1/auth/founder-issued-signin?token=<jwt>
 *
 * Magic-signin link issued by the founder-approve route. The applicant
 * clicks this from the "your workspace is ready" email; we verify the JWT,
 * mint a normal cpa_session cookie, and 302-redirect to /subject-tenants.
 *
 * Auth: token query param (JWT signed with SESSION_JWT_SECRET, custom
 * kind='founder-issued-signin', 24h TTL). Public route.
 *
 * Defence-in-depth: the JWT carries `email` and `tenantId` claims and we
 * cross-check them against the user row and active tenant_user. Anything
 * inconsistent → invalid-link HTML page.
 */
import type { FastifyInstance } from 'fastify';
import { privilegedSql as sql } from '@cpa/db/client';
import { signSession, type AvailableTenant } from '@cpa/auth';
import { verifyFounderSigninToken } from '../../lib/founder-signin-token.js';

export interface FounderSigninRouteDeps {
  sessionSecret: string;
  cookieName: string;
  cookieSecure: boolean;
  ttlSeconds: number;
}

interface UserRow {
  id: string;
  email: string;
  primary_idp: string;
}

interface TenantRow {
  tenant_id: string;
  tenant_name: string;
  tenant_slug: string;
  role: string;
  is_default: boolean;
}

function htmlInvalid(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Invalid link</title></head><body style="font-family:system-ui,sans-serif;max-width:560px;margin:80px auto;padding:0 16px;line-height:1.6"><h1>This sign-in link is invalid or expired.</h1><p>Please contact your consultant.</p></body></html>`;
}

const REDIRECT_AFTER_SIGNIN = '/subject-tenants';

export function registerFounderSignin(app: FastifyInstance, deps: FounderSigninRouteDeps): void {
  const sessionCookieAttrs = ['Path=/', `Max-Age=${deps.ttlSeconds}`, 'HttpOnly', 'SameSite=Lax'];
  if (deps.cookieSecure) sessionCookieAttrs.push('Secure');

  app.get<{ Querystring: { token?: string } }>(
    '/v1/auth/founder-issued-signin',
    async (req, reply) => {
      const token = req.query.token;
      if (!token || token.length === 0) {
        void reply.type('text/html');
        return reply.status(401).send(htmlInvalid());
      }

      let payload: Awaited<ReturnType<typeof verifyFounderSigninToken>>;
      try {
        payload = await verifyFounderSigninToken(token, deps.sessionSecret);
      } catch (err) {
        req.log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'founder-signin: JWT verify failed',
        );
        void reply.type('text/html');
        return reply.status(401).send(htmlInvalid());
      }

      // privilegedSql — no session GUC on a public route.
      const userRows = await sql<UserRow[]>`
        SELECT id::text, email, primary_idp
          FROM "user"
         WHERE id = ${payload.sub}::uuid
         LIMIT 1
      `;
      const user = userRows[0];
      if (!user) {
        req.log.warn({ sub: payload.sub }, 'founder-signin: user not found');
        void reply.type('text/html');
        return reply.status(401).send(htmlInvalid());
      }

      // Defence in depth — JWT email must match the DB row.
      if (user.email.trim().toLowerCase() !== payload.email.trim().toLowerCase()) {
        req.log.warn(
          { sub: payload.sub, dbEmail: user.email, jwtEmail: payload.email },
          'founder-signin: email mismatch between JWT and user row',
        );
        void reply.type('text/html');
        return reply.status(401).send(htmlInvalid());
      }

      const tenantRows = await sql<TenantRow[]>`
        SELECT tu.tenant_id::text,
               t.name AS tenant_name,
               t.slug AS tenant_slug,
               tu.role,
               tu.is_default
          FROM tenant_user tu
          JOIN tenant t ON t.id = tu.tenant_id
         WHERE tu.user_id = ${user.id}
           AND tu.deleted_at IS NULL
           AND t.deleted_at IS NULL
         ORDER BY tu.is_default DESC, t.created_at ASC
      `;
      const active = tenantRows.find((t) => t.tenant_id === payload.tenantId);
      if (!active) {
        req.log.warn(
          { sub: payload.sub, tenantId: payload.tenantId },
          'founder-signin: tenant from JWT not in user memberships',
        );
        void reply.type('text/html');
        return reply.status(401).send(htmlInvalid());
      }

      const availableTenants: AvailableTenant[] = tenantRows.map((t) => ({
        tenantId: t.tenant_id,
        name: t.tenant_name,
        slug: t.tenant_slug,
        role: t.role as 'admin' | 'consultant' | 'viewer',
      }));

      const jwt = await signSession(
        {
          sub: user.id,
          email: user.email,
          primaryIdp: (user.primary_idp as 'microsoft' | 'google' | 'email' | 'auth0') ?? 'email',
          activeTenantId: active.tenant_id,
          activeRole: active.role as 'admin' | 'consultant' | 'viewer',
          availableTenants,
        },
        deps.sessionSecret,
        { ttlSeconds: deps.ttlSeconds },
      );

      void reply.header(
        'set-cookie',
        `${deps.cookieName}=${jwt}; ${sessionCookieAttrs.join('; ')}`,
      );

      return reply.redirect(REDIRECT_AFTER_SIGNIN, 302);
    },
  );
}
