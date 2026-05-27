/**
 * Generative-insights module — the "top facts" feed's Sonnet half.
 *
 * Design intent (per user direction):
 *   - Generative insights up to a per-claim A$50 free-tier envelope.
 *   - Above that, the call is recorded as 'billable' (cost + 50% markup)
 *     against the consultant's account.
 *   - "Continuous insights means the system is being tested rather than
 *     used to create a claim" — so the budget gate is a cost-discipline
 *     mechanism, not a hard refusal.
 *
 * Architecture choices (worth keeping):
 *
 * 1. INSIGHTS ARE SUBJECT-TENANT SCOPED, BUDGET IS CLAIM-SCOPED.
 *    We pick the most recent in-progress claim for the subject_tenant
 *    to attribute the spend against. If no claim exists, we bail to
 *    deterministic-only (no envelope to draw from).
 *
 * 2. TTL CACHE IS MANDATORY.
 *    InsightsStrip polls every 60s. A Sonnet call per poll burns
 *    ~$0.05 * 60 = $3/hour just from leaving a tab open. The
 *    in-memory cache (keyed by tenant/subject/scope, 30-min TTL) is
 *    the difference between "billable" and "ruinous". If we ever
 *    scale to multi-instance, replace with a Redis or pg-jsonb cache.
 *
 * 3. RECORDED EVEN WHEN FREE.
 *    The ledger row gets the base cost in cost_aud_cents even when
 *    status='free_tier'. This lets us see how much the free tier
 *    actually costs us as a business cost line.
 */

import {
  callWithToolUse,
  getAnthropicClient,
  getClaimBudgetStatus,
  recordUsage,
  type TaggedSql,
} from '@cpa/agents';
import { privilegedSql } from '@cpa/db/client';
import { z } from 'zod';

const GEN_MODEL = process.env.INSIGHTS_GEN_MODEL ?? 'claude-sonnet-4-5';
const GEN_MAX_TOKENS = 1500;

/** TTL for cached generative insights, in milliseconds. 30 minutes. */
const CACHE_TTL_MS = 30 * 60 * 1000;

export type GenerativeInsight = {
  id: string;
  category: 'novelty' | 'precedent' | 'compliance' | 'cost' | 'tip';
  icon: string;
  headline: string;
  detail: string;
};

export type GenerativeInsightsResult = {
  insights: GenerativeInsight[];
  /** What happened — visible to the route so it can return a "you're over quota" banner. */
  status: 'fresh' | 'cached' | 'no_claim' | 'over_quota' | 'budget_billable' | 'no_evidence';
  /** Budget snapshot at the time of the decision (for UI banner). */
  budget: {
    claim_id: string | null;
    used_aud_cents: number;
    remaining_aud_cents: number;
    budget_aud_cents: number;
  } | null;
  /** When this batch was generated (or last cached). */
  generated_at: string;
};

// --- in-memory cache ---------------------------------------------------------
//
// One row per (tenant_id, subject_tenant_id, scope) tuple. Survives the
// process lifetime; restarts blow it away (which is fine — fresh insights
// next poll, costs one Sonnet call). Multi-instance deploys will get
// cache misses across pods; revisit if/when we run >1 API replica.

type CacheKey = string;
type CacheEntry = { result: GenerativeInsightsResult; expiresAt: number };
const cache = new Map<CacheKey, CacheEntry>();

function cacheKey(tenantId: string, subjectTenantId: string | null, scope: string): CacheKey {
  return `${tenantId}::${subjectTenantId ?? '-'}::${scope}`;
}

// --- public surface ----------------------------------------------------------

/**
 * Try to produce generative insights for a subject_tenant + scope.
 *
 * Decision tree:
 *   - Cache hit (fresh) → return cached, status='cached'
 *   - No active claim for subject_tenant → status='no_claim' (caller falls back to deterministic)
 *   - Claim exists, budget free_tier → run Sonnet, ledger as free_tier, cache
 *   - Claim exists, budget over_quota → run Sonnet, ledger as billable, cache
 *     (per user direction: don't refuse, just bill)
 *
 * Errors from the Sonnet call are SWALLOWED — they translate to an
 * empty insight array. The deterministic insights from the route file
 * keep the strip populated.
 */
export async function maybeGenerateInsights(
  tenantId: string,
  subjectTenantId: string | null,
  scope: string,
  evidenceSummary: string,
): Promise<GenerativeInsightsResult> {
  const key = cacheKey(tenantId, subjectTenantId, scope);
  const now = Date.now();

  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    return { ...cached.result, status: 'cached' };
  }

  // No subject_tenant_id means a tenant-wide dashboard view — no specific
  // claim to ledger against. Return empty generative insights; deterministic
  // ones still show.
  if (!subjectTenantId) {
    return emptyResult('no_claim');
  }

  // Find the most recent in-progress claim for this subject_tenant.
  // ('submitted'/'audit_defence' claims are post-submission and shouldn't
  // accrue more insight spend.)
  const claimRows = await privilegedSql<{ id: string }[]>`
    SELECT id::text
      FROM claim
     WHERE tenant_id         = ${tenantId}
       AND subject_tenant_id = ${subjectTenantId}
       AND stage NOT IN ('submitted', 'audit_defence')
     ORDER BY fiscal_year DESC, created_at DESC
     LIMIT 1
  `;
  const claimId = claimRows[0]?.id ?? null;
  if (!claimId) {
    return emptyResult('no_claim');
  }

  // Pre-flight budget. Records the decision but does NOT short-circuit
  // generation — over-quota just means the call gets billed.
  const budget = await getClaimBudgetStatus(privilegedSql as unknown as TaggedSql, claimId);
  const overQuota = budget.status === 'over_quota';

  // If no evidence has been classified yet, there's nothing to be
  // generative about. Skip the Sonnet call and return empty.
  if (evidenceSummary.trim().length < 80) {
    return {
      insights: [],
      status: 'no_evidence',
      budget: {
        claim_id: claimId,
        used_aud_cents: budget.used_aud_cents,
        remaining_aud_cents: budget.remaining_aud_cents,
        budget_aud_cents: budget.budget_aud_cents,
      },
      generated_at: new Date().toISOString(),
    };
  }

  // Run Sonnet. Failures are non-fatal — the deterministic strip keeps
  // the page populated; we log loudly so ops can investigate.
  let generated: GenerativeInsight[] = [];
  let usage: { tokens_in: number; tokens_out: number } | null = null;
  try {
    const result = await runInsightSonnet(scope, evidenceSummary);
    generated = result.insights;
    usage = { tokens_in: result.tokens_in, tokens_out: result.tokens_out };
  } catch (err) {
    console.error(
      '[generative-insights] sonnet call failed (non-fatal):',
      err instanceof Error ? err.message : String(err),
    );
  }

  // Ledger the spend. recordUsage decides free_tier vs billable from
  // the pre-call total, not from our pre-flight read (avoid TOCTOU on
  // concurrent insight requests).
  if (usage) {
    try {
      await recordUsage(privilegedSql as unknown as TaggedSql, {
        tenant_id: tenantId,
        claim_id: claimId,
        subject_tenant_id: subjectTenantId,
        agent_name: 'insights-generator',
        model: GEN_MODEL,
        tokens_in: usage.tokens_in,
        tokens_out: usage.tokens_out,
      });
    } catch (err) {
      console.error(
        '[generative-insights] ledger insert failed (non-fatal):',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const result: GenerativeInsightsResult = {
    insights: generated,
    status: overQuota ? 'budget_billable' : 'fresh',
    budget: {
      claim_id: claimId,
      used_aud_cents: budget.used_aud_cents,
      remaining_aud_cents: budget.remaining_aud_cents,
      budget_aud_cents: budget.budget_aud_cents,
    },
    generated_at: new Date().toISOString(),
  };

  cache.set(key, { result, expiresAt: now + CACHE_TTL_MS });
  return result;
}

/** Wipe the cache for tests / forced refresh. */
export function clearGenerativeInsightsCache(): void {
  cache.clear();
}

// --- internals ---------------------------------------------------------------

function emptyResult(status: GenerativeInsightsResult['status']): GenerativeInsightsResult {
  return {
    insights: [],
    status,
    budget: null,
    generated_at: new Date().toISOString(),
  };
}

const InsightToolOutput = z.object({
  insights: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        category: z.enum(['novelty', 'precedent', 'compliance', 'cost', 'tip']),
        icon: z.string().min(1).max(8),
        headline: z.string().min(10).max(140),
        detail: z.string().min(40).max(600),
      }),
    )
    .min(1)
    .max(2),
});

async function runInsightSonnet(
  scope: string,
  evidenceSummary: string,
): Promise<{ insights: GenerativeInsight[]; tokens_in: number; tokens_out: number }> {
  const system = [
    'You are a senior R&D Tax Incentive consultant generating insights for an ArchiveOne user.',
    'Produce 1–2 sharp, specific insights about the current state of their claim evidence.',
    'Anchor every insight in Australian Div 355 statute, ISA review precedent, or AusIndustry portal guidance.',
    'Avoid generic platitudes; reference SPECIFIC numbers, kinds, or activities from the evidence summary below.',
    'If the evidence is thin, lean into a tip or precedent rather than fabricating a finding.',
    `Current page scope: ${scope}. Tailor headlines accordingly (dashboard = strategic, activities = activity-quality, evidence = evidence-quality).`,
  ].join('\n');

  const user = [
    '# Evidence summary',
    evidenceSummary,
    '',
    '# Task',
    'Emit 1–2 ranked insights via the `emit_insights` tool. Each insight should:',
    '  - Have a stable, unique id like "novelty-haystack-sigma" or "precedent-isa-2023-04"',
    '  - Pick the most-fitting category',
    '  - Use a single relevant emoji icon (💡 🎯 📜 ⚖️ 🧠 🔬 📊 💰)',
    '  - Have a headline under 140 chars, plain prose, no markdown',
    '  - Have a detail field 40–600 chars explaining the finding with specifics',
  ].join('\n');

  const tool = {
    name: 'emit_insights',
    description: 'Emit 1–2 generative insights about the current claim evidence.',
    input_schema: InsightToolOutput,
  };

  const { output, tokens_in, tokens_out } = await callWithToolUse(getAnthropicClient(), {
    model: GEN_MODEL,
    system,
    user,
    tool,
    max_tokens: GEN_MAX_TOKENS,
  });
  return { insights: output.insights, tokens_in, tokens_out };
}
