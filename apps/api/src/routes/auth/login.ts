/**
 * Passwordless login for already-approved ArchiveOne users.
 *
 * POST /v1/auth/login
 *   Body: { email: string }   (zod-validated, lowercased + trimmed)
 *
 * This is the login counterpart to the passwordless signup flow. Signup
 * mints a session cookie instantly on approval (no email round-trip); login
 * mirrors that contract for users who ALREADY have an approved workspace:
 *
 *   - Look up the user by email, join their active tenant membership(s) and
 *     tenant rows, and build the SAME session-claim shape signup produces
 *     (sub, email, primaryIdp, activeTenantId, activeRole, availableTenants).
 *   - Found + has at least one active membership → signSession, set the
 *     session cookie exactly like signup, return 200 { ok, redirect }.
 *   - Not found OR no active membership → 404 { error: 'no_workspace', ... }.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TRUST-BASED PASSWORDLESS LOGIN — EXPLICIT PRODUCT DECISION
 * ─────────────────────────────────────────────────────────────────────────
 * This endpoint mints a real session from an email address ALONE — no
 * password, no magic-link round-trip, no OTP. Anyone who knows an approved
 * user's email can obtain that user's session. This is a deliberate product
 * decision for the current ArchiveOne phase: the user base is a small set of
 * vetted, approved firm operators, and the friction of email verification is
 * judged not worth it at this stage. The per-IP rate limit below is the only
 * gate. If/when the trust model changes, this route must grow real proof of
 * email control (magic link / OTP) before it ships to a broader audience.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Pre-session DB reads use `privilegedSql`: the session we are about to mint
 * does not exist yet, so we cannot set the `app.current_tenant_id` GUC that
 * cpa_app's RLS policies require for `tenant_user`. This mirrors signup's
 * pre-session lookup and dev-login.ts.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { privilegedSql } from '@cpa/db/client';
import { signSession, type AvailableTenant } from '@cpa/auth';

export interface LoginRouteConfig {
  /** HS256 secret used for session JWTs (shared with signup + other auth routes). */
  sessionSecret: string;
  /** Cookie name for the session cookie (e.g. 'archiveone_session' in prod). */
  cookieName: string;
  /** Whether to set the Secure flag on the session cookie. */
  cookieSecure: boolean;
  /** Session JWT TTL in seconds. */
  ttlSeconds: number;
  /** Max login attempts per IP per hour. Defaults to 30. */
  rateLimitPerHour?: number;
}

const loginBody = z.object({
  email: z.string().email(),
});

const REDIRECT_AFTER_LOGIN = '/consultant';
const DEFAULT_RATE_LIMIT_PER_HOUR = 30;

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

export function registerLoginRoute(app: FastifyInstance, cfg: LoginRouteConfig): void {
  const rateLimitPerHour = cfg.rateLimitPerHour ?? DEFAULT_RATE_LIMIT_PER_HOUR;

  // Cookie attributes mirror signup's `sessionCookieAttrs` EXACTLY:
  // Path=/, HttpOnly, SameSite=Lax, Max-Age=ttl, and Secure only when
  // cookieSecure is set (production). See routes/auth/signup.ts.
  const sessionCookieAttrs = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${cfg.ttlSeconds}${cfg.cookieSecure ? '; Secure' : ''}`;

  app.post('/v1/auth/login', async (req, reply) => {
    // CSRF / forced-login defense. This endpoint mints a session cookie from
    // an unauthenticated POST, so a cross-site page must not be able to drive
    // it. Browsers stamp `Sec-Fetch-Site` on fetch/form requests and send an
    // `Origin` on cross-origin POSTs; reject anything that is demonstrably
    // cross-site. Non-browser callers (mobile app, curl) send neither header
    // and are allowed through — they cannot be a browser CSRF vector.
    const secFetchSite = req.headers['sec-fetch-site'];
    if (
      typeof secFetchSite === 'string' &&
      secFetchSite !== 'same-origin' &&
      secFetchSite !== 'none'
    ) {
      return reply.status(403).send({
        error: 'cross_site_blocked',
        message: 'Cross-site login requests are not allowed.',
        requestId: req.id,
      });
    }
    const originHeader = req.headers.origin;
    if (typeof originHeader === 'string' && originHeader.length > 0) {
      let originHost: string | null = null;
      try {
        originHost = new URL(originHeader).host;
      } catch {
        originHost = null;
      }
      if (originHost === null || originHost !== req.headers.host) {
        return reply.status(403).send({
          error: 'cross_site_blocked',
          message: 'Cross-site login requests are not allowed.',
          requestId: req.id,
        });
      }
    }

    const parseResult = loginBody.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(422).send({
        error: 'invalid_body',
        message: 'A valid email is required.',
        issues: parseResult.error.issues,
        requestId: req.id,
      });
    }

    const normalizedEmail = parseResult.data.email.trim().toLowerCase();
    const clientIp = req.ip ?? null;

    // Run the lookup inside a privilegedSql transaction so the per-IP
    // pg_advisory_xact_lock(hashtext(...)) serialises concurrent same-IP
    // logins against the rate-limit count — the SAME pattern signup uses
    // for its per-IP gate (see signup.ts: `signup-ip:<ip>`). The lock
    // auto-releases on commit/rollback so we never leak it.
    const result = await privilegedSql.begin(async (tx) => {
      if (clientIp) {
        // hashtext is 32-bit; collisions across different IPs are harmless
        // (unrelated logins momentarily serialise, no correctness impact).
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`login-ip:${clientIp}`}))`;

        const countRows = await tx<{ c: string }[]>`
          SELECT count(*)::text AS c
            FROM auth_login_attempt
           WHERE client_ip = ${clientIp}::inet
             AND attempted_at > (now() - interval '1 hour')
        `;
        const countInWindow = Number(countRows[0]?.c ?? 0);
        if (countInWindow >= rateLimitPerHour) {
          return { kind: 'rate_limited' as const };
        }

        // Record this attempt for the rolling window. Recorded for ANY
        // attempt (found or not) so the limit cannot be bypassed by
        // probing unknown emails.
        await tx`
          INSERT INTO auth_login_attempt (client_ip)
          VALUES (${clientIp}::inet)
        `;
      }

      const userRows = await tx<UserRow[]>`
        SELECT id::text, email, primary_idp
          FROM "user"
         WHERE email = ${normalizedEmail}
           AND deleted_at IS NULL
         LIMIT 1
      `;
      const user = userRows[0] ?? null;
      if (user === null) {
        return { kind: 'no_workspace' as const };
      }

      const tenantRows = await tx<TenantRow[]>`
        SELECT tu.tenant_id::text,
               t.name AS tenant_name,
               t.slug AS tenant_slug,
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
        return { kind: 'no_workspace' as const };
      }

      const active = tenantRows.find((t) => t.is_default) ?? tenantRows[0]!;
      const availableTenants: AvailableTenant[] = tenantRows.map((t) => ({
        tenantId: t.tenant_id,
        name: t.tenant_name,
        slug: t.tenant_slug,
        role: t.role as 'admin' | 'consultant' | 'viewer',
      }));

      return {
        kind: 'ok' as const,
        user,
        active,
        availableTenants,
      };
    });

    if (result.kind === 'rate_limited') {
      // Log the IP only — never the raw email (PII on an internet-facing
      // auth path). The IP is sufficient to diagnose the rate limiter.
      req.log.warn({ clientIp }, 'login rate-limited');
      return reply.status(429).send({
        error: 'rate_limited',
        message: 'Too many login attempts. Please wait a few minutes and try again.',
        requestId: req.id,
      });
    }

    if (result.kind === 'no_workspace') {
      // Found-vs-not-found and no-membership all collapse to the same 404
      // so the response copy is uniform; the message points the user to
      // signup, which is the only way to create a workspace.
      return reply.status(404).send({
        error: 'no_workspace',
        message: 'No approved workspace found for this email. Sign up to create one.',
        requestId: req.id,
      });
    }

    const { user, active, availableTenants } = result;

    // Mirror signup's claim shape EXACTLY.
    const jwt = await signSession(
      {
        sub: user.id,
        email: user.email,
        primaryIdp: (user.primary_idp as 'microsoft' | 'google' | 'email' | 'auth0') ?? 'email',
        activeTenantId: active.tenant_id,
        activeRole: active.role as 'admin' | 'consultant' | 'viewer',
        availableTenants,
      },
      cfg.sessionSecret,
      { ttlSeconds: cfg.ttlSeconds },
    );

    void reply.header('set-cookie', `${cfg.cookieName}=${jwt}; ${sessionCookieAttrs}`);

    req.log.info(
      {
        event: 'passwordless_login.success',
        user_id: user.id,
        active_tenant_id: active.tenant_id,
      },
      'passwordless login: session minted',
    );

    return reply.status(200).send({ ok: true, redirect: REDIRECT_AFTER_LOGIN });
  });
}
