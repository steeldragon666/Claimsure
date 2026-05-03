import { sql as defaultSql } from '@cpa/db/client';

/**
 * P7 Theme A Task A.2 — `proposed_id` chain walker.
 *
 * Resolves "all prior FY narratives sharing this hypothesis" by joining
 * `activity` (which carries the Agent-B-issued `proposed_id`) to its
 * `narrative_draft` rows, filtered to a single tenant + `proposed_id`,
 * and ordered chronologically by `(fy_label, hypothesis_formed_at)`.
 *
 * The narrative drafter (Theme B) consumes this list to build the
 * prior-FY context block for the current-FY draft (per design Section
 * 2.3 — Q5 default-on multi-cycle continuity behaviour).
 *
 * **JOIN choice**: INNER JOIN per design Section 2.3. An activity with
 * no narrative_draft is not yet a "prior narrative" worth citing — the
 * chain walker's contract is "narrative continuity", so activities
 * without drafts are intentionally elided. If callers later need the
 * looser variant ("all activities sharing this proposed_id, with or
 * without drafts"), introduce a separate `walkActivityChain` rather
 * than relaxing this one.
 *
 * **Ordering**: `fy_label ASC, hypothesis_formed_at ASC`. Text-sort on
 * `fy_label` works correctly for the `'FY24' < 'FY25' < … < 'FY99'`
 * range we'll ever ship (3-digit FYs are not a real concern). The
 * `hypothesis_formed_at` tiebreaker handles the rare case where two
 * activities share both `proposed_id` and `fy_label` (e.g. a re-issued
 * proposed_id within the same FY — currently impossible by Agent B's
 * synthesis contract, but defensive).
 *
 * **Tenant isolation**: enforced via `WHERE a.tenant_id = ${tenantId}`.
 * The function does not assume RLS context is set; it filters
 * explicitly. This keeps it usable from contexts where the postgres-js
 * connection's `app.current_tenant_id` GUC may be unset (background
 * jobs, agent runtime). Tests assert that another tenant's row sharing
 * the same `proposed_id` is never returned.
 *
 * **Test seam**: the optional `executor` parameter accepts any
 * postgres-js-compatible tagged-template function. Unit tests inject
 * a mock to verify SQL shape and parameter binding without a live
 * database; production callers omit it and pick up the default
 * `@cpa/db/client` `sql` connection.
 */

/**
 * One row of the multi-cycle chain — a single (activity, narrative_draft)
 * pair sharing a `proposed_id`.
 *
 * Field names match the SQL `SELECT` aliases (snake_case) to keep the
 * row a transparent projection of the underlying tables — the chain
 * walker is a thin SQL wrapper, not a translation layer.
 */
export interface ActivityHistoryRow {
  activity_id: string;
  fy_label: string;
  hypothesis_formed_at: Date;
  proposed_id: string;
  narrative_draft_id: string;
  content_hash: string;
}

/**
 * Minimal shape of a postgres-js tagged-template executor that the
 * walker needs. The real `sql` import from `@cpa/db/client` satisfies
 * this; tests can pass a stub.
 */
export type ChainWalkExecutor = <T>(
  template: TemplateStringsArray,
  ...values: unknown[]
) => Promise<readonly T[]>;

/**
 * Walk the `proposed_id` chain for a single tenant.
 *
 * @param rootProposedId - the `proposed_id` UUID issued by Agent B at
 *   activity-proposal time. All activities sharing this value across
 *   FYs constitute the chain.
 * @param tenantId - tenant scope; filters out rows from any other firm
 *   that happens to share a UUID collision (vanishingly unlikely with
 *   v4 UUIDs, but defence-in-depth).
 * @param executor - optional postgres-js-compatible executor. Defaults
 *   to the workspace `@cpa/db/client` `sql` connection. Pass a stub in
 *   unit tests to assert on the SQL shape without touching a DB.
 * @returns chain rows ordered chronologically by
 *   `(fy_label ASC, hypothesis_formed_at ASC)`. Empty array if no
 *   activities match (e.g. brand-new proposed_id, wrong tenant).
 */
export async function walkProposedIdChain(
  rootProposedId: string,
  tenantId: string,
  executor: ChainWalkExecutor = defaultSql as unknown as ChainWalkExecutor,
): Promise<ActivityHistoryRow[]> {
  const rows = await executor<ActivityHistoryRow>`
    SELECT a.id AS activity_id,
           a.fy_label,
           a.hypothesis_formed_at,
           a.proposed_id,
           nd.id AS narrative_draft_id,
           nd.content_hash
      FROM activity a
      JOIN narrative_draft nd ON nd.activity_id = a.id
                              AND nd.tenant_id = a.tenant_id
     WHERE a.tenant_id = ${tenantId}
       AND a.proposed_id = ${rootProposedId}
     ORDER BY a.fy_label ASC, a.hypothesis_formed_at ASC
  `;
  return [...rows];
}
