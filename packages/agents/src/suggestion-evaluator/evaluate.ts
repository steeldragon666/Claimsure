import type Anthropic from '@anthropic-ai/sdk';
import { promptSuggestionEvaluateToolSchema } from './types.js';
import type { PromptSuggestionEvaluation } from './types.js';
import { SYSTEM_PROMPT } from './prompts/prompt-suggestion-evaluate@1.0.0.js';
import { repoTools, dispatchRepoTool } from './repo-tools.js';
import { getAnthropicClient } from '../runtime/anthropic-client.js';

/**
 * Local structural interface for the suggestion shape this evaluator
 * consumes. Identical shape to `PromptSuggestionForChoreography` in
 * `@cpa/integrations/github-app`, but cannot be imported from there
 * because adding `@cpa/integrations` as a dependency of `@cpa/agents`
 * would create a TypeScript project-reference cycle (integrations
 * already depends on agents).
 *
 * TODO(#28): once prompt-suggestion enums + input schemas are
 * promoted to `@cpa/schemas`, replace this with the canonical type
 * from there. Until that lands, the structural-typing equivalence
 * means a real `PromptSuggestionForChoreography` value satisfies this
 * interface at the call site, with no runtime cost.
 */
export interface EvaluateSuggestionInput {
  id: string;
  tenant_id: string;
  flagged_by_user_id: string;
  source_kind: 'consultant_flag' | 'rif_event' | 'contract_test_failure' | 'reviewer_disposition';
  affected_prompt_module: string | null;
  affected_section_kind: string | null;
  issue_summary: string;
}

export interface EvaluateInput {
  suggestion: EvaluateSuggestionInput;
  repoRoot: string;
  /** DI seam — defaults to a lazy `getAnthropicClient()` from runtime/anthropic-client.ts. */
  anthropic?: Anthropic;
  /** Defaults to `'claude-opus-4-7'`. */
  model?: string;
  /** Cap on tool-use loop iterations. Defaults to 12. */
  maxTurns?: number;
  /** AbortSignal so the 5-min handler timeout can interrupt the call. */
  signal?: AbortSignal;
}

/**
 * Render the suggestion as the initial user message for the Anthropic
 * conversation. The model receives this JSON as its first user turn.
 */
function renderSuggestionContext(suggestion: EvaluateSuggestionInput): string {
  return JSON.stringify(
    {
      suggestion_id: suggestion.id,
      source_kind: suggestion.source_kind,
      source_payload: null,
      affected_prompt_module: suggestion.affected_prompt_module,
      affected_section_kind: suggestion.affected_section_kind,
      issue_summary: suggestion.issue_summary,
    },
    null,
    2,
  );
}

/**
 * Convert the existing `repoTools` registry into the Anthropic SDK's
 * `Tool` shape. The tool definitions are static — they describe what
 * the model can invoke during the conversation.
 */
function anthropicToolDefinitions(): Anthropic.Messages.Tool[] {
  return repoTools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

/**
 * Production evaluator: takes a prompt-suggestion + repo root, runs the
 * Anthropic-driven tool-use loop with the SYSTEM_PROMPT and read-only
 * repo tools, returns the proposed change set.
 *
 * The handler at apps/api/src/routes/prompt-suggestions.ts:739 calls
 * this through the `deps.evaluate` injection point; production wiring
 * lives in apps/api/src/server.ts.
 *
 * Throws structured errors so the handler error map (line 845-870)
 * can produce the right HTTP code + structured detail.
 */
export async function evaluate(input: EvaluateInput): Promise<PromptSuggestionEvaluation> {
  // Resolve the Anthropic client — DI seam or lazy singleton.
  let anthropic: Anthropic;
  if (input.anthropic) {
    anthropic = input.anthropic;
  } else {
    try {
      anthropic = getAnthropicClient();
    } catch {
      throw new EvaluatorConfigError(
        'ANTHROPIC_API_KEY is not set and no Anthropic client was injected.',
      );
    }
  }

  const model = input.model ?? 'claude-opus-4-7';
  const maxTurns = input.maxTurns ?? 12;

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: 'user', content: renderSuggestionContext(input.suggestion) },
  ];

  for (let turn = 1; turn <= maxTurns; turn++) {
    // Check abort before each Anthropic call.
    if (input.signal?.aborted) {
      throw new DOMException('This operation was aborted', 'AbortError');
    }

    let response: Anthropic.Messages.Message;
    try {
      response = await anthropic.messages.create(
        {
          model,
          system: SYSTEM_PROMPT,
          messages,
          tools: anthropicToolDefinitions(),
          max_tokens: 8192,
        },
        { signal: input.signal },
      );
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw err;
      throw new EvaluatorUpstreamError(
        `Anthropic call failed at turn ${turn}: ${(err as Error).message}`,
        { cause: err },
      );
    }

    if (response.stop_reason === 'tool_use') {
      // Append assistant turn, then dispatch each tool and build tool_result blocks.
      messages.push({ role: 'assistant', content: response.content });

      const toolResults = await Promise.all(
        response.content
          .filter((block): block is Anthropic.Messages.ToolUseBlock => block.type === 'tool_use')
          .map(async (block) => {
            try {
              const result = await dispatchRepoTool(input.repoRoot, block.name, block.input);
              return {
                type: 'tool_result' as const,
                tool_use_id: block.id,
                content: JSON.stringify(result),
              };
            } catch (toolErr) {
              return {
                type: 'tool_result' as const,
                tool_use_id: block.id,
                content: (toolErr as Error).message,
                is_error: true as const,
              };
            }
          }),
      );
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // stop_reason === 'end_turn' (or similar) — extract final text and parse.
    const finalText = response.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(finalText);
    } catch {
      throw new EvaluatorParseError(
        `Final response is not valid JSON after ${turn} turn(s)`,
        finalText.slice(0, 500),
      );
    }

    const validation = promptSuggestionEvaluateToolSchema.safeParse(parsed);
    if (!validation.success) {
      throw new EvaluatorParseError(
        `Final response failed Zod validation: ${validation.error.message}`,
        finalText.slice(0, 500),
      );
    }
    return validation.data;
  }

  throw new EvaluatorLoopExhaustedError(
    `Evaluator did not produce a final answer within ${maxTurns} turns`,
    maxTurns,
  );
}

export class EvaluatorConfigError extends Error {
  override readonly name = 'EvaluatorConfigError';
}
export class EvaluatorUpstreamError extends Error {
  override readonly name = 'EvaluatorUpstreamError';
}
export class EvaluatorParseError extends Error {
  override readonly name = 'EvaluatorParseError';
  /** First 500 chars of the unparseable response, for triage. Truncated by the constructor. */
  readonly rawSnippet: string;
  constructor(message: string, rawSnippet: string) {
    super(message);
    this.rawSnippet = rawSnippet.slice(0, 500);
  }
}
export class EvaluatorLoopExhaustedError extends Error {
  override readonly name = 'EvaluatorLoopExhaustedError';
  readonly turnsUsed: number;
  constructor(message: string, turnsUsed: number) {
    super(message);
    this.turnsUsed = turnsUsed;
  }
}
