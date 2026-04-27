import { computeScore } from '@cpa/audit-score';
import { privilegedSql } from '@cpa/db/client';

/**
 * Audit-score recompute job (T-D3).
 *
 * Runs the 10-rule scoring engine for a claimant and appends the result as
 * a new `audit_score_snapshot` row. Two entry points:
 *
 *   - `runRecomputeJob({ tenant_id, subject_tenant_id })`:
 *     compute + insert for ONE claimant. Called inline by the GET endpoint
 *     when a claimant has no snapshot yet (cold-start fill).
 *
 *   - `recomputeAllActive()`:
 *     iterate every non-deleted claimant across all firms and recompute
 *     each. Intended for the cron worker (P5+); failures per claimant are
 *     logged but don't abort the loop.
 *
 * Uses `privilegedSql` because the cron worker has no tenant GUC; the
 * subject_tenant_id parameter scopes the rule queries, and the INSERT
 * targets a known (tenant_id, subject_tenant_id) tuple read from the
 * subject_tenant table itself.
 */

export type RecomputeJobInput = {
  tenant_id: string;
  subject_tenant_id: string;
};

export type RecomputeJobResult = {
  snapshot_id: string;
  total_pts: number;
};

/**
 * Compute the score for one claimant and persist as an audit_score_snapshot
 * row. Returns the new snapshot id + total for the caller to surface in
 * logs / OTel attributes.
 */
export async function runRecomputeJob(input: RecomputeJobInput): Promise<RecomputeJobResult> {
  const result = await computeScore({
    tenant_id: input.tenant_id,
    subject_tenant_id: input.subject_tenant_id,
  });
  const id = crypto.randomUUID();
  // postgres-js binds `${string}::jsonb` via the binary protocol in a way
  // that double-encodes (the JSON-stringified array gets wrapped in
  // another JSON string layer, so the column ends up storing a jsonb
  // *string* scalar rather than an array). Drop the explicit cast and
  // rely on the column's declared jsonb type for coercion — postgres
  // parses the text on insert into a real jsonb array.
  const breakdownJson = JSON.stringify(result.rule_breakdown);
  await privilegedSql`
    INSERT INTO audit_score_snapshot
      (id, tenant_id, subject_tenant_id, total_pts, max_pts, rule_breakdown)
    VALUES
      (${id}, ${input.tenant_id}, ${input.subject_tenant_id},
       ${result.total_pts}, ${result.max_pts},
       ${breakdownJson})
  `;
  return { snapshot_id: id, total_pts: result.total_pts };
}

type ActiveClaimantRow = {
  tenant_id: string;
  subject_tenant_id: string;
};

export type RecomputeAllActiveResult = {
  /** Total claimants iterated, including any whose individual recompute threw. */
  recomputed: number;
};

/**
 * Iterate every non-deleted claimant across all firms and recompute their
 * scores. Per-claimant failures are caught + logged so one bad chain
 * doesn't abort the rest of the run.
 *
 * Uses `privilegedSql` to bypass RLS — this is a system-level cron entry
 * point, not a per-firm call. The subject_tenant table doesn't carry
 * personal data; it's just (id, tenant_id, name, kind).
 */
export async function recomputeAllActive(): Promise<RecomputeAllActiveResult> {
  const rows = await privilegedSql<ActiveClaimantRow[]>`
    SELECT tenant_id, id AS subject_tenant_id FROM subject_tenant
     WHERE deleted_at IS NULL AND kind = 'claimant'
  `;
  for (const r of rows) {
    try {
      await runRecomputeJob({
        tenant_id: r.tenant_id,
        subject_tenant_id: r.subject_tenant_id,
      });
    } catch (e) {
      // Cron worker has no Fastify logger; console.error matches the
      // daily-capture-push job's STUB log convention.
      console.error(`[audit-score-recompute] failed for ${r.subject_tenant_id}:`, e);
    }
  }
  return { recomputed: rows.length };
}
