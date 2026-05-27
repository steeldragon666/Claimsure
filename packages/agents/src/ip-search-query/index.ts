/**
 * ip-search-query agent.
 *
 * Generates database-specific prior-art search queries for an R&D
 * hypothesis. Single Anthropic call with structured-output tool forcing;
 * the model returns 3-5 queries per database covering IP Australia,
 * Semantic Scholar, PubMed, and arXiv.
 *
 * # Architecture
 *
 *   - Pure function in/out: input is hypothesis text; output is four
 *     arrays of strings.
 *   - DB writes ONLY for the `llm_token_usage` ledger row (skipped if
 *     no `sqlFn` is provided — unit tests run without it).
 *   - Anthropic client is INJECTED via opts.client — never instantiated
 *     here. Production callers pass the lazy singleton from
 *     `runtime/anthropic-client.ts`; unit tests pass a hand-crafted
 *     mock. This is the same DI seam used by suggestion-evaluator.
 *   - All prompt text lives in `prompts.ts` so prompt-engineering
 *     reviewers can diff the strings independently of the logic.
 *
 * # Model
 *
 * `claude-sonnet-4-5` by default — matches application-drafter /
 * narrative-drafter. Override via `IP_SEARCH_QUERY_MODEL` env var.
 * Haiku gets per-database syntax wrong too often to be worth the
 * cost saving for a once-per-hypothesis call.
 *
 * # Billing
 *
 * Every call writes one row to `llm_token_usage` with `agent_name =
 * 'ip-search-query'` via `recordUsage()`. If the caller doesn't pass
 * `sqlFn`, the ledger step is skipped — this lets unit tests run
 * without a postgres connection. Production callers MUST pass
 * `privilegedSql` (cast to `TaggedSql`) so the budget gate works.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { recordUsage, type TaggedSql } from '../runtime/token-ledger.js';
import {
  SYSTEM_PROMPT,
  buildUserMessage,
  EMIT_SEARCH_QUERIES_TOOL_NAME,
  EMIT_SEARCH_QUERIES_TOOL_DESCRIPTION,
} from './prompts.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The four databases an IP search currently fans out across. */
export type IpSearchDatabase = 'ip_australia' | 'semantic_scholar' | 'pubmed' | 'arxiv';

/** Output: per-database arrays of search query strings. */
export interface GeneratedQueries {
  ip_australia: string[];
  semantic_scholar: string[];
  pubmed: string[];
  arxiv: string[];
}

/**
 * Tool-input schema for the structured-output tool call. The model
 * MUST emit exactly one call to `emit_search_queries` with this shape.
 *
 * Each array constrained to 1..8 entries: design says 3-5, but we
 * accept down to 1 (model occasionally produces fewer for unsearchable
 * hypotheses) and up to 8 (avoid silent truncation if model goes wide).
 */
export const generatedQueriesSchema = z
  .object({
    ip_australia: z.array(z.string().min(1)).min(1).max(8),
    semantic_scholar: z.array(z.string().min(1)).min(1).max(8),
    pubmed: z.array(z.string().min(1)).min(1).max(8),
    arxiv: z.array(z.string().min(1)).min(1).max(8),
  })
  .strict();

/**
 * Options for `generateQueries`. All optional EXCEPT `client` in
 * production; tests can omit `tenantId` + `claimId` to skip the ledger
 * write.
 */
export interface GenerateQueriesOptions {
  /** Injected Anthropic SDK client. Tests pass a mock; production passes the lazy singleton. */
  client: Pick<Anthropic, 'messages'>;
  /** Tenant the call bills to. Required to write a ledger row. */
  tenantId?: string;
  /** Claim the call bills against. Required to gate the per-claim budget. */
  claimId?: string;
  /** Optional postgres-js TaggedSql for the ledger write. Skipped if absent. */
  sqlFn?: TaggedSql;
  /** Model override. Defaults to env var or `claude-sonnet-4-5`. */
  model?: string;
  /** AbortSignal so callers can interrupt the call. */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = process.env.IP_SEARCH_QUERY_MODEL ?? 'claude-sonnet-4-5';
const MAX_TOKENS = 2048;

/**
 * JSON-schema mirror of `generatedQueriesSchema`. Hand-rolled rather
 * than going through `zodToJsonSchema()` because the runtime helper
 * doesn't cleanly handle `min/max` constraints on `z.array`, and the
 * shape here is fixed enough to maintain inline.
 */
const TOOL_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    ip_australia: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 8,
      description: '3-5 Boolean queries (AND/OR/NOT) for IP Australia / patents.',
    },
    semantic_scholar: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 8,
      description: '3-5 natural-language queries for Semantic Scholar.',
    },
    pubmed: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 8,
      description: '3-5 natural-language / MeSH-style queries for PubMed.',
    },
    arxiv: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 8,
      description: '3-5 natural-language queries for arXiv.',
    },
  },
  required: ['ip_australia', 'semantic_scholar', 'pubmed', 'arxiv'],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class IpSearchQueryConfigError extends Error {
  override readonly name = 'IpSearchQueryConfigError';
}
export class IpSearchQueryUpstreamError extends Error {
  override readonly name = 'IpSearchQueryUpstreamError';
}
export class IpSearchQueryParseError extends Error {
  override readonly name = 'IpSearchQueryParseError';
  /** First 500 chars of the model's raw tool-use input, for triage. */
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
 * Generate per-database prior-art queries for an R&D hypothesis.
 *
 * Single Anthropic call; structured-output tool forcing pins the
 * model into emitting the four arrays in one shot. Writes a usage
 * row to `llm_token_usage` if `sqlFn + tenantId` are provided (skipped
 * for unit tests). Returns the validated `GeneratedQueries` object.
 *
 * @throws {IpSearchQueryUpstreamError} on Anthropic transport failure
 * @throws {IpSearchQueryParseError} when the tool input fails Zod validation
 * @throws {DOMException} 'AbortError' when the signal fires
 */
export async function generateQueries(
  hypothesis: string,
  opts: GenerateQueriesOptions,
): Promise<GeneratedQueries> {
  if (typeof hypothesis !== 'string' || hypothesis.trim().length === 0) {
    throw new IpSearchQueryConfigError('hypothesis must be a non-empty string');
  }
  if (!opts.client) {
    throw new IpSearchQueryConfigError('opts.client (Anthropic SDK client) is required');
  }

  const model = opts.model ?? DEFAULT_MODEL;

  // Call Anthropic with structured-output tool forcing.
  let response: Anthropic.Messages.Message;
  try {
    response = await opts.client.messages.create(
      {
        model,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserMessage(hypothesis) }],
        tools: [
          {
            name: EMIT_SEARCH_QUERIES_TOOL_NAME,
            description: EMIT_SEARCH_QUERIES_TOOL_DESCRIPTION,
            input_schema: TOOL_INPUT_SCHEMA,
          },
        ],
        tool_choice: { type: 'tool', name: EMIT_SEARCH_QUERIES_TOOL_NAME },
      },
      { signal: opts.signal },
    );
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new IpSearchQueryUpstreamError(`Anthropic call failed: ${(err as Error).message}`, {
      cause: err,
    });
  }

  // Find the tool_use content block. tool_choice forces this so absence
  // would be a protocol violation; we surface it as an Upstream error so
  // callers can distinguish "model misbehaved" from "we got bad JSON".
  const toolUseBlock = response.content.find(
    (c): c is Anthropic.Messages.ToolUseBlock =>
      c.type === 'tool_use' && c.name === EMIT_SEARCH_QUERIES_TOOL_NAME,
  );
  if (!toolUseBlock) {
    throw new IpSearchQueryUpstreamError(
      `model did not invoke the ${EMIT_SEARCH_QUERIES_TOOL_NAME} tool`,
    );
  }

  // Validate against our Zod schema. The JSON-schema sent to Anthropic
  // is a hint; Zod is the authoritative gate.
  const parseResult = generatedQueriesSchema.safeParse(toolUseBlock.input);
  if (!parseResult.success) {
    const issues = parseResult.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new IpSearchQueryParseError(
      `tool input failed validation: ${issues}`,
      JSON.stringify(toolUseBlock.input).slice(0, 500),
    );
  }
  const output = parseResult.data;

  // Ledger the usage. Skipped if the caller didn't pass sqlFn/tenantId
  // — keeps unit tests free of postgres while still letting production
  // bill correctly. Errors here are swallowed by recordUsage itself
  // (see token-ledger.ts comment) so a ledger failure won't mask the
  // successful return value.
  if (opts.sqlFn && opts.tenantId) {
    await recordUsage(opts.sqlFn, {
      tenant_id: opts.tenantId,
      claim_id: opts.claimId ?? null,
      subject_tenant_id: null,
      agent_name: 'ip-search-query',
      model,
      tokens_in: response.usage.input_tokens,
      tokens_out: response.usage.output_tokens,
    });
  }

  return output;
}
