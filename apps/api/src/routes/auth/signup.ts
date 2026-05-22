import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import { privilegedSql } from '@cpa/db/client';
import { findOrCreateUser, lookupActiveTenant, signSession } from '@cpa/auth';

/**
 * Self-service signup routes (P9.1.6.3).
 *
 * Flow:
 *   1. POST /v1/auth/signup — validate body, sign verification token, send email
 *   2. User clicks link containing the token
 *   3. POST /v1/auth/verify-email — verify token, create user + tenant + tenant_user,
 *      issue session JWT cookie, return 200
 *
 * The verification token is a short-lived HS256 JWT (24h) signed with a
 * separate `verificationSecret` — distinct from the session secret so a
 * compromised verification link cannot be replayed as a session token.
 */

export interface SignupRouteDeps {
  /** HS256 secret used for session JWTs (shared with other auth routes). */
  sessionSecret: string;
  /** HS256 secret used ONLY for the short-lived verification token. */
  verificationSecret: string;
  /** Cookie name for the session cookie (e.g. 'cpa_session'). */
  cookieName: string;
  /** Whether to set Secure flag on the session cookie. */
  cookieSecure: boolean;
  /** Session JWT TTL in seconds. */
  ttlSeconds: number;
  /**
   * Called after generating the verification token. In production, sends
   * an email with a link to the frontend /verify-email page. In tests,
   * captures the token for assertion.
   */
  sendVerificationEmail: (to: string, token: string) => Promise<void>;
  /**
   * Non-production/operator fallback for local demos when outbound email is
   * not configured. Production should leave this false so delivery failures
   * are visible and signup does not silently bypass email.
   */
  allowManualVerification?: boolean;
  /** Base URL used to expose a manual verification link when allowed. */
  verificationBaseUrl?: string;
}

const VERIFICATION_ISSUER = 'cpa-signup-verification';
const VERIFICATION_AUDIENCE = 'cpa-signup';
const VERIFICATION_TTL_SECONDS = 24 * 60 * 60; // 24 hours
const TRIAL_DAYS = 30;

const secretToKey = (s: string): Uint8Array => new TextEncoder().encode(s);

const signupBody = z.object({
  email: z.string().email(),
  firmName: z.string().min(1).max(200),
  displayName: z.string().min(1).max(200).optional(),
});

const verifyEmailBody = z.object({
  token: z.string().min(1),
});

/** Derive a URL-safe slug from a firm name. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 63);
}

/** Ensure the slug is unique by appending a short random suffix if needed. */
async function uniqueSlug(base: string): Promise<string> {
  let slug = base;
  const rows = await privilegedSql<{ slug: string }[]>`
    SELECT slug FROM tenant WHERE slug = ${slug} AND deleted_at IS NULL LIMIT 1
  `;
  if (rows.length === 0) return slug;
  // Collision — append 6 random hex chars
  slug = `${base}-${crypto.randomBytes(3).toString('hex')}`;
  return slug;
}

export function registerSignupRoutes(app: FastifyInstance, deps: SignupRouteDeps): void {
  const { sessionSecret, verificationSecret, cookieName, cookieSecure, ttlSeconds } = deps;

  const sessionCookieAttrs = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${ttlSeconds}${cookieSecure ? '; Secure' : ''}`;

  // ---------------------------------------------------------------------------
  // POST /v1/auth/signup
  // ---------------------------------------------------------------------------

  app.post('/v1/auth/signup', async (req, reply) => {
    const parseResult = signupBody.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(422).send({
        error: 'invalid_body',
        message: 'email and firmName are required',
        issues: parseResult.error.issues,
        requestId: req.id,
      });
    }

    const { email, firmName, displayName } = parseResult.data;

    // Sign a short-lived verification token
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ email, firmName, displayName: displayName ?? null })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(VERIFICATION_ISSUER)
      .setAudience(VERIFICATION_AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(now + VERIFICATION_TTL_SECONDS)
      .sign(secretToKey(verificationSecret));

    const verificationUrl = deps.verificationBaseUrl
      ? `${deps.verificationBaseUrl.replace(/\/$/, '')}/verify-email?token=${encodeURIComponent(token)}`
      : undefined;

    try {
      await deps.sendVerificationEmail(email, token);
    } catch (err) {
      req.log.error({ err }, 'signup verification email failed');
      if (!deps.allowManualVerification || !verificationUrl) throw err;
      return reply.status(202).send({
        ok: true,
        delivery: 'manual_verification',
        verificationUrl,
        message: 'Email delivery is not configured. Use the verification link below to continue.',
      });
    }

    return reply.status(202).send({ ok: true, delivery: 'email_sent' });
  });

  // ---------------------------------------------------------------------------
  // POST /v1/auth/verify-email
  // ---------------------------------------------------------------------------

  app.post('/v1/auth/verify-email', async (req, reply) => {
    const parseResult = verifyEmailBody.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(422).send({
        error: 'invalid_body',
        message: 'token is required',
        requestId: req.id,
      });
    }

    const { token } = parseResult.data;

    // Verify the token
    let claims: { email: string; firmName: string; displayName: string | null };
    try {
      const { payload } = await jwtVerify(token, secretToKey(verificationSecret), {
        issuer: VERIFICATION_ISSUER,
        audience: VERIFICATION_AUDIENCE,
      });
      claims = {
        email: String(payload['email']),
        firmName: String(payload['firmName']),
        displayName: (payload['displayName'] as string | null) ?? null,
      };
    } catch {
      return reply.status(401).send({
        error: 'invalid_token',
        message: 'Verification token is invalid or expired',
        requestId: req.id,
      });
    }

    const { email, firmName, displayName } = claims;

    // Create user (email idp) — 409 if user already exists for this email
    let user: Awaited<ReturnType<typeof findOrCreateUser>>;
    try {
      user = await findOrCreateUser({
        primaryIdp: 'email',
        externalId: email,
        email,
        displayName,
      });
    } catch (err) {
      // Check for email unique violation — user was already registered
      if (typeof err === 'object' && err !== null && 'code' in err && err.code === '23505') {
        return reply.status(409).send({
          error: 'already_registered',
          message: 'An account with this email already exists. Please sign in instead.',
          requestId: req.id,
        });
      }
      throw err;
    }

    // If the user already existed (ON CONFLICT path), findOrCreateUser won't throw
    // but the user may already have a tenant. Check for existing tenant membership.
    const existingActive = await lookupActiveTenant(user.id);
    if (existingActive.activeTenantId !== null) {
      // User is already a tenant member — treat as already registered
      return reply.status(409).send({
        error: 'already_registered',
        message: 'An account with this email already exists. Please sign in instead.',
        requestId: req.id,
      });
    }

    // Create tenant with trial status
    const tenantId = crypto.randomUUID();
    const slug = await uniqueSlug(slugify(firmName));
    const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();

    await privilegedSql`
        INSERT INTO tenant (id, name, slug, primary_idp, trial_status, trial_ends_at, billing_mode)
        VALUES (${tenantId}, ${firmName}, ${slug}, 'mixed', 'active', ${trialEndsAt}, 'trial')
      `;

    // Create tenant_user (admin role, default tenant)
    await privilegedSql`
        INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
        VALUES (gen_random_uuid(), ${tenantId}, ${user.id}, 'admin', true)
      `;

    // Issue session JWT
    const jwt = await signSession(
      {
        sub: user.id,
        email: user.email,
        primaryIdp: 'email',
        activeTenantId: tenantId,
        activeRole: 'admin',
        availableTenants: [{ tenantId, name: firmName, slug, role: 'admin' }],
      },
      sessionSecret,
      { ttlSeconds },
    );

    void reply.header('set-cookie', `${cookieName}=${jwt}; ${sessionCookieAttrs}`);
    return reply.status(200).send({ ok: true });
  });
}
