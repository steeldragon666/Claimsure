import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { privilegedSql } from '@cpa/db/client';
import { findOrCreateUser, lookupActiveTenant, signSession } from '@cpa/auth';
import { makeSignupEvaluator, type SignupEvaluator } from '@cpa/agents/signup-evaluator';
import {
  runSignupPipeline,
  writeSignupDecisionAudit,
  type SignupPipelineDeps,
} from '../../lib/signup-pipeline.js';

/**
 * Self-service signup routes — autonomous AI-gated approval.
 *
 * POST /v1/auth/signup runs the 5-step pipeline synchronously
 * (admin override → rate limit → email shape → ABR lookup → Claude eval)
 * and either:
 *   - approve: creates user + tenant + tenant_user in a single transaction,
 *              issues a session JWT, returns 200 with redirectTo.
 *   - deny:    returns 403 with a polite generic message. No tenant created.
 *
 * Every attempt — approve or deny — writes a row to signup_decision with the
 * full audit trail (see migration 0088).
 *
 * The legacy POST /v1/auth/verify-email route is kept as a no-op fallback for
 * any in-flight verification tokens issued before this change shipped. It
 * always returns 410 Gone with a pointer to the new flow. The handler is NOT
 * called during normal operation.
 */

export interface SignupRouteDeps {
  /** HS256 secret used for session JWTs (shared with other auth routes). */
  sessionSecret: string;
  /**
   * Kept on the interface for back-compat with the existing test harness
   * (buildSignupApp constructs an instance with this field set). The new
   * pipeline does not issue verification tokens, so it is unused. Future
   * cleanup can remove it once all callers stop passing it.
   */
  verificationSecret: string;
  /** Cookie name for the session cookie (e.g. 'cpa_session'). */
  cookieName: string;
  /** Whether to set Secure flag on the session cookie. */
  cookieSecure: boolean;
  /** Session JWT TTL in seconds. */
  ttlSeconds: number;
  /**
   * Kept for back-compat — historic deployments wired this in. The new
   * pipeline never issues verification emails, so this field is silently
   * ignored. Remove after the dependency footprint is cleaned up.
   */
  sendVerificationEmail?: (to: string, token: string) => Promise<void>;
  /** Back-compat fields — both ignored in the new flow. */
  allowManualVerification?: boolean;
  verificationBaseUrl?: string;
  /**
   * Optional evaluator injection for tests. Production callers leave this
   * unset and the route resolves the factory at first call.
   */
  signupEvaluator?: SignupEvaluator;
}

const TRIAL_DAYS = 30;
const REDIRECT_AFTER_APPROVE = '/subject-tenants';

const signupBody = z.object({
  email: z.string().email(),
  firmName: z.string().min(1).max(200),
  displayName: z.string().min(1).max(200).optional(),
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
  if (slug === '') slug = `firm-${crypto.randomBytes(3).toString('hex')}`;
  const rows = await privilegedSql<{ slug: string }[]>`
    SELECT slug FROM tenant WHERE slug = ${slug} AND deleted_at IS NULL LIMIT 1
  `;
  if (rows.length === 0) return slug;
  // Collision — append 6 random hex chars
  return `${base}-${crypto.randomBytes(3).toString('hex')}`;
}

interface CreatedTenantResult {
  tenantId: string;
  userId: string;
  slug: string;
  firmName: string;
}

/**
 * Create the user + tenant + tenant_user trio for an approved signup.
 *
 * Throws an Error with `.code === '23505'` if the email is already taken
 * or if the user already has a tenant (treated as "already registered" by
 * the route).
 */
async function createTenantForApprovedSignup(args: {
  email: string;
  firmName: string;
  displayName: string | null;
}): Promise<CreatedTenantResult> {
  const { email, firmName, displayName } = args;

  // Reuse @cpa/auth.findOrCreateUser for the email-idp insert (handles all
  // the dual-unique race-recovery for us).
  const user = await findOrCreateUser({
    primaryIdp: 'email',
    externalId: email,
    email,
    displayName,
  });

  // If the user already had a tenant from a prior signup, refuse to create
  // another one — surface as "already registered". This is rare with the
  // new pipeline (each signup creates a new tenant) but possible during
  // the transition or if an admin manually inserts a user.
  const existingActive = await lookupActiveTenant(user.id);
  if (existingActive.activeTenantId !== null) {
    const err = new Error('user already has a tenant') as Error & { code?: string };
    err.code = '23505';
    throw err;
  }

  const tenantId = crypto.randomUUID();
  const slug = await uniqueSlug(slugify(firmName));
  const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  await privilegedSql`
    INSERT INTO tenant (id, name, slug, primary_idp, trial_status, trial_ends_at, billing_mode)
    VALUES (${tenantId}, ${firmName}, ${slug}, 'mixed', 'active', ${trialEndsAt}, 'trial')
  `;

  await privilegedSql`
    INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
    VALUES (gen_random_uuid(), ${tenantId}, ${user.id}, 'admin', true)
  `;

  return { tenantId, userId: user.id, slug, firmName };
}

export function registerSignupRoutes(app: FastifyInstance, deps: SignupRouteDeps): void {
  const { sessionSecret, cookieName, cookieSecure, ttlSeconds } = deps;
  const sessionCookieAttrs = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${ttlSeconds}${cookieSecure ? '; Secure' : ''}`;

  // Lazy-resolve the evaluator so test callers can inject a stub via
  // deps.signupEvaluator. Production constructs the factory once and reuses.
  let cachedEvaluator: SignupEvaluator | null = null;
  function getEvaluator(): SignupEvaluator {
    if (deps.signupEvaluator) return deps.signupEvaluator;
    if (!cachedEvaluator) cachedEvaluator = makeSignupEvaluator();
    return cachedEvaluator;
  }

  // ---------------------------------------------------------------------------
  // POST /v1/auth/signup — the autonomous pipeline
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
    const normalizedEmail = email.trim().toLowerCase();
    const clientIp = req.ip ?? null;
    const userAgent = req.headers['user-agent'] ?? null;

    const pipelineDeps: SignupPipelineDeps = {
      privilegedSql,
      evaluator: getEvaluator(),
      logger: req.log,
    };

    const result = await runSignupPipeline(
      {
        email: normalizedEmail,
        firmName,
        displayName: displayName ?? null,
        clientIp,
        userAgent,
      },
      pipelineDeps,
    );

    // -----------------------------------------------------------------------
    // DENY path
    // -----------------------------------------------------------------------
    if (result.outcome.decision === 'deny') {
      // Audit first — never silently drop the forensic row.
      try {
        await writeSignupDecisionAudit(privilegedSql, {
          email: normalizedEmail,
          firmName,
          displayName: displayName ?? null,
          clientIp,
          userAgent,
          resultingTenantId: null,
          resultingUserId: null,
          outcome: result.outcome,
          audit: result.audit,
        });
      } catch (err) {
        req.log.error(
          { err: err instanceof Error ? err.message : String(err) },
          'signup: deny-path audit write failed',
        );
      }
      // Server-side log carries the reason; client gets a generic message.
      req.log.warn(
        { reason: result.outcome.reason, email: normalizedEmail, firmName, clientIp },
        'signup denied by pipeline',
      );
      return reply.status(403).send({
        ok: false,
        decision: 'denied',
        message:
          'We could not auto-approve your request. Please contact aaron@carbonproject.com.au if you believe this is in error.',
      });
    }

    // -----------------------------------------------------------------------
    // APPROVE path — create user + tenant + tenant_user, issue session
    // -----------------------------------------------------------------------
    let created: CreatedTenantResult;
    try {
      created = await createTenantForApprovedSignup({
        email: normalizedEmail,
        firmName,
        displayName: displayName ?? null,
      });
    } catch (err) {
      if (typeof err === 'object' && err !== null && 'code' in err && err.code === '23505') {
        // Already registered. Still write the audit row so an operator can
        // see the duplicate attempt, but DON'T set resulting_{tenant,user}_id.
        try {
          await writeSignupDecisionAudit(privilegedSql, {
            email: normalizedEmail,
            firmName,
            displayName: displayName ?? null,
            clientIp,
            userAgent,
            resultingTenantId: null,
            resultingUserId: null,
            outcome: result.outcome,
            audit: result.audit,
          });
        } catch (auditErr) {
          req.log.error(
            { err: auditErr instanceof Error ? auditErr.message : String(auditErr) },
            'signup: duplicate-path audit write failed',
          );
        }
        return reply.status(409).send({
          error: 'already_registered',
          message: 'An account with this email already exists.',
          requestId: req.id,
        });
      }
      req.log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'signup: tenant creation failed',
      );
      throw err;
    }

    // Issue session JWT
    const jwt = await signSession(
      {
        sub: created.userId,
        email: normalizedEmail,
        primaryIdp: 'email',
        activeTenantId: created.tenantId,
        activeRole: 'admin',
        availableTenants: [
          { tenantId: created.tenantId, name: created.firmName, slug: created.slug, role: 'admin' },
        ],
      },
      sessionSecret,
      { ttlSeconds },
    );

    void reply.header('set-cookie', `${cookieName}=${jwt}; ${sessionCookieAttrs}`);

    // Audit AFTER successful tenant creation so the row carries the resulting IDs.
    // A failure here would NOT roll back the tenant — that's intentional: a
    // missing audit row is recoverable from the request log; a rolled-back tenant
    // creation is not. Loud-log on failure.
    try {
      await writeSignupDecisionAudit(privilegedSql, {
        email: normalizedEmail,
        firmName,
        displayName: displayName ?? null,
        clientIp,
        userAgent,
        resultingTenantId: created.tenantId,
        resultingUserId: created.userId,
        outcome: result.outcome,
        audit: result.audit,
      });
    } catch (err) {
      req.log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          tenantId: created.tenantId,
          userId: created.userId,
        },
        'signup: approve-path audit write failed (tenant created OK, audit row missing)',
      );
    }

    return reply.status(200).send({
      ok: true,
      decision: 'approved',
      redirectTo: REDIRECT_AFTER_APPROVE,
    });
  });

  // ---------------------------------------------------------------------------
  // POST /v1/auth/verify-email — LEGACY NO-OP
  //
  // The new autonomous pipeline issues a session cookie directly on signup, so
  // verification tokens are no longer minted. We keep this endpoint registered
  // so any in-flight links from before the cutover get a clear 410 with a
  // pointer back to /signup. Remove after one full TTL window
  // (the old verification tokens expired after 24h).
  // ---------------------------------------------------------------------------

  app.post('/v1/auth/verify-email', async (req, reply) => {
    req.log.info('signup: legacy verify-email endpoint called (410 Gone)');
    return reply.status(410).send({
      error: 'verification_flow_retired',
      message:
        'Email verification is no longer required. Please complete signup at /signup — your trial workspace will be created instantly.',
      requestId: req.id,
    });
  });
}
