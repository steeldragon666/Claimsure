import { getAnthropicClient } from '../runtime/anthropic-client.js';
import { getPrompt } from '../runtime/prompt-registry.js';
import { callWithToolUse } from '../runtime/tool-use.js';
import './prompts/classify@1.0.0.js'; // side-effect: registers the prompt
import type { Classifier, ClassifierInput, ClassifierOutput } from './types.js';

const MODEL = process.env.CLASSIFIER_MODEL ?? 'claude-haiku-4-5';
const PROMPT_KEY = 'classify@1.0.0';

/**
 * Production classifier backed by the Anthropic SDK + Claude Haiku.
 *
 * The `import './prompts/classify@1.0.0.js'` side-effect import is what
 * registers the versioned prompt with the runtime registry — without it
 * `getPrompt(PROMPT_KEY)` would throw at first classify() call.
 */
export class HaikuClassifier implements Classifier {
  async classify(input: ClassifierInput): Promise<ClassifierOutput> {
    const prompt = getPrompt<{
      kind: ClassifierOutput['kind'];
      confidence: number;
      rationale: string;
      statutory_anchor: string | null;
    }>(PROMPT_KEY);
    const { output, tokens_in, tokens_out } = await callWithToolUse(getAnthropicClient(), {
      model: MODEL,
      system: prompt.system,
      user: input.raw_text,
      tool: prompt.tool,
    });
    return {
      ...output,
      model: MODEL,
      prompt_version: PROMPT_KEY,
      tokens_in,
      tokens_out,
    };
  }
}
