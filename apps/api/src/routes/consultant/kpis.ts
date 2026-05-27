import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireSession } from '@cpa/auth';
import { sql } from '@cpa/db/client';
import { STATUS_TO_STAGES } from '@cpa/schemas';

/**
 * GET /v1/consultant/kpis?fy=FY26
 *
 * Returns the four KPI metrics rendered above-the-fold on the consultant
 * dashboard, plus YoY/period deltas that drive the trend lines.
 *
 * Tenant scoping comes from the session middleware (`app.current_tenant_id`
 * GUC) wrapped in sql.begin + set_config for cross-pool reliability,
 * matching the consultant-claims pattern.
 *
 * Definitions:
 *   - activeClaims: claims in STATUS_TO_STAGES.active stages for `fy`.
 *   - evidenceIndexed: count of evidence-kind events for the tenant in
 *     `fy`, joining event -> activity -> claim by activity_id.
 *   - atRisk: active claims with at least one activity missing a hypothesis.
 *   - chainCoveragePct: percentage of active claims with at least 1 chain
 *     block (event linked to one of the claim activities). Rounded int 0-100.
 *
 * Deltas:
 *   - activeClaimsVsLastFy: activeClaims(fy) - activeClaims(fy-1).
 *   - evidenceIndexedPctYoY: % change vs same metric last FY (rounded).
 *     null when prior FY has zero evidence (avoid divide-by-zero).
 *   - atRiskVsYesterday: requires a daily KPI snapshot table - not yet
 *     wired. Always null until that job ships. (See README parking lot.)
 *   - chainCoveragePtsYoY: integer percentage-point delta vs last FY.
 *     null when prior FY has no active claims (no meaningful baseline).
 */

const FyParam = z
  .union([z.coerce.number().int(), z.string()])
  .transform((v) => {
    if (typeof v === 'number') return v;
    const m = /^FY(\d{2}|\d{4})$/i.exec(v.trim());
    if (!m) return Number.NaN;
    const n = Number(m[1]);
    return n < 100 ? 2000 + n : n;
  })
  .pipe(z.number().int().min(2000).max(2100));

const ConsultantKpisQuery = z.object({
  fy: FyParam,
});

const ACTIVE_STAGES = STATUS_TO_STAGES['active'] as unknown as string[];

const EVIDENCE_KINDS_FOR_COUNT = [
  'HYPOTHESIS',
  'DESIGN',
  'EXPERIMENT',
  'OBSERVATION',
  'ITERATION',
  'NEW_KNOWLEDGE',
  'UNCERTAINTY',
  'TIME_LOG',
  'ASSOCIATE_FLAG',
  'EXPENDITURE_NOTE',
  'SUPPORTING',
  'INELIGIBLE',
  'EVIDENCE_UPLOADED',
  'ARTEFACT_LINKED',
] as const;

export interface ConsultantKpisResponse {
  activeClaims: number;
  evidenceIndexed: number;
  atRisk: number;
  chainCoveragePct: number;
  deltas: {
    activeClaimsVsLastFy: number | null;
    evidenceIndexedPctYoY: number | null;
    atRiskVsYesterday: number | null;
    chainCoveragePtsYoY: number | null;
  };
}

interface RawRow {
  active_claims: number;
  evidence_indexed: number;
  at_risk: number;
  claims_with_block: number;
}

async function loadKpisForFy(tx: typeof sql, fy: number): Promise<RawRow> {
  const rows = await tx<RawRow[]>`
    SELECT
      (
        SELECT COUNT(*)::int FROM claim c
         WHERE c.fiscal_year = ${fy}
           AND c.stage = ANY(${ACTIVE_STAGES})
      ) AS active_claims,
      (
        SELECT COUNT(*)::int
          FROM event e
          JOIN activity a ON a.id::text = e.payload->>'activity_id'
          JOIN claim c    ON c.id       = a.claim_id
         WHERE c.fiscal_year = ${fy}
           AND e.kind = ANY(${EVIDENCE_KINDS_FOR_COUNT})
      ) AS evidence_indexed,
      (
        SELECT COUNT(DISTINCT c.id)::int
          FROM claim c
          JOIN activity a ON a.claim_id = c.id
         WHERE c.fiscal_year = ${fy}
           AND c.stage = ANY(${ACTIVE_STAGES})
           AND (a.hypothesis IS NULL OR a.hypothesis = '')
      ) AS at_risk,
      (
        SELECT COUNT(DISTINCT c.id)::int FROM claim c
         WHERE c.fiscal_year = ${fy}
           AND c.stage = ANY(${ACTIVE_STAGES})
           AND EXISTS (
             SELECT 1
               FROM event e
               JOIN activity a ON a.id::text = e.payload->>'activity_id'
              WHERE a.claim_id = c.id
                 AND e.kind = ANY(${EVIDENCE_KINDS_FOR_COUNT})
           )
      ) AS claims_with_block
  `;
  return (
    rows[0] ?? {
      active_claims: 0,
      evidence_indexed: 0,
      at_risk: 0,
      claims_with_block: 0,
    }
  );
}

function pctIntOrNull(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 100);
}

function coveragePct(claimsWithBlock: number, activeClaims: number): number {
  if (activeClaims === 0) return 0;
  return Math.round((claimsWithBlock / activeClaims) * 100);
}

export function registerConsultantKpis(app: FastifyInstance): void {
  app.get('/v1/consultant/kpis', { preHandler: requireSession }, async (req, reply) => {
    const parsed = ConsultantKpisQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'invalid_query',
        message: 'Query must match { fy: <FYxx | int> }',
        requestId: req.id,
      });
    }
    const { fy } = parsed.data;
    const tenantId = req.user!.tenantId!;

    return await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;

      const current = await loadKpisForFy(tx as unknown as typeof sql, fy);
      const prior = await loadKpisForFy(tx as unknown as typeof sql, fy - 1);

      const coverageCurrent = coveragePct(current.claims_with_block, current.active_claims);
      const coveragePrior = coveragePct(prior.claims_with_block, prior.active_claims);

      const body: ConsultantKpisResponse = {
        activeClaims: current.active_claims,
        evidenceIndexed: current.evidence_indexed,
        atRisk: current.at_risk,
        chainCoveragePct: coverageCurrent,
        deltas: {
          activeClaimsVsLastFy: current.active_claims - prior.active_claims,
          evidenceIndexedPctYoY: pctIntOrNull(
            current.evidence_indexed - prior.evidence_indexed,
            prior.evidence_indexed,
          ),
          atRiskVsYesterday: null,
          chainCoveragePtsYoY: prior.active_claims === 0 ? null : coverageCurrent - coveragePrior,
        },
      };
      return reply.send(body);
    });
  });
}
