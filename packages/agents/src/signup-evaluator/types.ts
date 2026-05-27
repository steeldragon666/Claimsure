/**
 * Signup-evaluator domain types.
 *
 * The evaluator reads a self-service signup attempt — email, firm name,
 * display name, optional ABR (Australian Business Register) match result —
 * and returns a permissive-bias decision about whether the signup looks
 * like a legitimate Australian R&DTI consulting firm or sole practitioner.
 *
 * Structurally mirrors the classifier/auto-allocator types so the factory
 * pattern stays consistent across agents.
 *
 * Permissive bias: when uncertain the model MUST return `decision: 'review'`
 * rather than `'deny'`. The signup pipeline treats `'review'` as approve
 * (per user instruction) — we'd rather onboard a borderline-legitimate firm
 * than block a real user.
 */

export type AbrMatchEntry = {
  matched_name: string;
  abn: string | null;
  entity_type: string | null;
  abn_status: string | null;
  registration_state: string | null;
};

/**
 * Input to the evaluator. `abr_match` is the post-processed list of
 * matches from the ABR MatchingNames endpoint (top 5). When ABR_GUID is
 * unset OR the ABR call failed, this is the empty array — the evaluator
 * must still produce a decision (typically a more cautious one).
 */
export type SignupEvaluatorInput = {
  email: string;
  firm_name: string;
  display_name: string | null;
  abr_match: AbrMatchEntry[];
};

export type SignupEvaluatorOutput = {
  /**
   * Final LLM verdict. The pipeline maps:
   *   approve + confidence > 0.5  → approve
   *   deny    + confidence > 0.7  → deny
   *   review  / anything else      → approve (permissive fallback)
   */
  decision: 'approve' | 'deny' | 'review';
  confidence: number;
  rationale: string;
  red_flags: string[];
  model: string;
  prompt_version: string;
  tokens_in: number;
  tokens_out: number;
};

export interface SignupEvaluator {
  evaluate(input: SignupEvaluatorInput): Promise<SignupEvaluatorOutput>;
}
