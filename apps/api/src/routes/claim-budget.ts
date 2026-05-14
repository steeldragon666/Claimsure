/**
 * GET /v1/claims/:id/budget
 *
 * Returns the live A$50-free-tier budget status for one claim, plus a
 * per-agent breakdown of where the spend went. Used by:
 *   - Wizard step 5 (Generate Application) to show a pre-flight warning
 *     when the claim is close to or past the envelope.
 *   - InsightsStrip (already gets a budget snapshot via /v1/insights,
 *     but this endpoint is the source of truth for non-insight surfaces).
 *   - The eventual consultant-facing invoice page.
 *
 * Wire shape mirrors getClaimBudgetStatus + agent_breakdown:
 *   {
 *     claim_id: string,
 *     used_aud_cents: number,
 *     remaining_aud_cents: number,   // negative when over quota
 *     budget_aud_cents: number,      // A$50.00 default
 *     status: 'free_tier' | 'over_quota',
 *     call_count: number,
 *     billable_aud_cents: number,    // sum where status='billable'
 *     free_tier_aud_cents: number,   // sum where status='free_tier'
 *     agents: Array<{
 *       agent_name: string,
 *       call_count: number,
 *       total_aud_cents: number,
 *       last_called_at: string | null,
 *     }>,
 *   }
 *
 * Auth: requireSession (consultant viewing their own firm's claim).
 *
 * RLS: tenant-scoped read via the app.current_tenant_id GUC. The query
 * filters on (claim_id, tenant_id) explicitly too — defence in depth in
 * case a future migration weakens the RLS policy.
 */
import type { FastifyInstance } from 'fastify';
import { requireSession } from '@cpa/auth';
import { sql } from '@cpa/db/client';
import { DEFAULT_CLAIM_BUDGET_AUD_CENTS } from '@cpa/agents';

interface BudgetResponse {
  claim_id: string;
  used_aud_cents: number;
  remaining_aud_cents: number;
  budget_aud_cents: number;
  status: 'free_tier' | 'over_quota';
  call_count: number;
  billable_aud_cents: number;
  free_tier_aud_cents: number;
  agents: Array<{
    agent_name: string;
    call_count: number;
    total_aud_cents: number;
    last_called_at: string | null;
  }>;
}

export function registerClaimBudget(app: FastifyInstance): void {
  app.get<{ Params: { id: string } }>(
    '/v1/claims/:id/budget',
    { preHandler: requireSession },
    async (req, reply) => {
      const { id: claimId } = req.params;
      const tenantId = req.user!.tenantId!;

      return await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;

        // 1. Confirm the claim is visible to this firm. RLS would also
        //    filter, but a 404 here lets the UI render a clear message
        //    instead of an empty-state confusing-zero budget panel.
        const claimRows = await tx<{ id: string }[]>`
          SELECT id::text FROM claim
           WHERE id        = ${claimId}
             AND tenant_id = ${tenantId}
        `;
        if (claimRows.length === 0) {
          return reply.status(404).send({
            error: 'claim_not_found',
            message: 'No claim with that id in this firm',
            requestId: req.id,
          });
        }

        // 2. Aggregate totals. We split by status so the UI can show
        //    "A$X.YY free-tier + A$Z.WW billable" if it wants the detail.
        //    'gifted' rows are excluded from billable/free buckets but
        //    DO count toward used_aud_cents — a gifted call is still
        //    using up the ledger slot.
        const sumRows = await tx<
          {
            used: string;
            calls: string;
            billable: string;
            free_tier: string;
          }[]
        >`
          SELECT COALESCE(SUM(cost_aud_cents), 0)::text                                        AS used,
                 COUNT(*)::text                                                                AS calls,
                 COALESCE(SUM(cost_aud_cents) FILTER (WHERE status = 'billable'),  0)::text   AS billable,
                 COALESCE(SUM(cost_aud_cents) FILTER (WHERE status = 'free_tier'), 0)::text   AS free_tier
            FROM llm_token_usage
           WHERE claim_id  = ${claimId}
             AND tenant_id = ${tenantId}
        `;
        const used = parseInt(sumRows[0]!.used, 10);
        const callCount = parseInt(sumRows[0]!.calls, 10);
        const billable = parseInt(sumRows[0]!.billable, 10);
        const freeTier = parseInt(sumRows[0]!.free_tier, 10);

        // 3. Per-agent breakdown — which agent burned how much. Ordered
        //    by spend desc so the biggest offender is at the top of the
        //    UI panel. last_called_at helps consultants spot stale spend
        //    from old runs.
        const agentRows = await tx<
          {
            agent_name: string;
            call_count: string;
            total_aud_cents: string;
            last_called_at: string | null;
          }[]
        >`
          SELECT agent_name,
                 COUNT(*)::text                       AS call_count,
                 SUM(cost_aud_cents)::text            AS total_aud_cents,
                 MAX(created_at)::text                AS last_called_at
            FROM llm_token_usage
           WHERE claim_id  = ${claimId}
             AND tenant_id = ${tenantId}
           GROUP BY agent_name
           ORDER BY SUM(cost_aud_cents) DESC, agent_name ASC
        `;

        const response: BudgetResponse = {
          claim_id: claimId,
          used_aud_cents: used,
          remaining_aud_cents: DEFAULT_CLAIM_BUDGET_AUD_CENTS - used,
          budget_aud_cents: DEFAULT_CLAIM_BUDGET_AUD_CENTS,
          status: used >= DEFAULT_CLAIM_BUDGET_AUD_CENTS ? 'over_quota' : 'free_tier',
          call_count: callCount,
          billable_aud_cents: billable,
          free_tier_aud_cents: freeTier,
          agents: agentRows.map((r) => ({
            agent_name: r.agent_name,
            call_count: parseInt(r.call_count, 10),
            total_aud_cents: parseInt(r.total_aud_cents, 10),
            last_called_at: r.last_called_at,
          })),
        };
        return reply.status(200).send(response);
      });
    },
  );
}
