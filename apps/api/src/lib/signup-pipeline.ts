/**
 * Autonomous signup-approval pipeline.
 *
 * Pure decision engine — invoked inside POST /v1/auth/signup. Five-step
 * cascade:
 *
 *   1. Admin override (env-list bypass)        → approve
 *   2. Postgres-backed per-IP rate limit       → deny if exceeded
 *   3. Email-shape sanity (throwaway / TLD)    → deny if obvious junk
 *   4. ABR (Australian Business Register)      → informational (never blocks)
 *   5. Claude evaluator (LLM)                  → approve / deny / review
 *
 * The pipeline is permissive on uncertainty: 'review' from the LLM, low
 * confidence, OR any infra failure (ABR timeout, Anthropic 5xx, DB rate-limit
 * query failure) all resolve to APPROVE. The product bias is "onboard the
 * legitimate user; let the audit log catch the rare bad actor".
 *
 * The pipeline DOES NOT create the tenant — it only decides. The caller
 * (the signup route) creates user + tenant + tenant_user inside a transaction
 * on approve, then calls `writeSignupDecisionAudit` with the resulting IDs.
 *
 * Audit: ALWAYS, exactly once per call, via `writeSignupDecisionAudit`.
 * Both code paths (approve and deny) MUST write the audit row.
 */

import type { FastifyBaseLogger } from 'fastify';
import type { privilegedSql as PrivilegedSqlType } from '@cpa/db/client';

/**
 * Type alias for the postgres-js tagged-template client. We import the
 * concrete instance type from @cpa/db/client rather than `import type { Sql }
 * from 'postgres'` because postgres is a transitive dependency of @cpa/db and
 * is NOT in apps/api's direct package.json. This keeps the dependency graph
 * clean while still giving us the precise tagged-template generic shape.
 */
type Sql = typeof PrivilegedSqlType;
import type {
  SignupEvaluator,
  SignupEvaluatorOutput,
  AbrMatchEntry,
} from '@cpa/agents/signup-evaluator';
import { lookupAbrMatchingNames, type AbrLookupResult } from './abr-client.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const RATE_LIMIT_PER_IP_PER_HOUR = 5;
const CLAUDE_DENY_MIN_CONFIDENCE = 0.7;
const CLAUDE_APPROVE_MIN_CONFIDENCE = 0.5;

/**
 * Disposable / throwaway email domains. Reject signups from these outright.
 * The set is hand-curated — common operator-known offenders. We are not trying
 * to be comprehensive (that's a losing race); we just block the obvious ones
 * so the Claude evaluator doesn't waste a call on them.
 */
const THROWAWAY_DOMAINS = new Set([
  'mailinator.com',
  '10minutemail.com',
  'guerrillamail.com',
  'tempmail.io',
  'yopmail.com',
  'throwaway.email',
  'getnada.com',
  'fakeinbox.com',
  'dispostable.com',
  'sharklasers.com',
  'trbvm.com',
  'mvrht.net',
  'mvrht.com',
]);

/**
 * Permissive TLD shape check: matches `local@host.tld` where the TLD is
 * 2..24 ASCII letters. This is intentionally loose — IDN / xn-- domains
 * get a pass at this level, and the Claude evaluator can flag them.
 */
const EMAIL_TLD_REGEX = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,24}$/;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Closed set of values that may appear in `signup_decision.reason`.
 *
 * Three-way parity (per CLAUDE.md): this list MUST match the CHECK constraint
 * `signup_decision_reason_valid` in migration 0089 and the Zod enum used in
 * the audit-row shape. The pipeline emits the first seven; the signup route
 * emits `already_registered` as a route-level terminal reason after the
 * pipeline approves but tenant creation discovers a duplicate user.
 */
export const SIGNUP_DECISION_REASONS = [
  'admin_override',
  'rate_limit',
  'email_shape',
  'claude_approve',
  'claude_deny',
  'permissive_fallback',
  'infra_failure_permissive',
  'already_registered',
] as const;
export type SignupDecisionReason = (typeof SIGNUP_DECISION_REASONS)[number];

export type SignupPipelineDecision =
  | {
      decision: 'approve';
      reason:
        | 'admin_override'
        | 'claude_approve'
        | 'permissive_fallback'
        | 'infra_failure_permissive';
    }
  | {
      decision: 'deny';
      reason: 'rate_limit' | 'email_shape' | 'claude_deny';
    }
  | {
      // Route-side terminal — pipeline approved, but tenant creation found
      // an existing user with an active tenant. Emitted only by the route
      // handler, never by `runSignupPipeline` itself.
      decision: 'deny';
      reason: 'already_registered';
    };

export type SignupPipelineResult = {
  outcome: SignupPipelineDecision;
  /** Detail to persist in the signup_decision audit row. */
  audit: {
    adminOverrideHit: boolean;
    rateLimitCountInWindow: number | null;
    emailShapeOk: boolean | null;
    abrLookup: unknown;
    claudeConfidence: number | null;
    claudeDecision: 'approve' | 'deny' | 'review' | null;
    claudeRationale: string | null;
    claudeRedFlags: string[] | null;
    classifierModel: string | null;
    promptVersion: string | null;
    tokensIn: number | null;
    tokensOut: number | null;
    elapsedMs: number;
  };
};

export interface SignupPipelineDeps {
  /**
   * Privileged SQL client — used for the rate-limit count query and the
   * audit insert. The pipeline writes to `signup_decision` which has no
   * cpa_app grants (per migration 0088), so it MUST go through privilegedSql.
   */
  privilegedSql: Sql;
  /** Concrete LLM evaluator (factory-resolved by caller). */
  evaluator: SignupEvaluator;
  /**
   * Optional ABR client override — defaults to {@link lookupAbrMatchingNames}.
   * Tests pass a stub here.
   */
  abrLookup?: (firmName: string) => Promise<AbrLookupResult>;
  /** Optional logger — uses console if absent. Routes pass req.log here. */
  logger?: Pick<FastifyBaseLogger, 'warn' | 'error' | 'info'>;
  /** Override env in tests. */
  env?: NodeJS.ProcessEnv;
}

export interface SignupPipelineInput {
  email: string;
  firmName: string;
  displayName: string | null;
  clientIp: string | null;
  userAgent: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseOverrideEmails(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
}

function emailDomain(email: string): string {
  return (email.split('@')[1] ?? '').toLowerCase();
}

function emailShapeOk(email: string): boolean {
  if (!EMAIL_TLD_REGEX.test(email)) return false;
  const domain = emailDomain(email);
  if (THROWAWAY_DOMAINS.has(domain)) return false;
  return true;
}

async function countRecentSignupsFromIp(
  privilegedSql: Sql,
  clientIp: string | null,
): Promise<number> {
  // No IP → can't rate-limit. Count as zero so the cascade proceeds; the
  // Claude evaluator is the next gate. Anonymous-IP requests are very rare
  // in production (`trustProxy=true` makes Fastify resolve X-Forwarded-For).
  if (!clientIp) return 0;
  const rows = await privilegedSql<{ c: string }[]>`
    SELECT count(*)::text AS c
      FROM signup_decision
     WHERE client_ip = ${clientIp}
       AND decided_at > (now() - interval '1 hour')
  `;
  return Number(rows[0]?.c ?? 0);
}

function shapeAbrMatches(result: AbrLookupResult): AbrMatchEntry[] {
  return result.matches.map((m) => ({
    matched_name: m.matched_name,
    abn: m.abn,
    entity_type: m.entity_type,
    abn_status: m.abn_status,
    registration_state: m.registration_state,
  }));
}

// ---------------------------------------------------------------------------
// Audit writer
// ---------------------------------------------------------------------------

export interface SignupAuditRow extends SignupPipelineResult {
  email: string;
  firmName: string;
  displayName: string | null;
  clientIp: string | null;
  userAgent: string | null;
  resultingTenantId: string | null;
  resultingUserId: string | null;
}

/**
 * Insert a row into `signup_decision`. Always uses privilegedSql because the
 * table is locked down (no cpa_app grants).
 *
 * Failure tolerance: callers should wrap this in try/catch and log on
 * failure — we never want a failed audit write to roll back a successful
 * tenant creation, but we DO want loud logs so an operator can backfill.
 */
export async function writeSignupDecisionAudit(
  privilegedSql: Sql,
  row: SignupAuditRow,
): Promise<{ id: string }> {
  const { outcome, audit } = row;
  // Postgres-js automatically serialises plain objects / arrays for jsonb
  // columns, but the `chain.ts` precedent here is to double-cast to be
  // explicit about the binding shape. We follow that pattern for the
  // abr_lookup and red_flags jsonb columns.
  //
  // RETURNING the row id lets callers correlate downstream side-effects
  // (founder notification email, magic-link override) with the exact audit
  // row they wrote. The Drizzle default expression (`crypto.randomUUID()`)
  // is not in play here — we INSERT via the postgres-js tagged template
  // and rely on the column's DEFAULT (see migration 0088).
  const rows = await privilegedSql<{ id: string }[]>`
    INSERT INTO signup_decision (
      email, firm_name, display_name, client_ip, user_agent,
      decision, reason,
      admin_override_hit, rate_limit_count_in_window, email_shape_ok,
      abr_lookup,
      claude_confidence, claude_decision, claude_rationale, claude_red_flags,
      resulting_tenant_id, resulting_user_id,
      classifier_model, prompt_version, tokens_in, tokens_out, elapsed_ms
    ) VALUES (
      ${row.email}, ${row.firmName}, ${row.displayName},
      ${row.clientIp}, ${row.userAgent},
      ${outcome.decision}, ${outcome.reason},
      ${audit.adminOverrideHit},
      ${audit.rateLimitCountInWindow},
      ${audit.emailShapeOk},
      ${audit.abrLookup === null ? null : JSON.stringify(audit.abrLookup)}::text::jsonb,
      ${audit.claudeConfidence},
      ${audit.claudeDecision},
      ${audit.claudeRationale},
      ${audit.claudeRedFlags === null ? null : JSON.stringify(audit.claudeRedFlags)}::text::jsonb,
      ${row.resultingTenantId}, ${row.resultingUserId},
      ${audit.classifierModel}, ${audit.promptVersion},
      ${audit.tokensIn}, ${audit.tokensOut}, ${audit.elapsedMs}
    )
    RETURNING id::text AS id
  `;
  const id = rows[0]?.id;
  if (!id) {
    throw new Error('writeSignupDecisionAudit: INSERT returned no id');
  }
  return { id };
}

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

function emptyAudit(elapsedMs: number): SignupPipelineResult['audit'] {
  return {
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
    elapsedMs,
  };
}

/**
 * Run the full 5-step pipeline and return a decision. Never throws — all
 * infra failures collapse to `infra_failure_permissive` per the brief.
 */
export async function runSignupPipeline(
  input: SignupPipelineInput,
  deps: SignupPipelineDeps,
): Promise<SignupPipelineResult> {
  const start = Date.now();
  const env = deps.env ?? process.env;
  const logger = deps.logger ?? console;
  const audit = emptyAudit(0);

  const normalizedEmail = input.email.trim().toLowerCase();

  // --- Step 1: admin override ---------------------------------------------
  const overrideEmails = parseOverrideEmails(env['SIGNUP_AUTO_APPROVE_OVERRIDE_EMAILS']);
  if (overrideEmails.has(normalizedEmail)) {
    audit.adminOverrideHit = true;
    audit.elapsedMs = Date.now() - start;
    return {
      outcome: { decision: 'approve', reason: 'admin_override' },
      audit,
    };
  }

  // --- Step 2: per-IP rate limit ------------------------------------------
  let countInWindow = 0;
  try {
    countInWindow = await countRecentSignupsFromIp(deps.privilegedSql, input.clientIp);
  } catch (err) {
    // Permissive fallback on DB error — never block legitimate users.
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'signup-pipeline: rate-limit DB query failed; defaulting to approve',
    );
    audit.elapsedMs = Date.now() - start;
    return {
      outcome: { decision: 'approve', reason: 'infra_failure_permissive' },
      audit,
    };
  }
  audit.rateLimitCountInWindow = countInWindow;
  if (countInWindow >= RATE_LIMIT_PER_IP_PER_HOUR) {
    audit.elapsedMs = Date.now() - start;
    return {
      outcome: { decision: 'deny', reason: 'rate_limit' },
      audit,
    };
  }

  // --- Step 3: email shape -------------------------------------------------
  const shapeOk = emailShapeOk(normalizedEmail);
  audit.emailShapeOk = shapeOk;
  if (!shapeOk) {
    audit.elapsedMs = Date.now() - start;
    return {
      outcome: { decision: 'deny', reason: 'email_shape' },
      audit,
    };
  }

  // --- Step 4: ABR lookup (informational only) -----------------------------
  // ABR_GUID may be unset (lookupAbrMatchingNames returns skipped: true).
  // Network / parse failures collapse to `matches: []` with `error` set.
  // Neither path blocks the pipeline — we just feed the result into Claude.
  let abrShaped: AbrMatchEntry[] = [];
  let abrLookupResult: AbrLookupResult | null = null;
  try {
    const lookup = deps.abrLookup ?? lookupAbrMatchingNames;
    abrLookupResult = await lookup(input.firmName);
    if (abrLookupResult.error) {
      logger.warn(
        { err: abrLookupResult.error },
        'signup-pipeline: ABR lookup returned an error; proceeding without ABR data',
      );
    } else if (abrLookupResult.skipped) {
      logger.warn(
        'signup-pipeline: ABR_GUID is unset; skipping ABR step (free to register at https://abr.business.gov.au/Tools/AbrXmlSearch)',
      );
    } else {
      logger.info(
        { matches: abrLookupResult.matches.length },
        'signup-pipeline: ABR lookup complete',
      );
    }
    abrShaped = shapeAbrMatches(abrLookupResult);
    audit.abrLookup = abrLookupResult.raw ?? null;
  } catch (err) {
    // Defensive — lookupAbrMatchingNames is designed not to throw, but if a
    // future test seam introduces a throw we still fall through.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'signup-pipeline: ABR lookup threw; proceeding without ABR data',
    );
  }

  // --- Step 5: Claude evaluator -------------------------------------------
  let evalOut: SignupEvaluatorOutput;
  try {
    evalOut = await deps.evaluator.evaluate({
      email: normalizedEmail,
      firm_name: input.firmName,
      display_name: input.displayName,
      abr_match: abrShaped,
    });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'signup-pipeline: Claude evaluator threw; defaulting to approve (permissive)',
    );
    audit.elapsedMs = Date.now() - start;
    return {
      outcome: { decision: 'approve', reason: 'infra_failure_permissive' },
      audit,
    };
  }

  audit.claudeConfidence = evalOut.confidence;
  audit.claudeDecision = evalOut.decision;
  audit.claudeRationale = evalOut.rationale;
  audit.claudeRedFlags = evalOut.red_flags;
  audit.classifierModel = evalOut.model;
  audit.promptVersion = evalOut.prompt_version;
  audit.tokensIn = evalOut.tokens_in;
  audit.tokensOut = evalOut.tokens_out;

  // --- Step 6: compose final decision -------------------------------------
  if (evalOut.decision === 'deny' && evalOut.confidence > CLAUDE_DENY_MIN_CONFIDENCE) {
    audit.elapsedMs = Date.now() - start;
    return {
      outcome: { decision: 'deny', reason: 'claude_deny' },
      audit,
    };
  }
  if (evalOut.decision === 'approve' && evalOut.confidence > CLAUDE_APPROVE_MIN_CONFIDENCE) {
    audit.elapsedMs = Date.now() - start;
    return {
      outcome: { decision: 'approve', reason: 'claude_approve' },
      audit,
    };
  }
  // Anything else — 'review', low-confidence approve, low-confidence deny —
  // resolves to APPROVE per the permissive bias.
  audit.elapsedMs = Date.now() - start;
  return {
    outcome: { decision: 'approve', reason: 'permissive_fallback' },
    audit,
  };
}
