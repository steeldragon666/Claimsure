import { getAnthropicClient } from '../runtime/anthropic-client.js';
import { getPrompt } from '../runtime/prompt-registry.js';
import { callWithToolUse } from '../runtime/tool-use.js';
import './prompts/evaluate-signup@1.0.0.js'; // side-effect: registers the prompt
import type { SignupEvaluator, SignupEvaluatorInput, SignupEvaluatorOutput } from './types.js';
import type { EvaluateSignupToolInput } from './prompts/evaluate-signup@1.0.0.js';

/**
 * Default model: Claude Haiku 4.5. The signup decision is a low-stakes
 * cheap-classification problem — short structured input, short structured
 * output, run synchronously inside POST /v1/auth/signup with a 2-second
 * latency budget. Opus 4.7 is overkill here; the cost difference matters
 * because every signup pays the call. Override via SIGNUP_EVALUATOR_MODEL
 * if a future deployment wants to A/B against a deeper model.
 *
 * The class is named `OpusSignupEvaluator` to match the brief and the
 * naming pattern used elsewhere in the codebase (OpusClassifier,
 * HaikuAutoAllocator), even though the default model is Haiku. The class
 * name describes "lives in the Opus-style production lane" — the env
 * var, not the class, controls which model fires.
 */
// process.env.SIGNUP_EVALUATOR_MODEL is a STRING (or undefined). Using ?? here
// would propagate empty strings ('') through to the Anthropic SDK and produce a
// confusing 400 "model required" deep in the request. Trim + coalesce on a
// falsy result so any whitespace-only override falls back to the default.
const MODEL = process.env.SIGNUP_EVALUATOR_MODEL?.trim() || 'claude-haiku-4-5';
const PROMPT_KEY = 'evaluate-signup@1.0.0';

/**
 * Maximum wall-clock for a single signup evaluator call. The signup pipeline's
 * latency budget is ~2s (the browser tab is blocked behind the response). The
 * shared Anthropic client defaults to 30s — way too long for this path. We
 * AbortSignal-timeout aggressively so a slow Anthropic landing collapses to
 * the pipeline's `infra_failure_permissive` fallback within the budget, rather
 * than leaving the user staring at a spinner.
 */
const SIGNUP_EVAL_TIMEOUT_MS = 2000;

export class OpusSignupEvaluator implements SignupEvaluator {
  async evaluate(input: SignupEvaluatorInput): Promise<SignupEvaluatorOutput> {
    const prompt = getPrompt<EvaluateSignupToolInput>(PROMPT_KEY);

    // Compose the user message. Keep it compact — the schema is small and
    // verbose framing would waste tokens on every signup.
    const abrSection =
      input.abr_match.length === 0
        ? '(no ABR matches — either ABR_GUID is unset, the call failed, or the firm is not registered)'
        : input.abr_match
            .map(
              (m, i) =>
                `  ${i + 1}. ${m.matched_name} — ABN ${m.abn ?? 'n/a'} — ${m.entity_type ?? 'unknown entity'} — ${m.abn_status ?? 'unknown status'} — ${m.registration_state ?? 'unknown state'}`,
            )
            .join('\n');

    const userMessage = `## Signup attempt
email:        ${input.email}
firm_name:    ${input.firm_name}
display_name: ${input.display_name ?? '(none)'}

## ABR matches (top 5)
${abrSection}`;

    const { output, tokens_in, tokens_out } = await callWithToolUse(getAnthropicClient(), {
      model: MODEL,
      system: prompt.system,
      user: userMessage,
      tool: prompt.tool,
      max_tokens: 512,
      signal: AbortSignal.timeout(SIGNUP_EVAL_TIMEOUT_MS),
    });

    return {
      decision: output.decision,
      confidence: output.confidence,
      rationale: output.rationale,
      red_flags: output.red_flags,
      model: MODEL,
      prompt_version: PROMPT_KEY,
      tokens_in,
      tokens_out,
    };
  }
}
