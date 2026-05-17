/**
 * GET /v1/dev/login?token=<bypass>&email=<email>&next=<path>
 *
 * Dev escape-hatch route. Mints a real `cpa_session` JWT for an existing
 * user, bypassing OIDC. The route is ONLY registered when
 * `DEV_LOGIN_TOKEN` is set in the env — production deployments without
 * that env var see a 404 on this path.
 *
 * Designed for founder/operator emergency access when:
 *   - Google/Microsoft OIDC isn't configured in this environment
 *   - The OIDC provider is down
 *   - You need to bypass auth in a test/staging environment
 *
 * SECURITY:
 *   - Bypass token compared via `timingSafeEqual` (constant-time)
 *   - User must exist in the DB (we don't create one on demand — that
 *     would be a privilege-escalation path)
 *   - User must already have a tenant_user row (admin/consultant/viewer)
 *   - Logs every successful mint via a structured stdout line so ops
 *     can audit who used the escape-hatch and when
 *   - Cookie is HttpOnly + Secure (in production) + SameSite=Lax
 *   - `next` param is sanitized to same-origin paths only
 *
 * To rotate the bypass token after use: change DEV_LOGIN_TOKEN env var
 * + redeploy. To disable the route entirely: unset DEV_LOGIN_TOKEN +
 * redeploy.
 */
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { sql } from '@cpa/db/client';
import { signSession, type AvailableTenant } from '@cpa/auth';

export interface DevLoginConfig {
  /** Random opaque string. Caller must present this exact value in ?token=. */
  bypassToken: string;
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

function sanitizeNext(raw: string | undefined): string {
  if (!raw) return '/';
  if (!raw.startsWith('/')) return '/';
  if (raw.startsWith('//')) return '/';
  return raw;
}

function constantTimeEqual(a: string, b: string): boolean {
  // timingSafeEqual requires equal-length buffers; otherwise it throws.
  // Pre-check length non-secretly (length isn't sensitive — only the
  // bytes themselves are).
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function registerDevLogin(app: FastifyInstance, cfg: DevLoginConfig): void {
  app.get<{
    Querystring: { token?: string; email?: string; next?: string };
  }>('/v1/dev/login', async (req, reply) => {
    const { token, email } = req.query;
    const next = sanitizeNext(req.query.next);

    if (!token || !email) {
      return reply.status(400).send({
        error: 'missing_params',
        message: 'token and email query params are required',
      });
    }

    if (!constantTimeEqual(token, cfg.bypassToken)) {
      return reply.status(401).send({
        error: 'invalid_token',
        message: 'dev-login bypass token does not match',
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const userRows = await sql<UserRow[]>`
      SELECT id::text, email, primary_idp
        FROM "user"
       WHERE email = ${normalizedEmail}
       LIMIT 1
    `;
    if (userRows.length === 0) {
      return reply.status(404).send({
        error: 'user_not_found',
        message: `no user with email ${normalizedEmail}`,
      });
    }
    const user = userRows[0]!;

    const tenantRows = await sql<TenantRow[]>`
      SELECT tu.tenant_id::text,
             t.name  AS tenant_name,
             t.slug  AS tenant_slug,
             tu.role,
             tu.is_default
        FROM tenant_user tu
        JOIN tenant t ON t.id = tu.tenant_id
       WHERE tu.user_id    = ${user.id}
         AND tu.deleted_at IS NULL
         AND t.deleted_at  IS NULL
       ORDER BY tu.is_default DESC, t.created_at ASC
    `;
    if (tenantRows.length === 0) {
      return reply.status(403).send({
        error: 'no_tenant_membership',
        message: `user ${normalizedEmail} has no tenant_user rows`,
      });
    }
    const active = tenantRows.find((t) => t.is_default) ?? tenantRows[0]!;

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
        primaryIdp: (user.primary_idp as 'microsoft' | 'google' | 'email') ?? 'google',
        activeTenantId: active.tenant_id,
        activeRole: active.role as 'admin' | 'consultant' | 'viewer',
        availableTenants,
      },
      cfg.sessionSecret,
      { ttlSeconds: cfg.ttlSeconds },
    );

    const cookieAttrs = [
      `${cfg.cookieName}=${jwt}`,
      'Path=/',
      `Max-Age=${cfg.ttlSeconds}`,
      'HttpOnly',
      'SameSite=Lax',
    ];
    if (cfg.cookieSecure) cookieAttrs.push('Secure');

    void reply.header('set-cookie', cookieAttrs.join('; '));

    // Audit trail. No PII beyond the email (which the caller already
    // provided). The Vercel/Railway log pipeline captures this.
    console.log(
      JSON.stringify({
        event: 'dev_login.success',
        user_id: user.id,
        email: user.email,
        active_tenant_id: active.tenant_id,
        ts: new Date().toISOString(),
      }),
    );

    return reply.redirect(next, 302);
  });
}
