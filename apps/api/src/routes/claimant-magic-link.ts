import crypto from 'node:crypto';
import { SignJWT } from 'jose';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { privilegedSql } from '@cpa/db/client';

/**
 * Claimant-side magic-link redemption (T-C11, the PWA flavour).
 *
 * Mirrors `POST /v1/auth/magic-link/redeem` (F7, mobile flavour) with two
 * differences:
 *
 *   1. Issues a session COOKIE, not a JSON access/refresh-token pair.
 *      The PWA is browser-resident and benefits from the standard
 *      httpOnly + sameSite=Lax + secure-in-prod cookie semantics that
 *      mobile can't use over a fresh native app load.
 *
 *   2. Uses a distinct audience (`pwa-claimant`) so the same employee's
 *      cookie can't be replayed at the mobile API and vice versa — the
 *      JWT signing key is the same `SESSION_JWT_SECRET` used everywhere
 *      else (HS256), but the audience separates the surfaces.
 *
 * The redemption flow consumes the same `magic_link_token` row F7 does;
 * an employee can redeem on either surface but each token is single-use.
 * That's deliberate — the design doc treats the magic link as the
 * universal bootstrap signal, regardless of whether the user opens it on
 * their phone or laptop.
 */

const PWA_CLAIMANT_AUDIENCE = 'pwa-claimant';
// 90 days, matching mobile's refresh-token sliding window. The PWA cookie
// IS the long-lived credential here (we don't run a refresh-rotation loop
// — claimant employees check in irregularly, and a rotation would either
// invalidate their tab on every page reload or require a separate
// refresh round-trip the design doesn't budget for).
const SESSION_TTL_SECONDS = 90 * 24 * 60 * 60;
export const CLAIMANT_SESSION_COOKIE = 'cpa_claimant_session';

const claimantRedeemBody = z.object({
  token: z.string().min(1).max(200),
});

const errEnvelope = (
  code: string,
  message: string,
  requestId: string,
): { error: { code: string; message: string }; requestId: string } => ({
  error: { code, message },
  requestId,
});

const sessionSecret = (): string => {
  const v = process.env['SESSION_JWT_SECRET'];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error('SESSION_JWT_SECRET unset');
  }
  return v;
};

/**
 * Sign a PWA-claimant session JWT.
 *
 * Audience separates this from consultant + mobile tokens. `sub` is the
 * employee.id (not user.id — the PWA is keyed off the same
 * subject_tenant_employee row mobile uses), `tenant_id` carries the
 * consultant firm so RLS GUC is settable, `subject_tenant_id` carries the
 * claimant for scope.
 */
async function signClaimantSession(args: {
  employeeId: string;
  tenantId: string;
  subjectTenantId: string;
  secret: string;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const key = new TextEncoder().encode(args.secret);
  return await new SignJWT({
    tenant_id: args.tenantId,
    subject_tenant_id: args.subjectTenantId,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(args.employeeId)
    .setAudience(PWA_CLAIMANT_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + SESSION_TTL_SECONDS)
    .sign(key);
}

const buildSetCookieHeader = (jwt: string, isProd: boolean): string => {
  // httpOnly so JS in the page can't read it (XSS containment).
  // SameSite=Lax balances CSRF protection with letting the magic-link
  // redirect (cross-site GET → same-site POST → redirect) work; a strict
  // SameSite would drop the cookie on the server-side fetch from the
  // /m landing page back to /status.
  // Path=/ so cookie travels to all PWA routes.
  // Max-Age=SESSION_TTL_SECONDS so the browser persists across tab close.
  // Secure only in prod — dev runs over plain HTTP.
  return [
    `${CLAIMANT_SESSION_COOKIE}=${jwt}`,
    `Max-Age=${SESSION_TTL_SECONDS}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(isProd ? ['Secure'] : []),
  ].join('; ');
};

/**
 * Verify a claimant session JWT (used by C12 layout + status/score routes).
 *
 * Throws on invalid signature, expired exp, wrong audience, or missing
 * required claims. Returns the employee + tenant context the caller needs
 * to scope their reads.
 */
export interface ClaimantSessionPrincipal {
  employeeId: string;
  tenantId: string;
  subjectTenantId: string;
}

export async function verifyClaimantSession(
  jwt: string,
  secret: string,
): Promise<ClaimantSessionPrincipal> {
  const { jwtVerify } = await import('jose');
  const { payload } = await jwtVerify(jwt, new TextEncoder().encode(secret), {
    audience: PWA_CLAIMANT_AUDIENCE,
  });
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new Error('claimant JWT missing sub');
  }
  const tenantId = payload['tenant_id'];
  const subjectTenantId = payload['subject_tenant_id'];
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    throw new Error('claimant JWT missing tenant_id');
  }
  if (typeof subjectTenantId !== 'string' || subjectTenantId.length === 0) {
    throw new Error('claimant JWT missing subject_tenant_id');
  }
  return {
    employeeId: payload.sub,
    tenantId,
    subjectTenantId,
  };
}

/**
 * Register POST /v1/claimant-auth/redeem (T-C11).
 *
 * Body: { token }
 * Response: 200 + Set-Cookie (cpa_claimant_session). Body is { ok: true }
 *           plus a small employee summary so the redirect target can show
 *           the user's name without an extra round-trip.
 *
 * NOT auth-gated — same rationale as F7. The token IS the auth signal.
 */
export function registerClaimantMagicLinkRedeem(app: FastifyInstance): void {
  app.post('/v1/claimant-auth/redeem', async (req, reply) => {
    const parsed = claimantRedeemBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send(errEnvelope('INVALID_BODY', 'Body must be { token }', req.id));
    }
    const { token } = parsed.data;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // Step 1: lookup the magic-link row by hash.
    const tokenRows = await privilegedSql<
      {
        id: string;
        employee_id: string;
        expires_at: Date;
        consumed_at: Date | null;
      }[]
    >`
      SELECT id, employee_id, expires_at, consumed_at
        FROM magic_link_token
       WHERE token_hash = ${tokenHash}
    `;
    const tokenRow = tokenRows[0];
    if (!tokenRow) {
      return reply
        .status(401)
        .send(errEnvelope('UNAUTHENTICATED', 'invalid or expired token', req.id));
    }
    const now = Date.now();
    if (tokenRow.consumed_at !== null) {
      return reply.status(401).send(errEnvelope('UNAUTHENTICATED', 'token already used', req.id));
    }
    if (new Date(tokenRow.expires_at).getTime() <= now) {
      return reply
        .status(401)
        .send(errEnvelope('UNAUTHENTICATED', 'invalid or expired token', req.id));
    }

    // Step 2: mark consumed via conditional UPDATE so a concurrent redeem
    // (eg. the user clicked the link twice) doesn't double-mint sessions.
    const consumed = await privilegedSql<{ id: string }[]>`
      UPDATE magic_link_token
         SET consumed_at = NOW()
       WHERE id = ${tokenRow.id} AND consumed_at IS NULL
      RETURNING id
    `;
    if (!consumed[0]) {
      return reply.status(401).send(errEnvelope('UNAUTHENTICATED', 'token already used', req.id));
    }

    // Step 3: load the employee. Reject deactivated employees — same
    // policy as F7.
    const employeeRows = await privilegedSql<
      {
        id: string;
        subject_tenant_id: string;
        tenant_id: string;
        name: string;
        deactivated_at: Date | null;
      }[]
    >`
      SELECT id, subject_tenant_id, tenant_id, name, deactivated_at
        FROM subject_tenant_employee
       WHERE id = ${tokenRow.employee_id}
    `;
    const employee = employeeRows[0];
    if (!employee || employee.deactivated_at !== null) {
      return reply.status(401).send(errEnvelope('UNAUTHENTICATED', 'employee not active', req.id));
    }

    // Step 4: bump first_seen_at / last_seen_at on the employee row.
    await privilegedSql`
      UPDATE subject_tenant_employee
         SET first_seen_at = COALESCE(first_seen_at, NOW()),
             last_seen_at = NOW()
       WHERE id = ${employee.id}
    `;

    // Step 5: sign the cookie + set it on the response.
    const jwt = await signClaimantSession({
      employeeId: employee.id,
      tenantId: employee.tenant_id,
      subjectTenantId: employee.subject_tenant_id,
      secret: sessionSecret(),
    });
    const isProd = process.env['NODE_ENV'] === 'production';
    void reply.header('set-cookie', buildSetCookieHeader(jwt, isProd));

    return reply.status(200).send({
      ok: true,
      employee: {
        id: employee.id,
        name: employee.name,
        subject_tenant_id: employee.subject_tenant_id,
        tenant_id: employee.tenant_id,
      },
    });
  });
}
