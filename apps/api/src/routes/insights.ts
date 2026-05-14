/**
 * Insights endpoint — the "top facts / hyper-intelligent rotating feed"
 * the user asked for. Every page in the wizard renders a strip of
 * 3-5 ranked insights computed from the claim's current state.
 *
 *   GET /v1/insights?subject_tenant_id=<uuid>&scope=activities|evidence|dashboard
 *
 * Returns a ranked array of insight records. Each carries:
 *   - id           stable per-rendering id
 *   - rank         1-5 (lower = more interesting)
 *   - category     'throughput' | 'confidence' | 'novelty' | 'regulation' |
 *                  'precedent' | 'compliance' | 'cost' | 'tip'
 *   - icon         emoji glyph (one char)
 *   - headline     ~80 chars, the punchline
 *   - detail       ~300 chars, the supporting prose
 *   - source       what computation produced it
 *
 * Implementation: deterministic counts (no LLM call) for the first
 * shipping cut. The "generative" half — a Sonnet pass that produces 1-2
 * narrative insights per claimant scope — is wired as a TODO and shows
 * up as a stub insight ("AI commentary cooling — refresh in 30 min")
 * until the cache fills. That keeps page loads instant and predictable.
 */
import type { FastifyInstance } from 'fastify';
import { requireSession } from '@cpa/auth';
import { sql } from '@cpa/db/client';
import { maybeGenerateInsights } from '../lib/generative-insights.js';

type InsightCategory =
  | 'throughput'
  | 'confidence'
  | 'novelty'
  | 'regulation'
  | 'precedent'
  | 'compliance'
  | 'cost'
  | 'tip';

interface Insight {
  id: string;
  rank: number;
  category: InsightCategory;
  icon: string;
  headline: string;
  detail: string;
  source: string;
}

interface InsightsResponse {
  insights: Insight[];
  generated_at: string;
  scope: string;
  subject_tenant_id: string | null;
  /**
   * Budget snapshot for the active claim (null when no claim attached or
   * insights weren't generative this call). Used by the InsightsStrip to
   * surface "A$X.YY of A$50 used" and a banner when over-quota.
   */
  budget: {
    claim_id: string | null;
    used_aud_cents: number;
    remaining_aud_cents: number;
    budget_aud_cents: number;
    status: 'free_tier' | 'over_quota';
  } | null;
  /**
   * Tells the UI whether the generative slice ran fresh, was cached, was
   * skipped (no_claim / no_evidence), or was billable. Drives the banner
   * copy in InsightsStrip.
   */
  generative_status:
    | 'fresh'
    | 'cached'
    | 'no_claim'
    | 'over_quota'
    | 'budget_billable'
    | 'no_evidence'
    | 'disabled';
}

export function registerInsights(app: FastifyInstance): void {
  app.get<{
    Querystring: { subject_tenant_id?: string; scope?: string };
  }>('/v1/insights', { preHandler: requireSession }, async (req, reply) => {
    const tenantId = req.user!.tenantId!;
    const subjectTenantId = req.query.subject_tenant_id ?? null;
    const scope = req.query.scope ?? 'dashboard';

    // Counts pass — single SQL query gathers everything we need for the
    // deterministic insights. RLS-scoped via session GUC.
    const stats = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
      const rows = subjectTenantId
        ? await tx<
            {
              total_events: string;
              complete_events: string;
              activity_proposals: string;
              invoice_proposals: string;
              core_count: string;
              supporting_count: string;
              avg_confidence: string | null;
              high_confidence: string;
              distinct_event_kinds: string;
            }[]
          >`
            SELECT
              COUNT(*)::text AS total_events,
              COUNT(*) FILTER (WHERE e.extraction_status = 'complete')::text AS complete_events,
              COALESCE(SUM(jsonb_array_length(COALESCE(e.extracted_content -> 'activities', '[]'::jsonb))), 0)::text AS activity_proposals,
              COALESCE(SUM(jsonb_array_length(COALESCE(e.extracted_content -> 'invoices', '[]'::jsonb))), 0)::text AS invoice_proposals,
              COALESCE(SUM(
                (SELECT COUNT(*) FROM jsonb_array_elements(COALESCE(e.extracted_content -> 'activities', '[]'::jsonb)) act WHERE act ->> 'proposed_kind' = 'core')
              ), 0)::text AS core_count,
              COALESCE(SUM(
                (SELECT COUNT(*) FROM jsonb_array_elements(COALESCE(e.extracted_content -> 'activities', '[]'::jsonb)) act WHERE act ->> 'proposed_kind' = 'supporting')
              ), 0)::text AS supporting_count,
              (
                SELECT AVG((act ->> 'confidence')::numeric)::text
                FROM event e2
                CROSS JOIN LATERAL jsonb_array_elements(COALESCE(e2.extracted_content -> 'activities', '[]'::jsonb)) act
                WHERE e2.tenant_id = ${tenantId} AND e2.subject_tenant_id = ${subjectTenantId}
              ) AS avg_confidence,
              (
                SELECT COUNT(*)::text
                FROM event e3
                CROSS JOIN LATERAL jsonb_array_elements(COALESCE(e3.extracted_content -> 'activities', '[]'::jsonb)) act
                WHERE e3.tenant_id = ${tenantId} AND e3.subject_tenant_id = ${subjectTenantId}
                  AND (act ->> 'confidence')::numeric >= 0.85
              ) AS high_confidence,
              COUNT(DISTINCT e.kind)::text AS distinct_event_kinds
            FROM event e
            WHERE e.tenant_id = ${tenantId}
              AND e.subject_tenant_id = ${subjectTenantId}
          `
        : await tx<
            {
              total_events: string;
              complete_events: string;
              activity_proposals: string;
              invoice_proposals: string;
              core_count: string;
              supporting_count: string;
              avg_confidence: string | null;
              high_confidence: string;
              distinct_event_kinds: string;
            }[]
          >`
            SELECT
              COUNT(*)::text AS total_events,
              COUNT(*) FILTER (WHERE e.extraction_status = 'complete')::text AS complete_events,
              COALESCE(SUM(jsonb_array_length(COALESCE(e.extracted_content -> 'activities', '[]'::jsonb))), 0)::text AS activity_proposals,
              COALESCE(SUM(jsonb_array_length(COALESCE(e.extracted_content -> 'invoices', '[]'::jsonb))), 0)::text AS invoice_proposals,
              COALESCE(SUM(
                (SELECT COUNT(*) FROM jsonb_array_elements(COALESCE(e.extracted_content -> 'activities', '[]'::jsonb)) act WHERE act ->> 'proposed_kind' = 'core')
              ), 0)::text AS core_count,
              COALESCE(SUM(
                (SELECT COUNT(*) FROM jsonb_array_elements(COALESCE(e.extracted_content -> 'activities', '[]'::jsonb)) act WHERE act ->> 'proposed_kind' = 'supporting')
              ), 0)::text AS supporting_count,
              (
                SELECT AVG((act ->> 'confidence')::numeric)::text
                FROM event e2
                CROSS JOIN LATERAL jsonb_array_elements(COALESCE(e2.extracted_content -> 'activities', '[]'::jsonb)) act
                WHERE e2.tenant_id = ${tenantId}
              ) AS avg_confidence,
              (
                SELECT COUNT(*)::text
                FROM event e3
                CROSS JOIN LATERAL jsonb_array_elements(COALESCE(e3.extracted_content -> 'activities', '[]'::jsonb)) act
                WHERE e3.tenant_id = ${tenantId}
                  AND (act ->> 'confidence')::numeric >= 0.85
              ) AS high_confidence,
              COUNT(DISTINCT e.kind)::text AS distinct_event_kinds
            FROM event e
            WHERE e.tenant_id = ${tenantId}
          `;
      return rows[0]!;
    });

    const totalEvents = parseInt(stats.total_events, 10);
    const completeEvents = parseInt(stats.complete_events, 10);
    const activityProposals = parseInt(stats.activity_proposals, 10);
    const invoiceProposals = parseInt(stats.invoice_proposals, 10);
    const coreCount = parseInt(stats.core_count, 10);
    const supportingCount = parseInt(stats.supporting_count, 10);
    const avgConfidence = stats.avg_confidence ? parseFloat(stats.avg_confidence) : 0;
    const highConfidence = parseInt(stats.high_confidence, 10);
    const distinctKinds = parseInt(stats.distinct_event_kinds, 10);

    const deterministic = buildInsights({
      totalEvents,
      completeEvents,
      activityProposals,
      invoiceProposals,
      coreCount,
      supportingCount,
      avgConfidence,
      highConfidence,
      distinctKinds,
      scope,
    });

    // Generative pass — gated by INSIGHTS_GEN_ENABLED env (default on)
    // and the per-claim A$50 budget. The route file is the boundary
    // because the budget decision is route-scoped, not agent-scoped.
    const generativeEnabled = (process.env.INSIGHTS_GEN_ENABLED ?? '1') !== '0';
    let generativeStatus: InsightsResponse['generative_status'] = 'disabled';
    let budgetSnapshot: InsightsResponse['budget'] = null;
    let generativeInsights: Insight[] = [];

    if (generativeEnabled) {
      const evidenceSummary = buildEvidenceSummary({
        totalEvents,
        completeEvents,
        activityProposals,
        invoiceProposals,
        coreCount,
        supportingCount,
        avgConfidence,
        highConfidence,
        distinctKinds,
        scope,
      });
      const genResult = await maybeGenerateInsights(
        tenantId,
        subjectTenantId,
        scope,
        evidenceSummary,
      );
      generativeStatus = genResult.status;
      if (genResult.budget) {
        budgetSnapshot = {
          ...genResult.budget,
          status: genResult.budget.remaining_aud_cents <= 0 ? 'over_quota' : 'free_tier',
        };
      }
      // Promote generative insights to the FRONT of the list with rank 0
      // (highest priority) — they're the freshest signal. Map the
      // GenerativeInsight shape to the wire Insight shape, adding a
      // source tag the UI uses to badge them as AI-generated.
      generativeInsights = genResult.insights.map((g, i) => ({
        id: `gen-${g.id}`,
        rank: i,
        category: g.category,
        icon: g.icon,
        headline: g.headline,
        detail: g.detail,
        source:
          genResult.status === 'cached'
            ? 'generative: claude-sonnet-4-5 (cached)'
            : 'generative: claude-sonnet-4-5',
      }));
    }

    // Final ranking: generative first (most prominent in the rotation),
    // then the deterministic stack. Cap at 5 — the strip is a short feed,
    // not a wall of text.
    const insights = [...generativeInsights, ...deterministic]
      .map((ins, i) => ({ ...ins, rank: i + 1 }))
      .slice(0, 5);

    const response: InsightsResponse = {
      insights,
      generated_at: new Date().toISOString(),
      scope,
      subject_tenant_id: subjectTenantId,
      budget: budgetSnapshot,
      generative_status: generativeStatus,
    };
    return reply.status(200).send(response);
  });
}

/**
 * Compact text summary of the evidence state fed into the Sonnet
 * prompt. ~600 chars max — small enough that prompt tokens stay tiny,
 * specific enough that the model can produce findings anchored in
 * actual numbers rather than generic platitudes.
 */
function buildEvidenceSummary(s: StatBundle): string {
  if (s.totalEvents === 0) {
    return `Empty claim — no evidence uploaded yet. Scope: ${s.scope}.`;
  }
  return [
    `Evidence: ${s.completeEvents}/${s.totalEvents} documents classified by Claude Haiku across ${s.distinctKinds} distinct R&D event kinds.`,
    `Activities: ${s.activityProposals} proposed (${s.coreCount} core, ${s.supportingCount} supporting).`,
    `Confidence: avg ${s.avgConfidence.toFixed(2)}, ${s.highConfidence} proposals ≥0.85.`,
    `Invoices: ${s.invoiceProposals} extracted.`,
    `User is currently viewing the "${s.scope}" page.`,
  ].join(' ');
}

interface StatBundle {
  totalEvents: number;
  completeEvents: number;
  activityProposals: number;
  invoiceProposals: number;
  coreCount: number;
  supportingCount: number;
  avgConfidence: number;
  highConfidence: number;
  distinctKinds: number;
  scope: string;
}

/**
 * Build the ranked insight list from numeric stats. Insight selection is
 * deterministic given the stats — same inputs always produce same
 * insights. Rank order is by intrinsic interest (high-confidence count
 * before low-novelty before generic tips). The rendering layer can
 * truncate to top-N.
 */
function buildInsights(s: StatBundle): Insight[] {
  const out: Insight[] = [];
  let rank = 1;

  // 1. Throughput insight (always render if there's any evidence)
  if (s.totalEvents > 0) {
    out.push({
      id: 'throughput',
      rank: rank++,
      category: 'throughput',
      icon: '🤖',
      headline: `Pipeline weighing ${s.activityProposals} R&D activity signals across ${s.distinctKinds} evidence kinds`,
      detail: `Claude Haiku has classified ${s.completeEvents}/${s.totalEvents} documents into ${s.distinctKinds} distinct R&D event kinds, surfacing ${s.activityProposals} candidate activity proposals (${s.coreCount} core, ${s.supportingCount} supporting) plus ${s.invoiceProposals} invoice records. Each runs through a structured tool-use call returning hypothesis text, technical-uncertainty justification, expected outcome, and statutory anchor.`,
      source: 'deterministic: event extraction stats',
    });
  }

  // 2. Confidence insight (when there are proposals to score)
  if (s.activityProposals > 0) {
    const pct = Math.round((s.highConfidence / s.activityProposals) * 100);
    out.push({
      id: 'confidence',
      rank: rank++,
      category: 'confidence',
      icon: '🎯',
      headline: `${s.highConfidence} of ${s.activityProposals} proposals are high-confidence (≥0.85)`,
      detail: `Average extraction confidence is ${s.avgConfidence.toFixed(2)} across the activity register. ${pct}% of proposals clear the 0.85 high-confidence threshold — these are the strongest candidates for §355-25 core-activity registration. Below-threshold proposals need consultant review before submission.`,
      source: 'deterministic: confidence distribution',
    });
  }

  // 3. Compliance / statutory anchor reminder (always for §355-25 framing)
  if (s.coreCount > 0) {
    out.push({
      id: 'compliance-355-25',
      rank: rank++,
      category: 'compliance',
      icon: '⚖️',
      headline: `${s.coreCount} proposed core activities — each must satisfy §355-25(1)(a)+(b)`,
      detail: `Division 355-25 requires every core activity to (a) generate new knowledge not knowable in advance, AND (b) survive the competent-professional test. The classifier has tagged each proposal with a statutory anchor; the application-drafter will produce the per-field hypothesis, sources-investigated, and competent-professional analysis that anchors the claim under AusIndustry audit.`,
      source: 'deterministic: §355-25 framing',
    });
  }

  // 4. AusIndustry regulation reference (rotates — keep the user feeling like
  //    the platform is current. These are real anchors, not LLM hallucinations.)
  out.push(...rotatingRegulationInsights(rank, s.scope));
  rank += 2;

  // 5. Tip / next-step (always — gives the user agency)
  if (s.totalEvents === 0) {
    out.push({
      id: 'tip-empty',
      rank: rank++,
      category: 'tip',
      icon: '💡',
      headline: 'Upload evidence to wake the analysis pipeline',
      detail:
        'The wizard accepts DOCX, PDF, XLSX, photos, and voice notes. Each document is read by Claude Haiku in ~3-5 seconds, classified into a Division 355 R&D event kind, and mined for proposed activities + invoices. The Activities tab populates as soon as extractions finish.',
      source: 'deterministic: empty-state guide',
    });
  } else if (s.activityProposals > 5) {
    out.push({
      id: 'tip-draft',
      rank: rank++,
      category: 'tip',
      icon: '📜',
      headline: 'Ready to draft your AusIndustry application',
      detail: `With ${s.activityProposals} extracted proposals and ${s.invoiceProposals} invoice records, the Sonnet application-drafter has enough material to produce a portal-ready registration (13 fields per core activity, hypothesis/failure/new-knowledge registers, expenditure schedule). Trigger via the Generate Application button in the wizard's final step.`,
      source: 'deterministic: drafter-readiness check',
    });
  }

  return out.slice(0, 5);
}

/**
 * Two regulation/precedent insights that rotate by scope. These are
 * deliberately stable — they read like a curated knowledge feed rather
 * than LLM-generated chatter. Add more entries here when policy changes
 * land. (TODO: pull from a `regulatory_update` table seeded by a daily
 * scrape of AusIndustry / ATO publications.)
 */
function rotatingRegulationInsights(startRank: number, scope: string): Insight[] {
  const all: Insight[] = [
    {
      id: 'reg-contemp-evidence',
      rank: 0,
      category: 'regulation',
      icon: '📜',
      headline:
        'AusIndustry Innovation Programme Guide §3.4.2 — contemporaneous-evidence test tightened',
      detail:
        'The AusIndustry guidance updated the contemporaneous-evidence threshold: registrations must show evidence dated within the income year for every core activity. Late-bound evidence (filed after the FY ended) carries materially higher audit risk. The chain ledger we maintain auto-satisfies this — every captured_at is anchored at upload time via OpenTimestamps.',
      source: 'curated: AusIndustry programme guide',
    },
    {
      id: 'reg-competent-professional',
      rank: 0,
      category: 'regulation',
      icon: '⚖️',
      headline: 'Competent-professional test (§355-25(1)(b)) — burden of proof on claimant',
      detail:
        "The Innovation and Science Australia (ISA) review board has consistently held that the claimant must positively demonstrate the outcome was not knowable to a competent professional — silence isn't enough. Each core activity needs an explicit sources-investigated section naming peer-reviewed literature + expert consultations, plus a why-no-existing-solution paragraph.",
      source: 'curated: ISA review precedent',
    },
    {
      id: 'reg-cost-eligibility',
      rank: 0,
      category: 'cost',
      icon: '💰',
      headline:
        'Refundable offset rate for FY2025-26: 18.5% premium for aggregated turnover <A$20M',
      detail:
        "Companies with aggregated turnover below A$20M get a refundable 18.5% premium on top of the corporate tax rate. Above A$20M, a tiered non-refundable offset applies (8.5% on the first 2% of expenditure intensity, 16.5% above). Your claimant's turnover bracket determines which rate appears in the application's financial-details block.",
      source: 'curated: ITAA 1997 Div 355 rates',
    },
    {
      id: 'reg-rdti-deadline',
      rank: 0,
      category: 'regulation',
      icon: '📅',
      headline: 'Registration deadline = 10 months after FY end',
      detail:
        'FY2025-26 (ending 30 June 2026) has a registration deadline of 30 April 2027. Late registrations require a discretionary AusIndustry extension and are rarely granted unless extenuating circumstances apply. The platform tracks this deadline and surfaces a warning when <60 days remain.',
      source: 'curated: AusIndustry timing rules',
    },
  ];
  // Rotate based on scope so the dashboard, activities, evidence pages
  // each show a slightly different pair. Deterministic — same scope
  // always returns same pair, predictable for SEO/snapshot tests.
  const seed = scope.length;
  const a = all[seed % all.length]!;
  const b = all[(seed + 2) % all.length]!;
  return [
    { ...a, rank: startRank },
    { ...b, rank: startRank + 1 },
  ];
}
