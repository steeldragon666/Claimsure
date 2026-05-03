/**
 * Agent C (narrative drafter) shared types.
 *
 * These literal-tuple constants are the single source of truth for
 * the four AusIndustry submission narrative section kinds and the
 * two segment types that compose each section under the δ hybrid
 * audit-anchor model (design doc §5).
 *
 * KEEP IN SYNC WITH:
 *   - `NARRATIVE_SECTION_KINDS` in
 *     `@cpa/db/schema/narrative_draft.ts` (and the
 *     `narrative_draft_section_kind_valid` CHECK in migration
 *     `0029_narrative_draft.sql`)
 *   - The `section_kind` enum on `NarrativeDraftedPayload` in
 *     `@cpa/schemas/event.ts`
 *   - The discriminated-union variants on `NarrativeSegment` in
 *     `@cpa/schemas/event.ts`
 *
 * NarrativeSegment in @cpa/schemas describes the PERSISTED segment
 * shape (what lives in `narrative_draft.segments`). The wire-format
 * tool schema the model emits via `emit_segment` is a SUPERSET of
 * that — it adds `section_kind` and `segment_index` so the
 * orchestrator can route incoming tool calls back to the correct
 * (section, position) without keeping per-stream state. The
 * `agents` package intentionally does not depend on `@cpa/schemas`
 * (see `packages/agents/package.json` deps), so this module
 * redeclares the literals locally rather than re-exporting them.
 */

/** AusIndustry submission narrative section kinds, in emit order. */
export const SECTION_KINDS = [
  'new_knowledge',
  'hypothesis',
  'uncertainty',
  'experiments_and_results',
] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

/**
 * Segment types under the δ hybrid audit-anchor model:
 *   - `prose`: narrative bridges, definitions, statutory connectors.
 *     Carries no audit anchor (no `citing_events`).
 *   - `claim`: every factual statement about the R&D activity.
 *     MUST cite ≥1 event from the parent activity's clustered_events
 *     so the auditor can drill from claim to evidence.
 */
export const SEGMENT_TYPES = ['prose', 'claim'] as const;
export type SegmentType = (typeof SEGMENT_TYPES)[number];

import { z } from 'zod';
import { MULTI_CYCLE_TRANSITION_KINDS } from '../multi-cycle/types.js';

/**
 * Australian R&DTI financial-year label. Two-digit form ('FY24', 'FY25')
 * matches the codebase convention used throughout `activity.fy_label`,
 * `narrative_draft.fy_label`, and the multi-cycle walker test fixtures.
 *
 * Reused verbatim from `multi-cycle-summarize@1.0.0.ts` (Task A.3) so
 * Theme B's narrative drafter and Theme A's summariser agree on the
 * label format. Rejects 'FY2024' (four-digit), 'fy24' (lowercase),
 * 'FY' alone, etc.
 */
const FyLabel = z.string().regex(/^FY\d{2}$/, 'must be FYNN format (two digits)');

/**
 * Block of prior fiscal-year context surfaced to the v1.1.0 narrative
 * drafter when an activity's `proposed_id` chain has 2+ FYs (per design
 * Section 2.3 — Q5 default-on multi-cycle continuity behaviour).
 *
 * Field naming preserves the design doc Section 2.5 contract:
 *   - `hypothesis_segment_excerpts`: verbatim text from prior FYs'
 *     `narrative_segment` rows where the parent
 *     `narrative_draft.section_kind = 'hypothesis'`.
 *   - `design_segment_excerpts`: verbatim text from prior FYs'
 *     `narrative_segment` rows where the parent
 *     `narrative_draft.section_kind = 'experiments_and_results'`.
 *
 * **Q-Map=A locked decision**: The design doc field name
 * `design_segment_excerpts` is preserved as the stable interface for
 * narrative continuity. The codebase's actual `section_kind` for the
 * "what was done and observed" section is `experiments_and_results`
 * (see SECTION_KINDS above). The mapping is fixed:
 *   `design_segment_excerpts` ↔ `section_kind = 'experiments_and_results'`.
 *
 * Excerpts are verbatim from `narrative_segment.text` (Body-by-Michael
 * compliance: never paraphrased by an LLM intermediary). The downstream
 * v1.1.0 system prompt instructs the model to use these excerpts ONLY
 * to verify trajectory consistency — never to quote or paraphrase them
 * in its own output.
 *
 * `transition_classification` is the optional cross-FY classification
 * (continuation / pivot / completion / abandoned) emitted by Task A.3's
 * multi-cycle summariser. The structural helper that BUILDS this block
 * leaves it `null` — the summariser populates it later via a separate
 * pass.
 */
export const PriorFyContextBlock = z
  .object({
    proposed_id: z.string().uuid(),
    prior_fys: z.array(
      z
        .object({
          fy_label: FyLabel,
          /**
           * Verbatim text excerpts from prior-FY `narrative_segment`
           * rows whose parent `narrative_draft.section_kind = 'hypothesis'`.
           * Never paraphrased. Empty strings are rejected at parse time so
           * a corrupted/in-progress prior-FY draft with empty segment text
           * fails loudly at the boundary instead of silently leaking in.
           */
          hypothesis_segment_excerpts: z.array(z.string().min(1, 'segment text cannot be empty')),
          /**
           * Verbatim text excerpts from prior-FY `narrative_segment` rows
           * whose parent `narrative_draft.section_kind =
           * 'experiments_and_results'`. The design doc field name
           * "design" is preserved as a stable interface (Q-Map=A);
           * the codebase's `experiments_and_results` is the actual
           * data source. Never paraphrased. Empty strings are rejected at
           * parse time (same boundary guard as `hypothesis_segment_excerpts`).
           */
          design_segment_excerpts: z.array(z.string().min(1, 'segment text cannot be empty')),
          transition_classification: z.enum(MULTI_CYCLE_TRANSITION_KINDS).nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export type PriorFyContextBlock = z.infer<typeof PriorFyContextBlock>;
