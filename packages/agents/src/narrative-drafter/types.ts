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
