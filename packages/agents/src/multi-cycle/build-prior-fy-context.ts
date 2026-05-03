import { sql as defaultSql } from '@cpa/db/client';
import { walkProposedIdChain, type ChainWalkExecutor } from './walk-proposed-id.js';
import { PriorFyContextBlock as PriorFyContextBlockSchema } from '../narrative-drafter/types.js';
import type { PriorFyContextBlock } from '../narrative-drafter/types.js';

/**
 * P7 Theme A Task A.4 — `buildPriorFyContext` helper.
 *
 * Given an activity's root `proposed_id` (the value Agent B issued at
 * activity-proposal time) and a tenant scope, build a {@link PriorFyContextBlock}
 * suitable for feeding the `draft-narrative@1.1.0` prompt's
 * `prior_fy_context` input.
 *
 * The helper:
 *   1. Walks the chain via {@link walkProposedIdChain} (Task A.2).
 *   2. Filters out the current FY (the FY the consultant is drafting NOW).
 *   3. Returns `null` when the chain has 0 prior FYs — there is no
 *      multi-cycle context to surface in that case (per Q5 default-on
 *      logic, "default-on for chains with 2+ FYs", which collapses to
 *      "1+ prior FY").
 *   4. Otherwise, projects each prior FY's segments grouped by parent
 *      `narrative_draft.section_kind` into the block's
 *      `hypothesis_segment_excerpts` / `design_segment_excerpts` arrays.
 *
 * **Q-Map=A locked decision**: `design_segment_excerpts` is the stable
 * design-doc field name for the "what was done and observed" section;
 * its data source in this codebase is `narrative_segment` rows whose
 * parent `narrative_draft.section_kind = 'experiments_and_results'`.
 * The SQL query enforces this binding directly — see the WHERE clause
 * on the join below.
 *
 * **Verbatim guarantee (Body-by-Michael compliance)**: the helper
 * returns the segment `text` column unchanged — no transformation,
 * no LLM paraphrase, no truncation. The downstream prompt explicitly
 * instructs the model to use these excerpts only for consistency
 * verification, never to quote or paraphrase them.
 *
 * **Transition classification**: this helper does NOT populate
 * `transition_classification` — it leaves the field `null` on every
 * prior-FY entry. The multi-cycle summariser (Task A.3) populates that
 * field in a separate pass; this helper is purely structural.
 *
 * **Test seam**: `executor` accepts any postgres-js-compatible
 * tagged-template function. The same DI pattern as
 * {@link walkProposedIdChain} — production callers omit it and pick up
 * the default `@cpa/db/client` `sql` connection; unit tests pass a stub.
 */

export interface BuildPriorFyContextOptions {
  /** UUID of the activity's `proposed_id` chain root (Agent B-issued). */
  rootProposedId: string;
  /** Tenant scope; mirrors {@link walkProposedIdChain}. */
  tenantId: string;
  /**
   * The FY label of the current draft (e.g. `'FY26'`). Required: the chain
   * walker returns ALL FYs sharing this `proposed_id`, including the current
   * FY's own row. We exclude the row matching this label so the helper
   * returns only PRIOR FYs. Making this required prevents a footgun where
   * a forgotten parameter would silently leak the current FY's segments
   * back into "prior context" — a self-reinforcement risk.
   */
  excludeFyLabel: string;
  /** Test seam — overrides the default `@cpa/db/client` `sql`. */
  executor?: ChainWalkExecutor;
}

/**
 * Row shape for the segment-projection query. Each row is one
 * `narrative_segment` from a prior-FY `narrative_draft`, joined to its
 * parent draft to surface the parent's `section_kind` (canonical kind
 * store) and `fy_label`.
 *
 * The query filters to a fixed set of `narrative_draft_id`s (the prior-FY
 * draft IDs from the chain walker output) and to the two `section_kind`
 * values we care about (`hypothesis` and `experiments_and_results`).
 */
interface SegmentProjectionRow {
  fy_label: string;
  section_kind: string;
  segment_index: number;
  text: string;
}

export async function buildPriorFyContext(
  opts: BuildPriorFyContextOptions,
): Promise<PriorFyContextBlock | null> {
  const executor: ChainWalkExecutor = opts.executor ?? (defaultSql as unknown as ChainWalkExecutor);

  // 1. Walk the chain.
  const chainRows = await walkProposedIdChain(opts.rootProposedId, opts.tenantId, executor);

  // 2. Filter out the current FY (PRIOR FYs only). `excludeFyLabel` is
  //    required on the options type — see `BuildPriorFyContextOptions`.
  const priorRows = chainRows.filter((r) => r.fy_label !== opts.excludeFyLabel);

  // 3. Default-on logic: <= 0 prior FYs -> no context to surface.
  if (priorRows.length === 0) {
    return null;
  }

  // 3a. Detect duplicate fy_labels in the chain (data corruption). A
  //     single proposed_id chain should have at most one activity per
  //     fiscal year; if two rows share an FY label we'd silently merge
  //     them into one bucket below (Map keyed on fy_label). Surface
  //     loudly instead.
  const seenFyLabels = new Set<string>();
  for (const row of priorRows) {
    if (seenFyLabels.has(row.fy_label)) {
      throw new Error(
        `buildPriorFyContext: duplicate fy_label '${row.fy_label}' in proposed_id chain ` +
          `${opts.rootProposedId} (tenant ${opts.tenantId}). ` +
          `This indicates data corruption — a single proposed_id chain should have at most ` +
          `one activity per fiscal year.`,
      );
    }
    seenFyLabels.add(row.fy_label);
  }

  const priorDraftIds = priorRows.map((r) => r.narrative_draft_id);

  // 4. Project segments grouped by parent draft's section_kind. The
  //    join is composite (tenant_id, narrative_draft_id) to mirror the
  //    composite PK on narrative_draft and the composite FK from
  //    narrative_segment (see narrative_segment.ts comments). We only
  //    project the two section_kinds the v1.1.0 prompt cares about
  //    so cross-FY uncertainty / new_knowledge segments don't bloat
  //    the context block.
  //
  //    Q-Map=A binding lives directly in the WHERE clause:
  //      design_segment_excerpts <- section_kind = 'experiments_and_results'
  const segmentRows = await executor<SegmentProjectionRow>`
    SELECT nd.fy_label,
           nd.section_kind,
           ns.segment_index,
           ns.text
      FROM narrative_segment ns
      JOIN narrative_draft nd ON nd.id = ns.narrative_draft_id
                              AND nd.tenant_id = ns.narrative_draft_tenant_id
     WHERE nd.tenant_id = ${opts.tenantId}
       AND ns.narrative_draft_id = ANY(${priorDraftIds})
       AND nd.section_kind IN ('hypothesis', 'experiments_and_results')
     ORDER BY nd.fy_label ASC, nd.section_kind ASC, ns.segment_index ASC
  `;

  // 5. Group segments by fy_label, then by section_kind, projecting
  //    text values verbatim. We keep insertion order (the SQL ORDER BY
  //    above guarantees fy_label ASC + segment_index ASC).
  const byFy = new Map<string, { hypothesis: string[]; design: string[] }>();

  // Seed entries for every prior FY (even those with zero hypothesis /
  // experiments_and_results segments) so the resulting block has one
  // entry per chain-walker FY, matching the contract the v1.1.0 prompt
  // expects (the agent reasons about "every prior FY", not "every prior
  // FY that happened to have segments in these two sections").
  for (const r of priorRows) {
    if (!byFy.has(r.fy_label)) {
      byFy.set(r.fy_label, { hypothesis: [], design: [] });
    }
  }

  for (const seg of segmentRows) {
    const bucket = byFy.get(seg.fy_label);
    if (!bucket) continue; // defensive — should be impossible after the seed loop
    if (seg.section_kind === 'hypothesis') {
      bucket.hypothesis.push(seg.text);
    } else if (seg.section_kind === 'experiments_and_results') {
      bucket.design.push(seg.text);
    }
  }

  // 6. Sort by fy_label ASC and shape into the schema's `prior_fys` array.
  //    `transition_classification` is null here — the summariser fills it
  //    in a separate pass.
  const priorFys = [...byFy.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([fy_label, buckets]) => ({
      fy_label,
      hypothesis_segment_excerpts: buckets.hypothesis,
      design_segment_excerpts: buckets.design,
      transition_classification: null,
    }));

  // 7. Parse-validate the assembled block — defence in depth so a
  //    drift-prone caller can't return a malformed block past this
  //    boundary. The schema is strict, so any structural error trips here.
  return PriorFyContextBlockSchema.parse({
    proposed_id: opts.rootProposedId,
    prior_fys: priorFys,
  });
}
