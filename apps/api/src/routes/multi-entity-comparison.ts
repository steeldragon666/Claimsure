import type { FastifyInstance } from 'fastify';
import { requireSession } from '@cpa/auth';
import { sql } from '@cpa/db/client';

/**
 * P7 Theme C Task C.4 — Multi-entity comparison endpoint.
 *
 * GET /v1/multi-entity-comparison/:activityId
 *
 * Returns a comparison grid of all activities in the same project as the
 * target activity, plus pairwise similarity scores from
 * `multi_entity_similarity_score` (p7d table). When the p7d table doesn't
 * exist (pre-p7d state), returns `similarity_available: false` and an
 * empty scores array — the UI renders "No similarity scans yet" empty state.
 *
 * Uses `to_regclass('multi_entity_similarity_score')` to detect table
 * existence without errors (per C.4 design constraint).
 */

interface ComparisonActivity {
  id: string;
  title: string;
  code: string;
  kind: string;
}

interface SimilarityScore {
  activity_a_id: string;
  activity_b_id: string;
  score: number;
}

export function registerMultiEntityComparison(app: FastifyInstance): void {
  app.get<{ Params: { activityId: string } }>(
    '/v1/multi-entity-comparison/:activityId',
    { preHandler: requireSession },
    async (req, reply) => {
      const { activityId } = req.params;
      const tenantId = req.user!.tenantId!;

      // 1. Look up the activity to get its project_id (and verify tenant access)
      const activityLookup = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<{ id: string; project_id: string }[]>`
          SELECT id, project_id
            FROM activity
           WHERE id = ${activityId}
             AND tenant_id = ${tenantId}
        `;
        return rows[0] ?? null;
      });

      if (!activityLookup) {
        return reply.status(404).send({
          error: 'activity_not_found',
          message: 'No activity with that id in this firm',
          requestId: req.id,
        });
      }

      const { project_id } = activityLookup;

      // 2. Fetch all activities in the same project (sorted by code for grid display)
      const activities = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        return tx<ComparisonActivity[]>`
          SELECT id, title, code, kind
            FROM activity
           WHERE project_id = ${project_id}
             AND tenant_id = ${tenantId}
           ORDER BY code ASC
        `;
      });

      // 3. Check if multi_entity_similarity_score table exists (p7d)
      const tableCheck = await sql<{ exists: unknown }[]>`
        SELECT to_regclass('multi_entity_similarity_score') AS exists
      `;
      const similarityAvailable = !!tableCheck[0]?.exists;

      // 4. Fetch scores if the table exists
      let scores: SimilarityScore[] = [];
      if (similarityAvailable) {
        const activityIds = activities.map((a) => a.id);
        scores = await sql.begin(async (tx) => {
          await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
          return tx<SimilarityScore[]>`
            SELECT activity_a_id, activity_b_id, score
              FROM multi_entity_similarity_score
             WHERE activity_a_id = ANY(${activityIds})
               AND activity_b_id = ANY(${activityIds})
               AND tenant_id = ${tenantId}
             ORDER BY score DESC
          `;
        });
      }

      return {
        activities,
        scores,
        similarity_available: similarityAvailable,
      };
    },
  );
}
