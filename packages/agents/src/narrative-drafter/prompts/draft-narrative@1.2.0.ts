import { z } from 'zod';
import { registerPrompt } from '../../runtime/prompt-registry.js';
import { PriorFyContextBlock } from '../types.js';
import { CorePortalFieldsSchema, SupportingPortalFieldsSchema } from '@cpa/schemas';

/**
 * P7 Sprint A Task A.3 — `draft-narrative@1.2.0`.
 *
 * Generates AusIndustry-portal-ready structured output: the 13 core
 * fields (s.355-25 registration) or 9 supporting fields (s.355-30).
 *
 * Unlike v1.0.0 / v1.1.0 which stream `emit_segment` tool calls for
 * the 4-section narrative, v1.2.0 emits a SINGLE `emit_portal_fields`
 * tool call containing the full portal-field JSON object. The runtime
 * validates against `CorePortalFieldsSchema` or
 * `SupportingPortalFieldsSchema` (selected by `activity.kind`).
 *
 * **Intended usage**: called AFTER v1.1.0 completes the thematic
 * narrative. The portal-fields prompt receives the same activity
 * context + events and produces registration-form-ready content with
 * per-field character limits enforced.
 *
 * **Backward compatibility**: v1.0.0 + v1.1.0 remain registered under
 * their own keys. v1.2.0 is a separate registry entry.
 */

export const PROMPT_VERSION = '1.2.0' as const;

/**
 * Input schema for v1.2.0. Same shape as v1.1.0 (activity context +
 * optional prior_fy_context) plus `activity_kind` to select the
 * correct portal-field schema.
 */
export const draftNarrativeInputSchema = z
  .object({
    activity_kind: z.enum(['core', 'supporting']),
    prior_fy_context: PriorFyContextBlock.optional(),
  })
  .passthrough();

export type DraftNarrativeInput = z.infer<typeof draftNarrativeInputSchema>;

/**
 * Tool schema for `emit_portal_fields`. Discriminated on
 * `activity_kind`; core activities emit 13 fields, supporting
 * activities emit 9 (+ nested sub-fields).
 */
export const emitPortalFieldsToolSchema = z.discriminatedUnion('activity_kind', [
  z
    .object({
      activity_kind: z.literal('core'),
      fields: CorePortalFieldsSchema,
    })
    .strict(),
  z
    .object({
      activity_kind: z.literal('supporting'),
      fields: SupportingPortalFieldsSchema,
    })
    .strict(),
]);
export type EmitPortalFieldsToolInput = z.infer<typeof emitPortalFieldsToolSchema>;

export const EMIT_PORTAL_FIELDS_TOOL_NAME = 'emit_portal_fields';
export const EMIT_PORTAL_FIELDS_TOOL_DESCRIPTION =
  'Emit the complete portal-fields JSON object for the activity. Call exactly once with all fields populated.';

/**
 * System prompt for `draft-narrative@1.2.0`.
 *
 * Instructs the model to produce AusIndustry portal-ready content
 * with strict per-field character limits. The model receives the
 * same evidence stream as v1.1.0 but emits structured portal fields
 * instead of streaming narrative segments.
 */
export const SYSTEM_PROMPT = `You are an expert technical writer producing AusIndustry R&DTI
portal-ready content for an Australian claimant under Division 355
of the Income Tax Assessment Act 1997.

You are given:
  - The activity's name, kind (core / supporting), and statutory
    anchor (s.355-25 for core, s.355-30 for supporting).
  - A pre-clustered evidence stream (\`clustered_events\`): every
    event has a stable UUID, a kind, a timestamp, and a text body.
  - Optional pre-filled framing from Agent B: \`proposed_hypothesis\`
    and \`proposed_uncertainty\`.
  - Optional multi-cycle context (\`prior_fy_context\`): see
    "Multi-cycle context" below.

# Output protocol

You emit portal fields via a SINGLE \`emit_portal_fields\` tool call.
The tool input is a **two-key object**: \`activity_kind\` and \`fields\`.

For a CORE activity:

\`\`\`json
{
  "activity_kind": "core",
  "fields": {
    "activity_name": "...",
    "description": "...",
    "...": "(all 13 core fields here)"
  }
}
\`\`\`

For a SUPPORTING activity:

\`\`\`json
{
  "activity_kind": "supporting",
  "fields": {
    "activity_name": "...",
    "description": "...",
    "...": "(all 9 supporting fields here)"
  }
}
\`\`\`

Rules for the wrapper (apply to BOTH kinds):
  - The tool input is the JSON object above — nothing more, nothing less.
  - The top-level object has EXACTLY two keys: \`activity_kind\` and
    \`fields\`. No other top-level keys. Do NOT nest this object inside
    another wrapper (e.g. do not emit \`{"fields": {"activity_kind":...}}\`).
  - \`activity_kind\` is the string \`"core"\` or \`"supporting"\`,
    matching the kind given in the user message.
  - \`fields\` is an OBJECT whose keys are the 13 core fields or the
    9 supporting fields listed below. Do NOT place those field keys
    at the top level — they MUST be nested inside \`fields\`.

Anti-patterns to avoid:
  - ❌ Flat: \`{"activity_name": "...", "description": "...", ...}\` — missing wrapper.
  - ❌ Double-wrapped: \`{"fields": {"activity_kind": "...", "fields": {...}}}\` — too many wrappers.
  - ✅ Correct: \`{"activity_kind": "supporting", "fields": {"activity_name": "...", ...}}\`.

Do NOT emit multiple tool calls. Do NOT emit free text outside the
tool call. The orchestrator validates the output against the
appropriate Zod schema (a discriminated union on \`activity_kind\`).

# Character limits — HARD CAPS

Every text field has a 4000-character maximum EXCEPT \`activity_name\`
which caps at 200 characters. These are AusIndustry portal limits.
If your draft exceeds a limit, the server rejects it. Write concise,
technically precise prose that fits within limits.

# Core Activity fields (13 fields, s.355-25)

When \`activity_kind = "core"\`, emit ALL of:

  1. \`activity_name\` (≤200 chars): concise descriptive name.
  2. \`description\` (≤4000 chars): what the activity involves,
     its objectives, and the technical domain.
  3. \`outcome_unknown_methods\` (array, ≥1 value): how the company
     determined the outcome could not be known in advance. Values:
     "no_applicable_literature", "expert_advice",
     "no_adaptable_solutions", "other", "did_not_investigate".
  4. \`sources_investigated\` (≤4000 chars): what literature,
     patents, expert advice, or industry practice was consulted
     and what those sources revealed.
  5. \`why_competent_professional_couldnt_know\` (≤4000 chars):
     explain WHY a competent professional in the field could not
     have known or determined the outcome in advance.
  6. \`hypothesis\` (≤4000 chars): the explicit testable conjecture
     the activity set out to evaluate, with predicted outcomes and
     any quantitative success criteria.
  7. \`experiment\` (≤4000 chars): the experimental methodology —
     what was actually done, in roughly chronological order.
  8. \`evaluation\` (≤4000 chars): how results were evaluated
     against the hypothesis — what metrics, comparisons, or
     analytical techniques were used.
  9. \`conclusions\` (≤4000 chars): what was learned, whether the
     hypothesis was supported or refuted, and what new knowledge
     was generated.
  10. \`evidence_kept_categories\` (array, ≥1 value): what types
      of evidence the company kept. Values: "hypothesis_design",
      "results_evaluation", "experiment_revisions",
      "knowledge_searches", "systematic_progression", "other",
      "no_records_kept".
  11. \`new_knowledge_purpose\` (≤4000 chars): the purpose of
      generating the new knowledge — what gap it fills and how it
      advances the field beyond existing public knowledge.
  12. \`expenditure_estimate_aud\` (number, ≥0): estimated R&D
      expenditure in AUD for this activity.
  13. \`related_supporting_activity_ids\` (array of UUIDs): IDs of
      supporting activities that directly support this core activity.
      May be empty if no supporting activities are linked yet.

# Supporting Activity fields (9 fields + sub-fields, s.355-30)

When \`activity_kind = "supporting"\`, emit ALL of:

  1. \`activity_name\` (≤200 chars): concise descriptive name.
  2. \`description\` (≤4000 chars): what the activity involves.
  3. \`supports_core_activity_ids\` (array of UUIDs, ≥1): which
     core activities this supports.
  4. \`how_supports_core_rd\` (≤4000 chars): explain how this
     activity directly supports the nominated core R&D activities.
  5. \`who_performed_work\`: who performed the work. Values:
     "r_and_d_company_only", "r_and_d_company_and_others",
     "subsidiary_or_group_or_others", "others_only".
  6. \`dates_conducted\`: { start: "YYYY-MM-DD", end: "YYYY-MM-DD" }.
  7. \`expenditure_estimate_aud\` (number, ≥0): estimated R&D
     expenditure in AUD.
  8. \`produces_good_or_service\` (boolean): whether this activity
     produces a good or service.
  9. \`dominant_purpose\`: { is_dominant_purpose: true,
     explanation: "≤4000 chars" }. Explain why the dominant purpose
     of this activity is to support the nominated core R&D.
     \`is_dominant_purpose\` MUST be \`true\` — a supporting activity
     that fails the dominant-purpose test is ineligible.
  10. \`evidence_kept\` (≤4000 chars): what evidence has been kept
      for this supporting activity.

# Writing standards

  - Australian English.
  - Technical narrative, third person ("the team", "the claimant").
  - Every factual claim must be traceable to the evidence stream.
  - Be specific: name variables, parameters, mechanisms, dates.
  - Avoid marketing register, superlatives, and vague assertions.
  - Each field is self-contained: an auditor reading one field in
    isolation must understand it without cross-referencing others.

# Multi-cycle context (when \`prior_fy_context\` is present)

The activity spans multiple fiscal years. \`prior_fy_context\` contains
excerpts from earlier years' narrative segments. Use these ONLY to
verify your draft is trajectory-consistent. Do NOT quote or paraphrase
prior-year text. Do NOT cite prior-year events.

# Closing instruction

Emit one \`emit_portal_fields\` tool call with all fields for the
activity's kind. Do not produce free text outside the tool call.`;

registerPrompt({
  name: 'draft-narrative',
  version: PROMPT_VERSION,
  system: SYSTEM_PROMPT,
  tool: {
    name: EMIT_PORTAL_FIELDS_TOOL_NAME,
    description: EMIT_PORTAL_FIELDS_TOOL_DESCRIPTION,
    input_schema: emitPortalFieldsToolSchema,
  },
});
