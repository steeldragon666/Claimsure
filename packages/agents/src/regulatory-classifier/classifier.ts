import type Anthropic from '@anthropic-ai/sdk';
import { getAnthropicClient } from '../runtime/anthropic-client.js';
import { RegulatoryClassification } from './prompts/regulatory-classify@1.0.0.js';
import type { ClassifyEventInput, RegulatoryClassificationType } from './types.js';

const DEFAULT_MODEL = 'claude-sonnet-4-5-20250514';
const MAX_TOKENS = 2048;

export interface ClassifyOptions {
  anthropic?: Anthropic;
  model?: string;
}

/**
 * Classify a single regulatory event.
 *
 * Calls the Anthropic API with the regulatory-classify@1.0.0 system prompt
 * and returns a validated RegulatoryClassification or null on parse failure.
 */
export async function classifyEvent(
  input: ClassifyEventInput,
  options: ClassifyOptions = {},
): Promise<RegulatoryClassificationType | null> {
  const { model = DEFAULT_MODEL } = options;
  const anthropic = options.anthropic ?? getAnthropicClient();

  // Import SYSTEM_PROMPT here to avoid circular registration issues
  const { SYSTEM_PROMPT } = await import('./prompts/regulatory-classify@1.0.0.js');

  const userMessage = JSON.stringify({
    event_id: input.event_id,
    raw_title: input.raw_title,
    raw_content: input.raw_content,
    source_name: input.source_name,
    source_url: input.source_url ?? null,
  });

  const response = await anthropic.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') return null;

  // Extract JSON (may be wrapped in markdown code block)
  let jsonStr = textBlock.text;
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) jsonStr = jsonMatch[1]!;

  try {
    const parsed = RegulatoryClassification.safeParse(JSON.parse(jsonStr));
    if (!parsed.success) return null;
    return parsed.data;
  } catch {
    return null;
  }
}
