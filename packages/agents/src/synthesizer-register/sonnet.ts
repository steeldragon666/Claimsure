import type { ProposedActivity } from '@cpa/schemas';
import { getAnthropicClient } from '../runtime/anthropic-client.js';
import { getPrompt } from '../runtime/prompt-registry.js';
import { callWithToolUse } from '../runtime/tool-use.js';
import './prompts/synthesize-register@1.0.0.js'; // side-effect: register prompt
import type { RegisterSynthesizer, SynthesizerInput, SynthesizerOutput } from './types.js';

const MODEL = process.env.ACTIVITY_REGISTER_SYNTHESIZER_MODEL ?? 'claude-sonnet-4-5';
const PROMPT_KEY = 'synthesize-register@1.0.0';

/**
 * Structural shape returned by the `synthesize_register` tool. Mirrors
 * `synthesizeRegisterToolSchema` (which is `ActivityRegisterDraftedPayload`
 * minus the server-injected fields). Declared as a local type so we don't have
 * to import the schema at runtime — the prompt module already does that as a
 * side-effect.
 */
type SynthesizeRegisterToolOutput = {
  proposed_activities: ProposedActivity[];
  unclustered_event_ids: string[];
  total_input_events: number;
  events_truncated: boolean;
  synthesizer_notes: string;
};

/**
 * Production register synthesizer backed by the Anthropic SDK + Claude Sonnet.
 *
 * The `import './prompts/synthesize-register@1.0.0.js'` side-effect import is
 * what registers the versioned prompt with the runtime registry — without it
 * `getPrompt(PROMPT_KEY)` would throw on first synthesize() call.
 *
 * Mirror of {@link HaikuClassifier}, just pinned to Sonnet 4.5 because the
 * clustering task is significantly more open-ended than per-event
 * classification and benefits from the larger model.
 */
export class SonnetRegisterSynthesizer implements RegisterSynthesizer {
  async synthesize(input: SynthesizerInput): Promise<SynthesizerOutput> {
    const prompt = getPrompt<SynthesizeRegisterToolOutput>(PROMPT_KEY);
    const userMessage = JSON.stringify(input);
    const { output, tokens_in, tokens_out } = await callWithToolUse(getAnthropicClient(), {
      model: MODEL,
      system: prompt.system,
      user: userMessage,
      tool: prompt.tool,
      // Synthesis bundles can be large (≤200 events × prose); raise the
      // default to leave headroom for up to 30 proposed activities + notes.
      max_tokens: 8192,
    });
    return {
      proposed_activities: output.proposed_activities,
      unclustered_event_ids: output.unclustered_event_ids,
      total_input_events: output.total_input_events,
      events_truncated: output.events_truncated,
      synthesizer_notes: output.synthesizer_notes,
      model: MODEL,
      prompt_version: PROMPT_KEY,
      tokens_in,
      tokens_out,
    };
  }
}
