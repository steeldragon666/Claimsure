/**
 * GET /v1/admin/signup-decisions/:id/approve?token=<hmac>
 *
 * Magic-link override for the autonomous signup pipeline. Public route — no
 * session cookie required. The token in the query string is the only auth.
 *
 * Eligibility:
 *   - Decision must be `decision='deny' AND reason='claude_deny'`. We
 *     deliberately do NOT allow overriding rate_limit / email_shape: those
 *     are mechanical filters that don't represent a human-recoverable
 *     judgement. Only Claude's deny is appealable.
 *   - Applicant must not already have an active tenant (idempotent — a
 *     re-clicked link returns "Already approved" rather than creating a
 *     duplicate row).
 *
 * Side effects on success:
 *   1. Create user + tenant + tenant_user (mirrors signup.ts happy path).
 *   2. Insert NEW signup_decision row with reason='admin_override',
 *      admin_override_hit=true. The original deny row is left in place.
 *   3. Email the applicant a magic-signin link (see founder-signin-token.ts).
 *
 * Failure mode: HTML response (this is a one-shot link clicked from a
 * founder's inbox; an HTML page is friendlier than a JSON envelope).
 */
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { privilegedSql } from '@cpa/db/client';
import { findOrCreateUser, lookupActiveTenant } from '@cpa/auth';
import { writeSignupDecisionAudit, type SignupPipelineResult } from '../../lib/signup-pipeline.js';
import { verifyFounderApproveToken } from '../../lib/founder-override-token.js';
import { signFounderSigninToken } from '../../lib/founder-signin-token.js';
import { publicUrl } from '../../lib/public-base-url.js';

const TRIAL_DAYS = 30;
const MAX_SLUG_ATTEMPTS = 5;

export interface FounderApproveRouteDeps {
  /** HMAC secret for verifying the override token. */
  overrideSecret: string;
  /** HS256 secret for issuing the applicant magic-signin JWT. */
  sessionSecret: string;
  /**
   * Optional applicant-signin email sender override (tests pass a recorder).
   * If unset, the route lazy-imports @cpa/email at first invocation. If
   * RESEND_API_KEY is unset AND no override is provided, the applicant email
   * step is logged-and-skipped: the founder still gets the tenant created.
   */
  applicantSigninSender?: {
    send: (input: {
      to: string | string[];
      subject: string;
      html: string;
      text: string;
    }) => Promise<{ id: string }>;
  };
}

interface DecisionRow {
  id: string;
  email: string;
  firm_name: string;
  display_name: string | null;
  client_ip: string | null;
  user_agent: string | null;
  decision: string;
  reason: string;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 63);
}

function candidateSlug(base: string, attempt: number): string {
  const root = base === '' ? `firm-${crypto.randomBytes(3).toString('hex')}` : base;
  if (attempt === 0) return root;
  return `${root}-${crypto.randomBytes(3).toString('hex')}`;
}

function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; constraint_name?: unknown; message?: unknown };
  if (e.code !== '23505') return false;
  if (!constraint) return true;
  if (e.constraint_name === constraint) return true;
  return typeof e.message === 'string' && e.message.includes(constraint);
}

class AlreadyRegisteredError extends Error {
  constructor() {
    super('user already has an active tenant');
    this.name = 'AlreadyRegisteredError';
  }
}

function htmlPage(title: string, body: string, status: number): { status: number; html: string } {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;max-width:560px;margin:80px auto;padding:0 16px;line-height:1.6">${body}</body></html>`;
  return { status, html };
}

/**
 * Send the applicant a magic-signin email. Caller (the route handler) wraps
 * this in try/catch and never lets a failure block the HTML response — the
 * founder has already approved; better to surface "approved but email
 * failed" than to roll back a created tenant.
 */
async function sendApplicantSigninEmail(args: {
  applicantEmail: string;
  signinUrl: string;
  applicantSender: FounderApproveRouteDeps['applicantSigninSender'];
  logger: FastifyInstance['log'];
}): Promise<void> {
  const { applicantEmail, signinUrl, applicantSender, logger } = args;
  let sender = applicantSender;
  if (!sender) {
    const resendApiKey = process.env['RESEND_API_KEY'];
    if (!resendApiKey || resendApiKey.length === 0) {
      logger.warn(
        'founder-approve: RESEND_API_KEY unset; skipping applicant signin email (founder must share the link manually)',
      );
      return;
    }
    const { createResendClient, createEmailSender } = await import('@cpa/email');
    const client = createResendClient({ apiKey: resendApiKey });
    sender = createEmailSender(client, {
      fromAddress:
        process.env['FOUNDER_FROM_ADDRESS'] ??
        process.env['BETA_FROM_ADDRESS'] ??
        'ArchiveOne <noreply@archiveone.com.au>',
    });
  }

  const subject = 'Your ArchiveOne workspace is ready';
  const text = `Your ArchiveOne workspace has been approved.\n\nSign in with one click:\n${signinUrl}\n\nThis link expires in 24 hours.`;
  const html = `<p>Your ArchiveOne workspace has been approved.</p><p><a href="${signinUrl}">Sign in to ArchiveOne</a></p><p>This link expires in 24 hours.</p>`;
  await sender.send({ to: applicantEmail, subject, text, html });
}

interface CreatedTenant {
  tenantId: string;
  userId: string;
  slug: string;
}

async function createTenantForOverride(args: {
  email: string;
  firmName: string;
  displayName: string | null;
}): Promise<CreatedTenant> {
  const { email, firmName, displayName } = args;

  const user = await findOrCreateUser({
    primaryIdp: 'email',
    externalId: email,
    email,
    displayName,
  });

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
      // Use privilegedSql because there's no session GUC bootstrap path on a
      // public magic-link route. signup.ts uses the RLS-enforcing client by
      // setting the GUC inside the tx, but here we'd need to thread the
      // session-plugin scaffolding for a route that has no session — not
      // worth the complexity. privilegedSql bypasses RLS by design.
      const result = await privilegedSql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`signup:${user.id}`}))`;

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

        await tx`
          INSERT INTO tenant (id, name, slug, primary_idp, trial_status, trial_ends_at, billing_mode)
          VALUES (${tenantId}, ${firmName}, ${slug}, 'mixed', 'active', ${trialEndsAt}, 'trial')
        `;
        await tx`
          INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
          VALUES (gen_random_uuid(), ${tenantId}, ${user.id}, 'admin', true)
        `;
        return { tenantId, slug };
      });
      return { tenantId: result.tenantId, userId: user.id, slug: result.slug };
    } catch (err) {
      if (err instanceof AlreadyRegisteredError) throw err;
      if (isUniqueViolation(err, 'tenant_user_one_default_per_user_uniq')) {
        throw new AlreadyRegisteredError();
      }
      if (isUniqueViolation(err, 'tenant_slug_unique')) {
        lastSlugErr = err;
        continue;
      }
      throw err;
    }
  }
  if (lastSlugErr instanceof Error) throw lastSlugErr;
  throw new Error('uniqueSlug: exhausted retries');
}

export function registerFounderApprove(app: FastifyInstance, deps: FounderApproveRouteDeps): void {
  app.get<{
    Params: { id: string };
    Querystring: { token?: string };
  }>('/v1/admin/signup-decisions/:id/approve', async (req, reply) => {
    const decisionId = req.params.id;
    const token = req.query.token;

    if (!token || token.length === 0) {
      const page = htmlPage(
        'Missing token',
        '<h1>Missing token.</h1><p>The approval link is incomplete.</p>',
        401,
      );
      void reply.type('text/html');
      return reply.status(page.status).send(page.html);
    }

    // Load the decision via privilegedSql (no session GUC on a public route).
    const decisionRows = await privilegedSql<DecisionRow[]>`
      SELECT id::text,
             email,
             firm_name,
             display_name,
             client_ip,
             user_agent,
             decision,
             reason
        FROM signup_decision
       WHERE id = ${decisionId}::uuid
       LIMIT 1
    `;
    const decision = decisionRows[0];

    if (!decision) {
      // Don't leak existence — same 401 page as a bad token. The HMAC could
      // never have been valid for a non-existent id anyway (the secret would
      // need to be leaked first).
      const page = htmlPage('Invalid link', '<h1>Invalid or expired link.</h1>', 401);
      void reply.type('text/html');
      return reply.status(page.status).send(page.html);
    }

    // Constant-time HMAC compare.
    const ok = verifyFounderApproveToken({
      token,
      decisionId: decision.id,
      applicantEmail: decision.email,
      secret: deps.overrideSecret,
    });
    if (!ok) {
      const page = htmlPage('Invalid link', '<h1>Invalid or expired link.</h1>', 401);
      void reply.type('text/html');
      return reply.status(page.status).send(page.html);
    }

    // Eligibility check: only claude_deny is appealable.
    if (decision.decision !== 'deny' || decision.reason !== 'claude_deny') {
      const page = htmlPage(
        'Not eligible',
        "<h1>This decision is not eligible for override</h1><p>(already approved, or denied for a reason other than Claude's judgement).</p>",
        400,
      );
      void reply.type('text/html');
      return reply.status(page.status).send(page.html);
    }

    // Idempotency check.
    const existingUser = await privilegedSql<{ id: string }[]>`
      SELECT u.id::text
        FROM "user" u
        JOIN tenant_user tu ON tu.user_id = u.id AND tu.deleted_at IS NULL
       WHERE u.email = ${decision.email}
       LIMIT 1
    `;
    if (existingUser.length > 0) {
      const page = htmlPage(
        'Already approved',
        `<h1>Already approved.</h1><p>${decision.email} has an existing tenant.</p>`,
        200,
      );
      void reply.type('text/html');
      return reply.status(page.status).send(page.html);
    }

    // Create tenant + user.
    let created: CreatedTenant;
    try {
      created = await createTenantForOverride({
        email: decision.email,
        firmName: decision.firm_name,
        displayName: decision.display_name,
      });
    } catch (err) {
      if (err instanceof AlreadyRegisteredError) {
        const page = htmlPage(
          'Already approved',
          `<h1>Already approved.</h1><p>${decision.email} has an existing tenant.</p>`,
          200,
        );
        void reply.type('text/html');
        return reply.status(page.status).send(page.html);
      }
      req.log.error(
        { err: err instanceof Error ? err.message : String(err), decisionId: decision.id },
        'founder-approve: tenant creation failed',
      );
      throw err;
    }

    // Write a new audit row marking the admin_override approve.
    const auditResult: SignupPipelineResult = {
      outcome: { decision: 'approve', reason: 'admin_override' },
      audit: {
        adminOverrideHit: true,
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
    try {
      await writeSignupDecisionAudit(privilegedSql, {
        email: decision.email,
        firmName: decision.firm_name,
        displayName: decision.display_name,
        clientIp: decision.client_ip,
        userAgent: decision.user_agent,
        resultingTenantId: created.tenantId,
        resultingUserId: created.userId,
        outcome: auditResult.outcome,
        audit: auditResult.audit,
      });
    } catch (err) {
      req.log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          tenantId: created.tenantId,
          userId: created.userId,
        },
        'founder-approve: audit insert failed (tenant created OK)',
      );
    }

    // Issue the applicant's signin token + send the email.
    try {
      const jwt = await signFounderSigninToken(
        { sub: created.userId, email: decision.email, tenantId: created.tenantId },
        deps.sessionSecret,
      );
      const signinUrl = publicUrl(
        `/v1/auth/founder-issued-signin?token=${encodeURIComponent(jwt)}`,
      );
      await sendApplicantSigninEmail({
        applicantEmail: decision.email,
        signinUrl,
        applicantSender: deps.applicantSigninSender,
        logger: req.log,
      });
    } catch (err) {
      req.log.warn(
        { err: err instanceof Error ? err.message : String(err), email: decision.email },
        'founder-approve: applicant signin email failed (tenant created OK)',
      );
    }

    const page = htmlPage(
      'Approved',
      `<h1>Approved.</h1><p>${decision.email} has been approved. They have been emailed a one-click sign-in link.</p>`,
      200,
    );
    void reply.type('text/html');
    return reply.status(page.status).send(page.html);
  });
}
