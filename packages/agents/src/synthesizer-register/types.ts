import type { ProposedActivity } from '@cpa/schemas';

/**
 * Synthesizer-domain constants for the Agent B activity-register
 * synthesizer.
 *
 * Anchored on Australian Income Tax Assessment Act 1997, Division 355.
 * Every proposed activity is part of the R&D claim — there is no
 * `'ineligible'` option here (that lives on individual EXPENDITURE
 * classifications, not on activity-level groupings). The two
 * classifications are paired with their statutory anchors:
 *
 *   - `core`        ↔ s.355-25  (systematic experimentation)
 *   - `supporting`  ↔ s.355-30  (predominantly supports core R&D,
 *                                dominant-purpose test)
 */
export const ACTIVITY_KINDS = ['core', 'supporting'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const ACTIVITY_STATUTORY_ANCHORS = ['s.355-25', 's.355-30'] as const;
export type ActivityStatutoryAnchor = (typeof ACTIVITY_STATUTORY_ANCHORS)[number];

/** Hard cap on proposed activities per draft pass. Surfaces in the tool schema. */
export const MAX_PROPOSED_ACTIVITIES = 30;

/**
 * Compressed event shape consumed by Agent B.
 *
 * The job processor pre-projects each raw `event` row into this trimmed shape
 * before assembling the synthesizer input bundle — `summary` is a ≤50-word
 * extract from the original `payload.text`, NOT the full payload. Keeping the
 * shape narrow caps the prompt-token footprint of large evidence streams.
 *
 * `subject_tenant_id` is included so the deterministic stub implementation can
 * cluster events by `(subject_tenant_id, ISO-week)` without an additional DB
 * fetch; the Sonnet impl ignores the field but receives it verbatim.
 */
export type CompressedEvent = {
  id: string;
  kind: string;
  captured_at: string; // ISO 8601 timestamp
  summary: string; // ≤50-word extract from payload.text
  subject_tenant_id: string;
};

/**
 * Input bundle for one synthesis pass.
 *
 * `events` is capped at 200 by the caller (the job processor); when truncation
 * happens the caller sets `events_truncated = true` so the model knows the
 * stream is incomplete. `existing_activities` is the consultant-accepted
 * register — the synthesizer must NOT propose substantial duplicates of these.
 */
export type SynthesizerInput = {
  project: {
    id: string;
    name: string;
    industry_sector: string | null;
    started_at: string;
    fiscal_year: number;
  };
  events: CompressedEvent[];
  existing_activities: Array<{
    id: string;
    name: string;
    kind: ActivityKind;
    statutory_anchor: ActivityStatutoryAnchor;
    description?: string | null;
  }>;
  events_truncated: boolean;
};

/**
 * Output shape returned by every {@link RegisterSynthesizer} implementation.
 *
 * The structural fields (`proposed_activities`, `unclustered_event_ids`,
 * `total_input_events`, `events_truncated`, `synthesizer_notes`) come from
 * the model (or the stub's deterministic clustering). The metadata fields
 * (`model`, `prompt_version`, `tokens_in`, `tokens_out`) are stamped by the
 * runtime / impl after the call returns.
 */
export type SynthesizerOutput = {
  proposed_activities: ProposedActivity[];
  unclustered_event_ids: string[];
  total_input_events: number;
  events_truncated: boolean;
  synthesizer_notes: string;
  // Stamped by the impl/runtime, NOT by the model:
  model: string;
  prompt_version: string;
  tokens_in: number;
  tokens_out: number;
};

export interface RegisterSynthesizer {
  synthesize(input: SynthesizerInput): Promise<SynthesizerOutput>;
}
