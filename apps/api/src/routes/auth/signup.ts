import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql as db, privilegedSql } from '@cpa/db/client';
import { findOrCreateUser, lookupActiveTenant, signSession } from '@cpa/auth';
import { makeSignupEvaluator, type SignupEvaluator } from '@cpa/agents/signup-evaluator';
import {
  runSignupPipeline,
  writeSignupDecisionAudit,
  type SignupPipelineDeps,
  type SignupPipelineResult,
} from '../../lib/signup-pipeline.js';
import {
  parseFounderRecipients,
  sendFounderNotification,
  type FounderNotificationSender,
} from '../../lib/founder-notification.js';
import { getPublicBaseUrl } from '../../lib/public-base-url.js';

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
  /**
   * Optional founder-notification sender override (tests pass a recorder).
   * Production: if FOUNDER_NOTIFICATION_EMAIL is set and this is unset, the
   * route lazy-imports @cpa/email and constructs a sender on first use. If
   * FOUNDER_NOTIFICATION_EMAIL is unset, no notification fires (feature off).
   */
  founderNotificationSender?: FounderNotificationSender;
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

/** Number of suffixed attempts the slug generator will try before giving up. */
const MAX_SLUG_ATTEMPTS = 5;

/**
 * Generate a candidate slug for INSERT. `attempt === 0` returns the bare
 * slugified base; subsequent attempts append a fresh hex suffix. The
 * caller's responsibility is to drive this in a try-INSERT-catch-23505 loop;
 * read-before-write was previously racy (between SELECT and INSERT a
 * concurrent signup could claim the same slug, and our INSERT would 500).
 */
function candidateSlug(base: string, attempt: number): string {
  const root = base === '' ? `firm-${crypto.randomBytes(3).toString('hex')}` : base;
  if (attempt === 0) return root;
  return `${root}-${crypto.randomBytes(3).toString('hex')}`;
}

interface CreatedTenantResult {
  tenantId: string;
  userId: string;
  slug: string;
  firmName: string;
}

/**
 * Distinguishable error class — the caller maps this to a 409 response with
 * `already_registered` and writes a route-side audit row with that reason.
 *
 * Was previously expressed as a generic Error with `.code = '23505'`, which
 * collided with real DB unique-violations (slug collisions) and made the
 * 409-vs-500 branching brittle. A named class is more explicit.
 */
class AlreadyRegisteredError extends Error {
  constructor() {
    super('user already has an active tenant');
    this.name = 'AlreadyRegisteredError';
  }
}

/** Detect a Postgres unique-violation, optionally on a specific constraint. */
function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; constraint_name?: unknown; message?: unknown };
  if (e.code !== '23505') return false;
  if (!constraint) return true;
  if (e.constraint_name === constraint) return true;
  return typeof e.message === 'string' && e.message.includes(constraint);
}

/**
 * Create the user + tenant + tenant_user trio for an approved signup.
 *
 * Race-safety:
 *   - User insert is via `findOrCreateUser`, which already uses an advisory
 *     lock + email-unique recovery (see @cpa/auth.users.ts).
 *   - Tenant + tenant_user inserts are wrapped in a single `db.begin`
 *     transaction. Inside the tx we:
 *       1. Set `app.current_tenant_id` to the soon-to-be tenant_id so the
 *          tenant_user RLS USING / WITH CHECK predicate passes.
 *       2. Re-check `lookupActiveTenant(user.id)` AFTER acquiring an advisory
 *          lock keyed on the user_id — a concurrent signup that got past the
 *          earlier check is now blocked on the lock and will see the row we
 *          INSERT on commit.
 *       3. INSERT tenant.
 *       4. INSERT tenant_user. The partial unique index
 *          `tenant_user_one_default_per_user_uniq` (migration 0089) is the
 *          DB-layer safety net: even if both transactions race past the
 *          re-check, only one succeeds.
 *
 * RLS bootstrap (CLAUDE.md: never use privilegedSql for application paths):
 *   - We use the RLS-enforcing `db` client and set the GUC inside the tx so
 *     the tenant_user policy fires correctly. This restores the immutable
 *     rule that signup is no different from any other application write.
 *
 * Throws `AlreadyRegisteredError` if the user already has an active tenant
 * (either discovered by the re-check or by the partial-unique-index violation
 * on tenant_user); throws other 23505s up the stack so the route can decide
 * whether to retry the slug or 500.
 */
async function createTenantForApprovedSignup(args: {
  email: string;
  firmName: string;
  displayName: string | null;
}): Promise<CreatedTenantResult> {
  const { email, firmName, displayName } = args;

  // Reuse @cpa/auth.findOrCreateUser for the email-idp insert (handles all
  // the dual-unique race-recovery for us). This runs as its own transaction
  // with its own advisory lock keyed on (primary_idp, external_id).
  const user = await findOrCreateUser({
    primaryIdp: 'email',
    externalId: email,
    email,
    displayName,
  });

  // Pre-tx fast path: if the user already has an active tenant, refuse
  // immediately without burning a tx. The in-tx re-check below is the
  // authoritative check; this one just saves work in the common case.
  const existingActive = await lookupActiveTenant(user.id);
  if (existingActive.activeTenantId !== null) {
    throw new AlreadyRegisteredError();
  }

  const baseSlug = slugify(firmName);
  const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  let lastSlugErr: unknown = null;
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    const tenantId = crypto.randomUUID();
    const slug = candidateSlug(baseSlug, attempt);
    try {
      const result = await db.begin(async (tx) => {
        // SET LOCAL ROLE cpa_app is injected by the client.ts wrapper so RLS
        // policies fire as the application role (not as the table owner).
        // Set the tenant GUC to the just-generated tenant_id; the
        // tenant_user policy compares `tenant_id = NULLIF(current_setting(...), '')::uuid`
        // and will pass for INSERTs where tenant_id = ${tenantId}.
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;

        // Serialise concurrent same-user signup creations at the DB layer.
        // pg_advisory_xact_lock auto-releases on commit/rollback. hashtext is
        // 32-bit; collisions across different user_ids are harmless (brief
        // throughput penalty only).
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`signup:${user.id}`}))`;

        // Re-check inside the tx, AFTER the lock. A concurrent signup that
        // was scheduled before us has now committed its tenant_user; we'll
        // see it here and bail.
        const existing = await tx<{ tenant_id: string }[]>`
          SELECT tu.tenant_id
            FROM tenant_user tu
            JOIN tenant t ON t.id = tu.tenant_id AND t.deleted_at IS NULL
           WHERE tu.user_id = ${user.id}
             AND tu.deleted_at IS NULL
             AND tu.is_default = true
           LIMIT 1
        `;
        if (existing.length > 0) {
          throw new AlreadyRegisteredError();
        }

        // tenant has no RLS — INSERT proceeds straight.
        await tx`
          INSERT INTO tenant (id, name, slug, primary_idp, trial_status, trial_ends_at, billing_mode)
          VALUES (${tenantId}, ${firmName}, ${slug}, 'mixed', 'active', ${trialEndsAt}, 'trial')
        `;

        // tenant_user IS RLS-protected. The GUC set above means the WITH CHECK
        // predicate (`tenant_id = NULLIF(current_setting(...), '')::uuid`)
        // evaluates ${tenantId} = ${tenantId} → pass.
        await tx`
          INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
          VALUES (gen_random_uuid(), ${tenantId}, ${user.id}, 'admin', true)
        `;

        return { tenantId, slug };
      });
      return { tenantId: result.tenantId, userId: user.id, slug: result.slug, firmName };
    } catch (err) {
      // AlreadyRegistered escapes immediately — no retry.
      if (err instanceof AlreadyRegisteredError) throw err;

      // The DB-layer safety-net constraint fired: another tx beat us to
      // the partial unique index. Surface as AlreadyRegistered.
      if (isUniqueViolation(err, 'tenant_user_one_default_per_user_uniq')) {
        throw new AlreadyRegisteredError();
      }

      // Slug collision — retry with a fresh hex suffix.
      if (isUniqueViolation(err, 'tenant_slug_unique')) {
        lastSlugErr = err;
        continue;
      }

      // Any other unique violation (or anything else) bubbles up.
      throw err;
    }
  }
  // Exhausted attempts — surface the last slug-collision as a hard error.
  // In practice this never happens (5 attempts × 24 bits of entropy each).
  if (lastSlugErr instanceof Error) throw lastSlugErr;
  throw new Error('uniqueSlug: exhausted retries');
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

  // Lazy-resolve the founder-notification sender. Tests inject via
  // deps.founderNotificationSender; production lazy-imports @cpa/email at
  // first use (mirrors the engagement-reminder pattern). If neither is
  // available AND FOUNDER_NOTIFICATION_EMAIL is unset, the feature is off.
  let cachedFounderSender: FounderNotificationSender | null = null;
  async function getFounderSender(): Promise<FounderNotificationSender | null> {
    if (deps.founderNotificationSender) return deps.founderNotificationSender;
    if (cachedFounderSender) return cachedFounderSender;
    const resendApiKey = process.env['RESEND_API_KEY'];
    if (!resendApiKey || resendApiKey.length === 0) return null;
    const { createResendClient, createEmailSender } = await import('@cpa/email');
    const client = createResendClient({ apiKey: resendApiKey });
    cachedFounderSender = createEmailSender(client, {
      fromAddress:
        process.env['FOUNDER_FROM_ADDRESS'] ??
        process.env['BETA_FROM_ADDRESS'] ??
        'ArchiveOne <noreply@archiveone.com.au>',
    });
    return cachedFounderSender;
  }

  /**
   * Fire-and-log founder notification. Never throws — must not block the
   * signup response. The caller passes the decisionId returned by the
   * audit insert; if that insert itself failed, the caller passes null and
   * we silently skip (we don't have a stable id to put in the override
   * link).
   */
  async function notifyFounderSafely(args: {
    decisionId: string | null;
    email: string;
    firmName: string;
    displayName: string | null;
    clientIp: string | null;
    userAgent: string | null;
    result: SignupPipelineResult;
    logger: typeof app.log;
  }): Promise<void> {
    const recipients = parseFounderRecipients(process.env['FOUNDER_NOTIFICATION_EMAIL']);
    if (recipients.length === 0) return;
    if (args.decisionId === null) {
      args.logger.warn(
        { email: args.email },
        'signup: skipping founder notification — no decisionId (audit insert failed)',
      );
      return;
    }
    const overrideSecret = process.env['FOUNDER_OVERRIDE_SECRET'];
    if (!overrideSecret || overrideSecret.length === 0) {
      // server.ts asserts this at boot, but defensive guard in tests too.
      args.logger.warn(
        'signup: FOUNDER_NOTIFICATION_EMAIL set but FOUNDER_OVERRIDE_SECRET missing; skipping',
      );
      return;
    }
    const sender = await getFounderSender();
    if (!sender) {
      args.logger.warn(
        'signup: FOUNDER_NOTIFICATION_EMAIL set but no sender available (RESEND_API_KEY unset?); skipping',
      );
      return;
    }
    try {
      await sendFounderNotification(
        sender,
        {
          decisionId: args.decisionId,
          email: args.email,
          firmName: args.firmName,
          displayName: args.displayName,
          clientIp: args.clientIp,
          userAgent: args.userAgent,
          outcome: args.result.outcome,
          audit: args.result.audit,
        },
        {
          recipients,
          overrideSecret,
          publicBaseUrl: getPublicBaseUrl(),
        },
      );
    } catch (err) {
      args.logger.warn(
        { err: err instanceof Error ? err.message : String(err), email: args.email },
        'signup: founder notification email failed (signup response not affected)',
      );
    }
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

    // Run the pipeline inside a single privilegedSql transaction so the
    // pg_advisory_xact_lock(hashtext(client_ip)) serialises concurrent
    // same-IP signups against the 5/hour rate-limit step. Without this lock,
    // two concurrent same-IP signups both see count=N, both decide N < 5,
    // both proceed, both audit-row count=N+1 → 6/hour passed through.
    //
    // Lock auto-releases on commit/rollback so we never leak it. The Anthropic
    // call sits inside this tx — that's a deliberate tradeoff: privilegedSql
    // is pool max=5 so at most 5 concurrent signup pipelines can be in flight,
    // which is fine for the expected QPS (autonomous signup is bursty but
    // sparse; the bottleneck is the LLM, not the DB pool).
    //
    // On infra failure we surface `infra_failure_permissive` (same as the
    // pipeline's existing non-tx failure mode).
    let result: SignupPipelineResult;
    try {
      result = await privilegedSql.begin(async (tx) => {
        if (clientIp) {
          // hashtext is 32-bit. Collisions across different IPs are harmless:
          // unrelated signups momentarily serialise, no correctness impact.
          await tx`SELECT pg_advisory_xact_lock(hashtext(${`signup-ip:${clientIp}`}))`;
        }
        const pipelineDeps: SignupPipelineDeps = {
          privilegedSql: tx as unknown as typeof privilegedSql,
          evaluator: getEvaluator(),
          logger: req.log,
        };
        return await runSignupPipeline(
          {
            email: normalizedEmail,
            firmName,
            displayName: displayName ?? null,
            clientIp,
            userAgent,
          },
          pipelineDeps,
        );
      });
    } catch (err) {
      req.log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'signup: pipeline tx failed; falling through to permissive approve',
      );
      // Preserve the permissive bias on infra failure. Manufacture a
      // result that the existing approve-path code handles unchanged.
      result = {
        outcome: { decision: 'approve', reason: 'infra_failure_permissive' },
        audit: {
          adminOverrideHit: false,
          rateLimitCountInWindow: null,
          emailShapeOk: null,
          abrLookup: null,
          claudeConfidence: null,
          claudeDecision: null,
          claudeRationale: null,
          claudeRedFlags: null,
          classifierModel: null,
          promptVersion: null,
          tokensIn: null,
          tokensOut: null,
          elapsedMs: 0,
        },
      };
    }

    // -----------------------------------------------------------------------
    // DENY path
    // -----------------------------------------------------------------------
    if (result.outcome.decision === 'deny') {
      // Audit first — never silently drop the forensic row.
      let denyDecisionId: string | null = null;
      try {
        const written = await writeSignupDecisionAudit(privilegedSql, {
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
        denyDecisionId = written.id;
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

      // Fire founder notification before sending the response. Wrapped in
      // try/catch inside notifyFounderSafely so it never blocks the reply.
      await notifyFounderSafely({
        decisionId: denyDecisionId,
        email: normalizedEmail,
        firmName,
        displayName: displayName ?? null,
        clientIp,
        userAgent,
        result,
        logger: req.log,
      });

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
      if (err instanceof AlreadyRegisteredError) {
        // Already registered. Still write the audit row so an operator can
        // see the duplicate attempt, but DON'T set resulting_{tenant,user}_id.
        // Use the route-level terminal reason `already_registered` — the
        // pipeline approved but tenant creation refused.
        const dupOutcome = { decision: 'deny', reason: 'already_registered' } as const;
        let dupDecisionId: string | null = null;
        try {
          const written = await writeSignupDecisionAudit(privilegedSql, {
            email: normalizedEmail,
            firmName,
            displayName: displayName ?? null,
            clientIp,
            userAgent,
            resultingTenantId: null,
            resultingUserId: null,
            outcome: dupOutcome,
            audit: result.audit,
          });
          dupDecisionId = written.id;
        } catch (auditErr) {
          req.log.error(
            { err: auditErr instanceof Error ? auditErr.message : String(auditErr) },
            'signup: duplicate-path audit write failed',
          );
        }
        await notifyFounderSafely({
          decisionId: dupDecisionId,
          email: normalizedEmail,
          firmName,
          displayName: displayName ?? null,
          clientIp,
          userAgent,
          result: { outcome: dupOutcome, audit: result.audit },
          logger: req.log,
        });
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
    let approveDecisionId: string | null = null;
    try {
      const written = await writeSignupDecisionAudit(privilegedSql, {
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
      approveDecisionId = written.id;
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

    await notifyFounderSafely({
      decisionId: approveDecisionId,
      email: normalizedEmail,
      firmName,
      displayName: displayName ?? null,
      clientIp,
      userAgent,
      result,
      logger: req.log,
    });

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
