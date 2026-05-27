import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Signup-decision audit table — one row per autonomous signup attempt.
 *
 * Mirrors migration 0088 verbatim. This table is operator / forensic
 * only — the application role (cpa_app) has no grants. Writes happen via
 * privilegedSql inside the signup pipeline (the row exists BEFORE the
 * tenant in the approve case; the deny case has no tenant at all, so
 * tenant-scoped RLS isn't applicable).
 *
 * `decision` is the final outcome ('approve' | 'deny'), enforced by a SQL
 * CHECK constraint. `reason` records which gate produced it:
 *   - 'admin_override'             — email matched SIGNUP_AUTO_APPROVE_OVERRIDE_EMAILS
 *   - 'rate_limit'                 — > 5 signups per hour from this IP
 *   - 'email_shape'                — throwaway domain / invalid TLD
 *   - 'claude_approve'             — Claude decision=approve, confidence > 0.5
 *   - 'claude_deny'                — Claude decision=deny, confidence > 0.7
 *   - 'permissive_fallback'        — Claude returned 'review' or low-confidence;
 *                                    pipeline defaults to approve
 *   - 'infra_failure_permissive'   — ABR / Anthropic / DB rate-limit query
 *                                    failed; pipeline defaults to approve so
 *                                    legitimate users are not blocked
 *
 * The `abr_lookup` jsonb captures the full ABR MatchingNames response (null if
 * ABR_GUID was unset or the call failed). `claude_red_flags` captures the
 * string[] surfaced by the LLM. Both are jsonb so we can grep them post-hoc.
 *
 * `resulting_tenant_id` / `resulting_user_id` are non-null only on approve
 * (we create the rows in a single transaction, then write the audit row with
 * the IDs). They are uuid without FK because this table outlives both the
 * tenant and user — a deleted tenant must not orphan or cascade-delete its
 * approval audit row.
 */
export const signupDecision = pgTable('signup_decision', {
  id: uuid('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
  email: text('email').notNull(),
  firmName: text('firm_name').notNull(),
  displayName: text('display_name'),
  clientIp: text('client_ip'),
  userAgent: text('user_agent'),
  decision: text('decision', { enum: ['approve', 'deny'] }).notNull(),
  reason: text('reason').notNull(),
  adminOverrideHit: boolean('admin_override_hit').notNull().default(false),
  rateLimitCountInWindow: integer('rate_limit_count_in_window'),
  emailShapeOk: boolean('email_shape_ok'),
  abrLookup: jsonb('abr_lookup'),
  // numeric(4,3) — 0.000..1.000 inclusive. Postgres returns numeric as string;
  // callers should coerce explicitly if they need a number.
  claudeConfidence: numeric('claude_confidence', { precision: 4, scale: 3 }),
  claudeDecision: text('claude_decision'),
  claudeRationale: text('claude_rationale'),
  claudeRedFlags: jsonb('claude_red_flags'),
  resultingTenantId: uuid('resulting_tenant_id'),
  resultingUserId: uuid('resulting_user_id'),
  classifierModel: text('classifier_model'),
  promptVersion: text('prompt_version'),
  tokensIn: integer('tokens_in'),
  tokensOut: integer('tokens_out'),
  elapsedMs: integer('elapsed_ms'),
});

export type SignupDecisionRow = typeof signupDecision.$inferSelect;
export type SignupDecisionInsert = typeof signupDecision.$inferInsert;

/**
 * Canonical reason values. Kept as a const-tuple so a stray typo at a call
 * site fails TypeScript narrowing instead of surfacing as a runtime audit gap.
 */
export const SIGNUP_DECISION_REASONS = [
  'admin_override',
  'rate_limit',
  'email_shape',
  'claude_approve',
  'claude_deny',
  'permissive_fallback',
  'infra_failure_permissive',
] as const;
export type SignupDecisionReason = (typeof SIGNUP_DECISION_REASONS)[number];
