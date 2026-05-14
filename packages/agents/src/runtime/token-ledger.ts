/**
 * Per-claim LLM token ledger + budget gate.
 *
 * BUSINESS POLICY (PR-author note — keep in sync with billing terms):
 *   - Each claim gets a default A$50 LLM-spend free tier.
 *   - Below quota: every call is `status = 'free_tier'`, cost_aud_cents is
 *     recorded at base rates for analytics but the consultant isn't billed.
 *   - Above quota: every call is `status = 'billable'`, cost_aud_cents is
 *     recorded at base × 1.5 (50% markup), and the consultant's monthly
 *     invoice rolls these up.
 *   - Continuous-insights/testing-loop usage naturally lands in the
 *     billable bucket; normal "draft my claim" usage stays in free tier.
 *
 * USD-to-AUD: 1 USD ≈ 1.55 AUD as of FY25/26; this is a constant for now
 * — bumped manually when the rate moves materially. The ledger records
 * cost_aud_cents at the rate-at-time-of-call so historical rows don't
 * shift retroactively.
 *
 * MODEL PRICING extends the existing `pricing.ts` MODEL_PRICING table —
 * add Opus + future models here in lockstep.
 */
import { computeCost, MODEL_PRICING } from './pricing.js';

/** USD → AUD conversion. Static for now; revisit quarterly. */
export const USD_TO_AUD = 1.55;

/** Markup applied to billable (over-quota) usage. 1.5 = cost + 50%. */
export const BILLABLE_MARKUP = 1.5;

/** Default per-claim free-tier ceiling in AUD cents (A$50.00 = 5000c). */
export const DEFAULT_CLAIM_BUDGET_AUD_CENTS = 5000;

export type UsageStatus = 'free_tier' | 'billable' | 'gifted';

export interface RecordedUsage {
  tenant_id: string;
  /** Claim the call should bill against; null = tenant-wide quota. */
  claim_id: string | null;
  /** Optional subject-tenant scope; informational only for now. */
  subject_tenant_id: string | null;
  agent_name: string;
  model: string;
  tokens_in: number;
  tokens_out: number;
}

export interface RecordedUsageResult {
  cost_usd: number;
  cost_aud_cents: number;
  status: UsageStatus;
  /** Sum of cost_aud_cents (including this call) for the claim. */
  claim_total_after_cents: number;
  /** Sum BEFORE this call — useful for "you just crossed the threshold" UX. */
  claim_total_before_cents: number;
  /** What's left of the free-tier budget AFTER this call. Can be negative. */
  remaining_aud_cents: number;
}

export interface ClaimBudgetStatus {
  claim_id: string;
  used_aud_cents: number;
  remaining_aud_cents: number;
  budget_aud_cents: number;
  status: 'free_tier' | 'over_quota';
  call_count: number;
}

/**
 * Compute the cost of a call in AUD cents at the rate-at-time-of-call.
 * Uses MODEL_PRICING from pricing.ts; multiplies by USD_TO_AUD; rounds
 * to integer cents.
 */
export function costAudCents(model: string, tokens_in: number, tokens_out: number): number {
  const usd = computeCost(model, tokens_in, tokens_out);
  return Math.round(usd * USD_TO_AUD * 100);
}

/**
 * Record an LLM call against the ledger AND decide whether it's free-tier
 * or billable. Returns the recorded cost + the claim's running total so
 * the caller can surface "you've used $X of your $50 budget" UI.
 *
 * sqlFn lets us inject the postgres-js tag function so this module
 * stays decoupled from any particular client (the agents package
 * doesn't directly import @cpa/db to keep the dependency graph simple).
 *
 * Pre-flight semantics: if `claim_total_before_cents` is already above
 * the budget, the call is recorded as 'billable' immediately. If it
 * straddles the threshold, the WHOLE call is billable (we don't split
 * a single API response across statuses).
 */
export async function recordUsage(
  sqlFn: TaggedSql,
  usage: RecordedUsage,
  opts: { budget_aud_cents?: number } = {},
): Promise<RecordedUsageResult> {
  const budget = opts.budget_aud_cents ?? DEFAULT_CLAIM_BUDGET_AUD_CENTS;

  // Compute base cost. If model isn't in MODEL_PRICING, returns 0 —
  // record-with-zero is by design (see pricing.ts), so the row exists
  // for forensic purposes and the gap surfaces via ops alerts.
  const baseUsd = computeCost(usage.model, usage.tokens_in, usage.tokens_out);
  const baseAudCents = Math.round(baseUsd * USD_TO_AUD * 100);

  // Sum existing usage for this claim BEFORE we insert. If no claim_id,
  // the budget gate is bypassed (tenant-wide quota; PR-future).
  let totalBefore = 0;
  if (usage.claim_id) {
    const rows = await sqlFn<{ total: string | null }[]>`
      SELECT COALESCE(SUM(cost_aud_cents), 0)::text AS total
        FROM llm_token_usage
       WHERE claim_id = ${usage.claim_id}
    `;
    totalBefore = parseInt(rows[0]?.total ?? '0', 10);
  }

  // Status + final cost — markup applies to the WHOLE call when over.
  const overQuota = totalBefore >= budget;
  const status: UsageStatus = overQuota ? 'billable' : 'free_tier';
  const finalAudCents = overQuota ? Math.round(baseAudCents * BILLABLE_MARKUP) : baseAudCents;

  // Insert the ledger row. Errors here MUST NOT fail the user-visible
  // request — the analyzer's tool-use response has already cost money;
  // dropping the ledger row just means slight under-billing, which is
  // acceptable. We log loudly so ops can backfill if needed.
  try {
    await sqlFn`
      INSERT INTO llm_token_usage (
        tenant_id, claim_id, subject_tenant_id,
        agent_name, model, tokens_in, tokens_out,
        cost_aud_cents, status
      ) VALUES (
        ${usage.tenant_id},
        ${usage.claim_id},
        ${usage.subject_tenant_id},
        ${usage.agent_name},
        ${usage.model},
        ${usage.tokens_in},
        ${usage.tokens_out},
        ${finalAudCents},
        ${status}
      )
    `;
  } catch (err) {
    console.error(
      '[token-ledger] failed to record usage (call already consumed tokens, ledger drift):',
      err instanceof Error ? err.message : String(err),
      { agent: usage.agent_name, model: usage.model, claim: usage.claim_id },
    );
  }

  const totalAfter = totalBefore + finalAudCents;
  return {
    cost_usd: baseUsd,
    cost_aud_cents: finalAudCents,
    status,
    claim_total_before_cents: totalBefore,
    claim_total_after_cents: totalAfter,
    remaining_aud_cents: budget - totalAfter,
  };
}

/**
 * Read-only budget status for a claim. Used by the pre-flight gate on
 * expensive agents (application-drafter, insights-generative) so the
 * caller can decide to proceed-and-bill, fall back to deterministic, or
 * refuse outright.
 */
export async function getClaimBudgetStatus(
  sqlFn: TaggedSql,
  claim_id: string,
  budget_aud_cents: number = DEFAULT_CLAIM_BUDGET_AUD_CENTS,
): Promise<ClaimBudgetStatus> {
  const rows = await sqlFn<{ total: string | null; n: string }[]>`
    SELECT COALESCE(SUM(cost_aud_cents), 0)::text AS total,
           COUNT(*)::text                          AS n
      FROM llm_token_usage
     WHERE claim_id = ${claim_id}
  `;
  const used = parseInt(rows[0]?.total ?? '0', 10);
  const callCount = parseInt(rows[0]?.n ?? '0', 10);
  return {
    claim_id,
    used_aud_cents: used,
    remaining_aud_cents: budget_aud_cents - used,
    budget_aud_cents,
    status: used >= budget_aud_cents ? 'over_quota' : 'free_tier',
    call_count: callCount,
  };
}

/**
 * Tagged-template SQL fn (postgres-js shape) without a hard dep on @cpa/db.
 *
 * The real postgres-js `Sql` type returns a `PendingQuery` (Promise +
 * helpers like `.values()`); this narrower shape captures only what the
 * ledger needs. Callers passing `privilegedSql` directly should cast via
 * `privilegedSql as unknown as TaggedSql` — the cast is the documented
 * escape hatch for postgres-js's complex generic helpers.
 */
export type TaggedSql = <T = unknown>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<T>;

/** Re-export so callers don't need a separate import for the pricing table. */
export { MODEL_PRICING };
