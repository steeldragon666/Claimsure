import type { FastifyInstance } from 'fastify';
import { requireSession } from '@cpa/auth';
import { sql } from '@cpa/db/client';
import { runRecomputeJob } from '../jobs/audit-score-recompute.js';

/**
 * Audit-readiness score endpoint (T-D3 / T-D4).
 *
 * `GET /v1/audit-score/:claimant_id` returns the latest snapshot for the
 * claimant, falling back to an on-demand compute if the cron worker hasn't
 * filled the table yet (cold start).
 *
 * `delta_7d` is the change in `total_pts` between the latest snapshot and
 * the most recent snapshot ≥ 7 days old. Returns 0 if no 7-day-old baseline
 * exists (claimant too new). The look-back uses `<=` rather than `<` so a
 * snapshot taken exactly 7 days ago is still a valid baseline.
 *
 * RLS handles cross-firm isolation: the SELECT runs inside an RLS-scoped
 * transaction, so a consultant in Firm A querying claimant X (which lives
 * in Firm B) sees an empty result and gets a 404. Subject_tenant existence
 * is also gated by RLS on the subject_tenant table itself.
 */

interface SnapshotRow {
  total_pts: number;
  max_pts: number;
  rule_breakdown: unknown;
  computed_at: Date | string;
}

interface DeltaRow {
  total_pts: number;
}

// postgres-js may return timestamptz columns as either a Date object
// (modern drivers + parse-as-date paths) OR a postgres-native string
// like "2026-04-27 15:10:41.128715+00" (the latter is NOT ISO 8601 —
// note the space separator instead of T). Normalise both to ISO so
// API consumers see a single, regex-checkable format.
const isoOf = (v: Date | string): string =>
  typeof v === 'string' ? new Date(v).toISOString() : v.toISOString();

export function registerAuditScore(app: FastifyInstance): void {
  app.get<{ Params: { claimant_id: string } }>(
    '/v1/audit-score/:claimant_id',
    { preHandler: requireSession },
    async (req, reply) => {
      const { claimant_id } = req.params;
      const tenantId = req.user!.tenantId!;

      // Step 1: confirm the claimant exists + is visible to this firm.
      // Same shape as routes/events.ts — RLS on subject_tenant covers the
      // cross-firm case, deleted_at IS NULL covers archival.
      const subjectVisible = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<{ id: string }[]>`
          SELECT id FROM subject_tenant
           WHERE id = ${claimant_id} AND deleted_at IS NULL AND kind = 'claimant'
        `;
        return rows[0] != null;
      });
      if (!subjectVisible) {
        return reply.status(404).send({
          error: 'claimant_not_found',
          message: 'No claimant with that id in this firm',
          requestId: req.id,
        });
      }

      // Step 2: fetch the latest snapshot. If absent, trigger an on-demand
      // recompute (uses privilegedSql + writes a fresh row), then re-read.
      let latest = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<SnapshotRow[]>`
          SELECT total_pts, max_pts, rule_breakdown, computed_at
            FROM audit_score_snapshot
           WHERE subject_tenant_id = ${claimant_id}
           ORDER BY computed_at DESC
           LIMIT 1
        `;
        return rows[0] ?? null;
      });

      if (!latest) {
        await runRecomputeJob({ tenant_id: tenantId, subject_tenant_id: claimant_id });
        latest = await sql.begin(async (tx) => {
          await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
          const rows = await tx<SnapshotRow[]>`
            SELECT total_pts, max_pts, rule_breakdown, computed_at
              FROM audit_score_snapshot
             WHERE subject_tenant_id = ${claimant_id}
             ORDER BY computed_at DESC
             LIMIT 1
          `;
          return rows[0] ?? null;
        });
        if (!latest) {
          // Should be unreachable — runRecomputeJob always inserts.
          throw new Error('GET /v1/audit-score/:claimant_id: snapshot missing after recompute');
        }
      }

      // Step 3: D4 — compute delta_7d. Pull the most recent snapshot ≥ 7
      // days old; if none, delta is 0 (claimant is too new to have a
      // baseline). Same RLS-scoped transaction style as Step 2.
      const sevenDayOld = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<DeltaRow[]>`
          SELECT total_pts FROM audit_score_snapshot
           WHERE subject_tenant_id = ${claimant_id}
             AND computed_at <= NOW() - INTERVAL '7 days'
           ORDER BY computed_at DESC
           LIMIT 1
        `;
        return rows[0] ?? null;
      });
      const delta_7d = sevenDayOld ? latest.total_pts - sevenDayOld.total_pts : 0;

      // Defensive parse: if a legacy INSERT path double-encoded the
      // column (jsonb stored as a JSON-string scalar rather than an
      // array), unwrap it here so the API contract holds. The recompute
      // job's INSERT was fixed to drop the explicit ::jsonb cast (which
      // is what triggered the double-encoding via postgres-js's binary
      // protocol), so going forward this branch is a safety net for
      // pre-fix snapshots. It can be removed once the snapshot table is
      // backfilled or rewritten.
      const rawBreakdown = latest.rule_breakdown;
      const ruleBreakdown =
        typeof rawBreakdown === 'string' ? (JSON.parse(rawBreakdown) as unknown) : rawBreakdown;
      return {
        total_pts: latest.total_pts,
        max_pts: latest.max_pts,
        rule_breakdown: ruleBreakdown,
        delta_7d,
        computed_at: isoOf(latest.computed_at),
      };
    },
  );
}
