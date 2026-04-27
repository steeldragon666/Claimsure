/**
 * Audit-readiness scoring types (D1).
 *
 * The score is the headline number on the PWA `/claimant/[id]/score`
 * dashboard. It runs 10 rules against the per-claimant `subject_tenant_id`
 * subgraph (events, time entries, signing, integration_connection) and
 * returns a 0-100 total + per-rule breakdown.
 *
 * Each rule is an async function so it can hit the DB; the `ScoreInput`
 * carries the optional `sql_client` so tests can inject a postgres-js-style
 * mock template-tag without the package taking a hard dependency on a real
 * DB during unit tests.
 */

/**
 * Postgres-js compatible template-tag client. Mirrors the subset of the
 * `postgres` library surface that the rules use — a callable that accepts
 * a TemplateStringsArray + interpolated values and returns a result array.
 *
 * Strict over `unknown[]` (not `any[]`) so callers and mocks both have to
 * be honest about what they hand back. Each rule casts the result row to
 * the shape it expects on the very next line.
 */
export type SqlClient = <Row>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<Row[]>;

export type ScoreInput = {
  tenant_id: string;
  subject_tenant_id: string;
  /**
   * Optional sql client — defaults to `privilegedSql` from `@cpa/db/client`
   * when omitted. Tests inject a mock so the rules can run without a real
   * DB. The recompute job (D3) supplies `privilegedSql` explicitly so the
   * cron worker doesn't depend on having a tenant GUC set.
   */
  sql_client?: SqlClient;
};

export type ScoreRuleResult = {
  earned: number;
  details?: string;
};

export type ScoreRule = {
  /** Stable identifier; mirrored into `audit_score_snapshot.rule_breakdown`. */
  id: string;
  /** Human-readable label shown on the PWA dashboard. */
  label: string;
  /** Cap on points earned for this rule (sum across rules = 100). */
  max_pts: number;
  fn: (input: ScoreInput) => Promise<ScoreRuleResult>;
};

export type ScoreRuleBreakdown = {
  id: string;
  label: string;
  earned: number;
  max: number;
  details?: string;
};

export type ScoreResult = {
  total_pts: number;
  max_pts: number;
  rule_breakdown: ScoreRuleBreakdown[];
  computed_at: Date;
};
