import { z } from 'zod';

/**
 * Output schema for the application-drafter agent.
 *
 * Mirrors the AusIndustry RDTI portal field structure verbatim — one record
 * per registered R&D activity, 13 fields per core activity (the supporting
 * activity record set is shorter). The reference output that pins this
 * schema lives at `docs/product/exemplars/ausindustry-application-FY25-26-gold.txt`.
 *
 * Prose fields cap at 30,000 chars (matching the document-analyzer schema
 * change in commit 768dc72). The AusIndustry portal itself accepts 4,000
 * chars per field, so the 30K cap leaves room for the model to overrun
 * slightly and the renderer to truncate at portal-paste time.
 *
 * Cross-cutting structures (hypothesis register H1..HN, failure register
 * F1..FN, new-knowledge register NK1..NKN, nexus matrix) live at the
 * application level — drafted once after all activity records are produced.
 */

const MAX_PROSE = 30_000;

/** Multi-select for FIELD 3 — how the company determined outcome unknown in advance. */
export const OutcomeUnknownReason = z.enum([
  'no_applicable_literature',
  'expert_advice_confirmed_no_solution',
  'no_adaptation_from_other_companies',
  'other',
]);
export type OutcomeUnknownReason = z.infer<typeof OutcomeUnknownReason>;

/** Multi-select for FIELD 10 — what evidence was kept. */
export const EvidenceKeptKind = z.enum([
  'hypothesis_and_experiment_design',
  'documented_results_and_evaluation',
  'revisions_in_response_to_results',
  'searches_for_current_knowledge',
  'systematic_progression_of_work',
  'other',
]);
export type EvidenceKeptKind = z.infer<typeof EvidenceKeptKind>;

/**
 * One core R&D activity record — the full 13-field set the AusIndustry
 * portal asks for per activity. See README at docs/product/exemplars/.
 */
export const CoreActivityRecord = z.object({
  /** Code: "CA-01" .. "CA-NN". The drafter is responsible for numbering. */
  activity_id: z.string().regex(/^CA-\d{2}$/, 'must be CA-NN'),
  /** Project phases this activity spans, free text. */
  project_phases: z.string().min(1).max(MAX_PROSE),
  /** Period within FY, free text (e.g. "Oct 2025 – Feb 2026"). */
  period: z.string().min(1).max(200),
  /** Estimated expenditure ex-GST, AUD. */
  estimated_expenditure_aud_ex_gst: z.number().nonnegative(),
  /** Linked hypothesis IDs (H1, H2, ...). Drafter mints these. */
  hypothesis_ids: z.array(z.string().regex(/^H\d+$/, 'must be HN')),
  /** Linked supporting-activity codes (SA-01, SA-02, ...). */
  linked_supporting_activity_ids: z.array(z.string().regex(/^SA-\d{2}$/, 'must be SA-NN')),

  // ─── The 13 portal fields ───
  field_1_activity_name: z.string().min(1).max(MAX_PROSE),
  field_2_describe: z.string().min(1).max(MAX_PROSE),
  field_3_outcome_unknown_reasons: z.array(OutcomeUnknownReason).min(1),
  field_4_sources_investigated: z.string().min(1).max(MAX_PROSE),
  field_5_competent_professional: z.string().min(1).max(MAX_PROSE),
  field_6_hypothesis: z.string().min(1).max(MAX_PROSE),
  field_7_experiment: z.string().min(1).max(MAX_PROSE),
  field_8_evaluation: z.string().min(1).max(MAX_PROSE),
  field_9_conclusions: z.string().min(1).max(MAX_PROSE),
  field_10_evidence_kept: z.array(EvidenceKeptKind).min(1),
  field_11_new_knowledge_purpose: z.boolean(),
  field_11_new_knowledge_description: z.string().min(1).max(MAX_PROSE),
  field_12_expenditure_breakdown: z.string().min(1).max(MAX_PROSE),
  field_13_related_supporting_activities_summary: z.string().min(1).max(MAX_PROSE),
});
export type CoreActivityRecord = z.infer<typeof CoreActivityRecord>;

/**
 * Supporting activity record — reduced field set. Supporting activities
 * don't need to satisfy the systematic-experimentation test (s.355-25);
 * they need to satisfy the dominant-purpose test (s.355-30). The portal
 * asks fewer + shorter questions.
 */
export const SupportingActivityRecord = z.object({
  activity_id: z.string().regex(/^SA-\d{2}$/, 'must be SA-NN'),
  project_phases: z.string().min(1).max(MAX_PROSE),
  period: z.string().min(1).max(200),
  estimated_expenditure_aud_ex_gst: z.number().nonnegative(),
  /** Core-activity codes this supporting activity enables. */
  supports_core_activity_ids: z.array(z.string().regex(/^CA-\d{2}$/, 'must be CA-NN')).min(1),
  field_name: z.string().min(1).max(MAX_PROSE),
  field_description: z.string().min(1).max(MAX_PROSE),
  /** The dominant-purpose justification (§355-30). */
  field_dominant_purpose: z.string().min(1).max(MAX_PROSE),
  field_evidence_kept: z.array(EvidenceKeptKind).min(1),
});
export type SupportingActivityRecord = z.infer<typeof SupportingActivityRecord>;

/**
 * Cross-cutting registers that map to existing chain event kinds:
 *   HYPOTHESIS events → hypothesis_register entries
 *   ITERATION events  → failure_register entries
 *   NEW_KNOWLEDGE events → new_knowledge_register entries
 */
export const HypothesisRegisterEntry = z.object({
  /** "H1" .. "HN". */
  id: z.string().regex(/^H\d+$/, 'must be HN'),
  hypothesis_text: z.string().min(1).max(MAX_PROSE),
  pre_registered_at: z.string().min(1).max(50),
  falsifiable_criteria: z.string().min(1).max(MAX_PROSE),
  validation_outcome: z.enum(['validated', 'partially_validated', 'failed', 'pending']),
  validation_summary: z.string().min(1).max(MAX_PROSE),
  /** Which activity this hypothesis belongs to. */
  activity_id: z.string().regex(/^CA-\d{2}$/, 'must be CA-NN'),
});
export type HypothesisRegisterEntry = z.infer<typeof HypothesisRegisterEntry>;

export const FailureRegisterEntry = z.object({
  id: z.string().regex(/^F\d+$/, 'must be FN'),
  approach_attempted: z.string().min(1).max(MAX_PROSE),
  result_observed: z.string().min(1).max(MAX_PROSE),
  root_cause: z.string().min(1).max(MAX_PROSE),
  knowledge_gained: z.string().min(1).max(MAX_PROSE),
  pivot_action: z.string().min(1).max(MAX_PROSE),
  activity_id: z.string().regex(/^CA-\d{2}$/, 'must be CA-NN'),
});
export type FailureRegisterEntry = z.infer<typeof FailureRegisterEntry>;

export const NewKnowledgeRegisterEntry = z.object({
  id: z.string().regex(/^NK\d+$/, 'must be NKN'),
  contribution: z.string().min(1).max(MAX_PROSE),
  quantification: z.string().min(1).max(MAX_PROSE),
  not_knowable_in_advance_because: z.string().min(1).max(MAX_PROSE),
  activity_id: z.string().regex(/^CA-\d{2}$/, 'must be CA-NN'),
});
export type NewKnowledgeRegisterEntry = z.infer<typeof NewKnowledgeRegisterEntry>;

/** Full output: complete portal-ready application. */
export const ApplicationDraft = z.object({
  /** Applicant identity. */
  applicant: z.object({
    name: z.string().min(1).max(500),
    abn: z.string().max(50).nullable(),
    anzsic_division_class: z.string().min(1).max(500),
  }),
  /** Income year, formatted FYNNNN-NN. */
  income_year: z.string().regex(/^FY\d{4}-\d{2}$/, 'must be FY2025-26 format'),
  /** Project-level overview. */
  project: z.object({
    name: z.string().min(1).max(500),
    description: z.string().min(1).max(MAX_PROSE),
    started_at: z.string().min(1).max(50),
    ended_at: z.string().min(1).max(50).nullable(),
  }),
  /** All core + supporting activity records. */
  core_activities: z.array(CoreActivityRecord),
  supporting_activities: z.array(SupportingActivityRecord),
  /** Cross-cutting registers. */
  hypothesis_register: z.array(HypothesisRegisterEntry),
  failure_register: z.array(FailureRegisterEntry),
  new_knowledge_register: z.array(NewKnowledgeRegisterEntry),
  /** Submission summary prose. ~400 words covering activity list + nexus matrix narrative. */
  submission_summary: z.string().min(1).max(MAX_PROSE),
  /** Compliance checklist + submission notes. */
  compliance_notes: z.string().min(1).max(MAX_PROSE),
});
export type ApplicationDraft = z.infer<typeof ApplicationDraft>;

/** Input to the application-drafter agent. */
export type ApplicationDrafterInput = {
  applicant: { name: string; abn: string | null };
  income_year: string; // "FY2025-26"
  project: {
    name: string;
    description: string | null;
    started_at: string;
    ended_at: string | null;
  };
  /**
   * Every classified evidence event for the claimant in this fiscal year.
   * The drafter receives the rich Haiku output (classifications + activity
   * proposals + invoices + summaries) and synthesizes them into the
   * AusIndustry-portal-ready ApplicationDraft above.
   */
  events: Array<{
    id: string;
    kind: string;
    classification: {
      kind: string;
      rationale: string;
      confidence: number;
      statutory_anchor: string;
    } | null;
    extracted_content: {
      document_summary: string | null;
      activities: Array<{
        proposed_name: string;
        proposed_kind: 'core' | 'supporting';
        hypothesis_text: string;
        technical_uncertainty: string;
        expected_outcome: string;
        rationale: string;
        source_excerpt: string;
        confidence: number;
      }>;
      invoices: Array<{
        vendor_name: string;
        invoice_date: string;
        total_aud: number;
        line_items: Array<{ description: string; amount_aud: number }>;
      }>;
    } | null;
    captured_at: string;
    filename: string | null;
  }>;
};

/**
 * Token usage from the drafter call. The drafter is the single most
 * expensive agent in the system (~$0.50/call typical, ~$1.50 worst case)
 * so the usage record drives both the per-claim budget gate and the
 * "you're approaching the A$50 envelope" UX banner.
 *
 * `null` from stub implementations only.
 */
export type ApplicationDrafterUsage = {
  model: string;
  tokens_in: number;
  tokens_out: number;
};

export interface ApplicationDrafterResult {
  output: ApplicationDraft;
  usage: ApplicationDrafterUsage | null;
}

export interface ApplicationDrafter {
  draft(input: ApplicationDrafterInput): Promise<ApplicationDrafterResult>;
}
