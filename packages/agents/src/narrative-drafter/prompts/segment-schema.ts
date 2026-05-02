import { z } from 'zod';
import { SECTION_KINDS } from '../types.js';

/**
 * Wire-format schema for a single `emit_segment` tool call from
 * Agent C (narrative drafter — streaming).
 *
 * Distinct from `NarrativeSegment` in `@cpa/schemas/event.ts`: that
 * schema describes the PERSISTED segment shape (what lives in
 * `narrative_draft.segments` once Task 5.4 lands the persistence
 * layer). The tool input the model emits adds two routing fields:
 *
 *   - `section_kind` — which of the four AusIndustry sections this
 *     segment belongs to. Lets the orchestrator demux a single
 *     streamed run into per-section buffers without keeping state
 *     about "which section are we in now".
 *   - `segment_index` — 0-based position within the section.
 *     Validated by Task 5.2's validate-and-correct loop to be
 *     monotonic + dense per section (no gaps, no duplicates).
 *
 * Both prompt versions (`draft-narrative` and `regenerate-section`)
 * import this schema verbatim — the wire shape is identical, only
 * the system prompt body differs (regenerate-section adds an
 * existing-sections context block + a single-section emit
 * constraint).
 *
 * Structural-only validation:
 *   - `claim` segments must declare at least one citing event.
 *   - The Zod schema cannot verify the cited UUIDs actually
 *     correspond to events in the activity's clustered_events
 *     cluster — that's Task 5.2's semantic check, executed inside
 *     the streaming validate-and-correct loop on the server.
 *   - The `prose` branch deliberately omits `citing_events`; under
 *     the discriminated union an emitted `prose` segment that
 *     carries `citing_events` will fail to parse (the field is not
 *     part of the prose variant), so the runtime rejects callers
 *     trying to anchor a prose bridge.
 */
const Uuid = z.string().uuid();

export const draftNarrativeToolSchema = z.discriminatedUnion('type', [
  z
    .object({
      section_kind: z.enum(SECTION_KINDS),
      segment_index: z.number().int().nonnegative(),
      type: z.literal('prose'),
      text: z.string().min(1).max(2000),
    })
    .strict(),
  z
    .object({
      section_kind: z.enum(SECTION_KINDS),
      segment_index: z.number().int().nonnegative(),
      type: z.literal('claim'),
      text: z.string().min(1).max(2000),
      citing_events: z.array(Uuid).min(1),
    })
    .strict(),
]);
export type DraftNarrativeToolInput = z.infer<typeof draftNarrativeToolSchema>;

/**
 * Common tool definition fields. Both prompt versions register a
 * tool named `emit_segment` so the orchestrator routes both flows
 * through one streaming dispatcher.
 */
export const EMIT_SEGMENT_TOOL_NAME = 'emit_segment';
export const EMIT_SEGMENT_TOOL_DESCRIPTION =
  'Emit one narrative segment (prose or claim) for a section. Call once per segment, in section order, with a 0-based monotonic segment_index per section.';
