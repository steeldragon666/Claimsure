/**
 * ip-search-verdict agent.
 *
 * Drafts a PASS / FAIL / INCONCLUSIVE verdict on an R&D hypothesis given
 * the prior-art hits returned from the four database integrations
 * (IP Australia, Semantic Scholar, PubMed, arXiv).
 *
 * # Authority model
 *
 * The verdict is ANALYST-REVIEWED. See Q3 of the design doc — the LLM
 * drafts, the consultant approves or overrides at the wizard UI layer.
 * This agent is never the final word, and we never persist its verdict
 * as "approved" without consultant action.
 *
 * # Architecture
 *
 *   - Pure function in/out: input is `{ hypothesis, hits }`, output is
 *     `{ verdict, analysisMarkdown }`.
 *   - DB writes ONLY for the `llm_token_usage` ledger row.
 *   - Anthropic client injected via opts.client.
 *   - Prompt text lives in `prompts.ts`.
 *
 * # Model
 *
 * `claude-sonnet-4-5` by default — matches application-drafter /
 * narrative-drafter. Override via `IP_SEARCH_VERDICT_MODEL` env var.
 *
 * # Billing
 *
 * Writes a row to `llm_token_usage` with `agent_name =
 * 'ip-search-verdict'` via `recordUsage()`. Skipped if `sqlFn /
 * tenantId` absent (unit tests).
 */
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { recordUsage, type TaggedSql } from '../runtime/token-ledger.js';
import {
  SYSTEM_PROMPT,
  buildUserMessage,
  EMIT_VERDICT_TOOL_NAME,
  EMIT_VERDICT_TOOL_DESCRIPTION,
  type IpSearchHitForPrompt,
} from './prompts.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The three terminal verdicts a draft can settle on. */
export type IpSearchVerdict = 'pass' | 'fail' | 'inconclusive';

/**
 * Prior-art hit handed to the agent. Identical structural shape to the
 * `IpSearchHitForPrompt` interface in `prompts.ts`; re-exported here so
 * callers can `import type { IpSearchHit } from '@cpa/agents'` without
 * reaching into the prompts module.
 *
 * The integration packages (IP Australia / Semantic Scholar / PubMed /
 * arXiv — see PRs #84/#85/#86) will return hits with this shape (plus
 * additional database-specific fields). The agent only consumes the
 * subset declared here.
 */
export type IpSearchHit = IpSearchHitForPrompt;

/** Validated output of `draftVerdict`. */
export interface DraftedVerdict {
  verdict: IpSearchVerdict;
  /** Markdown analysis, 200-500 words; cites hits by [externalId]. */
  analysisMarkdown: string;
}

/**
 * Tool input schema. The wire shape uses `analysis_markdown` (snake) to
 * match the prompt's emitted field name; the public surface re-keys to
 * `analysisMarkdown` (camel) to match TypeScript conventions in this
 * repo.
 */
export const verdictToolSchema = z
  .object({
    verdict: z.enum(['pass', 'fail', 'inconclusive']),
    analysis_markdown: z.string().min(50).max(8000),
  })
  .strict();

/** Options for `draftVerdict`. */
export interface DraftVerdictOptions {
  hypothesis: string;
  hits: ReadonlyArray<IpSearchHit>;
  /** Injected Anthropic SDK client. */
  client: Pick<Anthropic, 'messages'>;
  /** Tenant the call bills to. */
  tenantId?: string;
  /** Claim the call bills against. */
  claimId?: string;
  /** Optional postgres-js TaggedSql for ledger writes. Skipped if absent. */
  sqlFn?: TaggedSql;
  /** Model override. */
  model?: string;
  /** AbortSignal so callers can interrupt the call. */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = process.env.IP_SEARCH_VERDICT_MODEL ?? 'claude-sonnet-4-5';
const MAX_TOKENS = 4096;

/**
 * JSON-schema mirror of `verdictToolSchema`. Hand-rolled (see same
 * comment in ip-search-query/index.ts).
 */
const TOOL_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    verdict: {
      type: 'string',
      enum: ['pass', 'fail', 'inconclusive'],
      description:
        'PASS = genuinely novel; FAIL = anticipated by prior art; INCONCLUSIVE = mixed/insufficient evidence.',
    },
    analysis_markdown: {
      type: 'string',
      minLength: 50,
      maxLength: 8000,
      description:
        '200-500 word markdown analysis citing relevant hits by [externalId]. Ends with the canonical concluding sentence.',
    },
  },
  required: ['verdict', 'analysis_markdown'],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class IpSearchVerdictConfigError extends Error {
  override readonly name = 'IpSearchVerdictConfigError';
}
export class IpSearchVerdictUpstreamError extends Error {
  override readonly name = 'IpSearchVerdictUpstreamError';
}
export class IpSearchVerdictParseError extends Error {
  override readonly name = 'IpSearchVerdictParseError';
  /** First 500 chars of the model's raw tool-use input. */
  readonly rawSnippet: string;
  constructor(message: string, rawSnippet: string) {
    super(message);
    this.rawSnippet = rawSnippet.slice(0, 500);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Draft a prior-art verdict from a hypothesis + hits.
 *
 * Single Anthropic call with structured-output tool forcing. Returns
 * the validated `DraftedVerdict`; writes a ledger row if `sqlFn +
 * tenantId` are provided.
 *
 * Special case: when `hits.length === 0`, the system prompt instructs
 * the model to return `pass` with "no prior art found" reasoning. We
 * do NOT short-circuit this in code — letting the LLM produce the
 * analysis_markdown keeps the output shape uniform and gives the
 * consultant a piece of prose to review.
 *
 * @throws {IpSearchVerdictConfigError} on invalid input
 * @throws {IpSearchVerdictUpstreamError} on Anthropic transport failure or missing tool_use block
 * @throws {IpSearchVerdictParseError} when tool input fails Zod validation
 * @throws {DOMException} 'AbortError' when the signal fires
 */
export async function draftVerdict(opts: DraftVerdictOptions): Promise<DraftedVerdict> {
  if (typeof opts.hypothesis !== 'string' || opts.hypothesis.trim().length === 0) {
    throw new IpSearchVerdictConfigError('hypothesis must be a non-empty string');
  }
  if (!Array.isArray(opts.hits)) {
    throw new IpSearchVerdictConfigError('hits must be an array (use [] for "no hits")');
  }
  if (!opts.client) {
    throw new IpSearchVerdictConfigError('opts.client (Anthropic SDK client) is required');
  }

  const model = opts.model ?? DEFAULT_MODEL;

  let response: Anthropic.Messages.Message;
  try {
    response = await opts.client.messages.create(
      {
        model,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserMessage(opts.hypothesis, opts.hits) }],
        tools: [
          {
            name: EMIT_VERDICT_TOOL_NAME,
            description: EMIT_VERDICT_TOOL_DESCRIPTION,
            input_schema: TOOL_INPUT_SCHEMA,
          },
        ],
        tool_choice: { type: 'tool', name: EMIT_VERDICT_TOOL_NAME },
      },
      { signal: opts.signal },
    );
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new IpSearchVerdictUpstreamError(`Anthropic call failed: ${(err as Error).message}`, {
      cause: err,
    });
  }

  const toolUseBlock = response.content.find(
    (c): c is Anthropic.Messages.ToolUseBlock =>
      c.type === 'tool_use' && c.name === EMIT_VERDICT_TOOL_NAME,
  );
  if (!toolUseBlock) {
    throw new IpSearchVerdictUpstreamError(
      `model did not invoke the ${EMIT_VERDICT_TOOL_NAME} tool`,
    );
  }

  const parseResult = verdictToolSchema.safeParse(toolUseBlock.input);
  if (!parseResult.success) {
    const issues = parseResult.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new IpSearchVerdictParseError(
      `verdict tool input failed validation: ${issues}`,
      JSON.stringify(toolUseBlock.input).slice(0, 500),
    );
  }

  // Re-key snake → camel for the public surface.
  const drafted: DraftedVerdict = {
    verdict: parseResult.data.verdict,
    analysisMarkdown: parseResult.data.analysis_markdown,
  };

  if (opts.sqlFn && opts.tenantId) {
    await recordUsage(opts.sqlFn, {
      tenant_id: opts.tenantId,
      claim_id: opts.claimId ?? null,
      subject_tenant_id: null,
      agent_name: 'ip-search-verdict',
      model,
      tokens_in: response.usage.input_tokens,
      tokens_out: response.usage.output_tokens,
    });
  }

  return drafted;
}
