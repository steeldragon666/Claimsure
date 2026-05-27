/**
 * Unit tests for ip-search-query.
 *
 * Strategy: inject a hand-crafted mock Anthropic client (same pattern as
 * suggestion-evaluator/evaluate.test.ts) and assert on:
 *   - structured-output happy path returns the parsed GeneratedQueries
 *   - malformed tool input → IpSearchQueryParseError
 *   - SDK transport failure → IpSearchQueryUpstreamError
 *   - AbortSignal fires → AbortError
 *   - missing tool_use block → IpSearchQueryUpstreamError
 *   - ledger row is written when sqlFn + tenantId provided
 *   - ledger is SKIPPED when sqlFn is omitted (tests can stay DB-free)
 *
 * The ledger assertion uses a fake TaggedSql that captures the
 * tagged-template invocations so we can verify the agent_name and
 * model fields without touching postgres.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import {
  generateQueries,
  IpSearchQueryConfigError,
  IpSearchQueryParseError,
  IpSearchQueryUpstreamError,
} from './index.js';
import type { TaggedSql } from '../runtime/token-ledger.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function validQueriesPayload(): Record<string, string[]> {
  return {
    ip_australia: [
      '(cryogenic OR "ultra-low temperature") AND yield',
      '"cryogenic separation" AND ("energy efficient" OR "low energy")',
      'cryogenic AND distillation AND efficiency',
    ],
    semantic_scholar: [
      'cryogenic distillation methods for improving yield in chemical extraction',
      'low temperature separation process efficiency optimisation',
      'energy-efficient cryogenic phase separation',
    ],
    pubmed: [
      'cryogenic processing yield optimisation',
      'low-temperature extraction efficiency',
      'cryogenic methods chemical engineering',
    ],
    arxiv: [
      'cryogenic phase separation thermodynamic efficiency',
      'liquid nitrogen extraction yield modelling',
      'low temperature distillation simulation',
    ],
  };
}

/**
 * Build a fake Anthropic client whose `messages.create` returns ONE
 * response containing a single `tool_use` block with the given input.
 *
 * Cast through `unknown` because the SDK's Anthropic.Messages.Message
 * type has many more fields than we need to set; the agent only reads
 * `content` + `usage`, which we do populate.
 */
function mockAnthropicReturningToolUse(
  toolInput: unknown,
  opts: { tokens_in?: number; tokens_out?: number; toolName?: string } = {},
): Pick<Anthropic, 'messages'> {
  return {
    messages: {
      create: () =>
        Promise.resolve({
          id: 'msg_fake',
          type: 'message' as const,
          role: 'assistant' as const,
          model: 'claude-sonnet-4-5',
          content: [
            {
              type: 'tool_use' as const,
              id: 'tu_1',
              name: opts.toolName ?? 'emit_search_queries',
              input: toolInput,
            },
          ] as Anthropic.Messages.ContentBlock[],
          stop_reason: 'tool_use',
          usage: {
            input_tokens: opts.tokens_in ?? 250,
            output_tokens: opts.tokens_out ?? 400,
          },
        }),
    },
  } as unknown as Pick<Anthropic, 'messages'>;
}

/** Mock that always throws — for upstream-error tests. */
function mockAnthropicThrowing(err: Error): Pick<Anthropic, 'messages'> {
  return {
    messages: {
      create: () => Promise.reject(err),
    },
  } as unknown as Pick<Anthropic, 'messages'>;
}

/** Mock that resolves slowly so we can test AbortSignal interruption. */
function mockAnthropicSlow(): Pick<Anthropic, 'messages'> {
  return {
    messages: {
      create: (_args: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const timer = setTimeout(() => _resolve({}), 5000);
          options?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('This operation was aborted', 'AbortError'));
          });
        }),
    },
  } as unknown as Pick<Anthropic, 'messages'>;
}

/**
 * Capturing fake TaggedSql. Returns an empty array for SELECT (so the
 * ledger's "current total" sum reads as zero) and records the INSERT.
 *
 * We approximate which call is which by sniffing the leading SQL
 * keyword in the first strings-array element; the real ledger code
 * uses tagged-template SQL so the strings array starts with either
 * \`SELECT COALESCE...\` or \`INSERT INTO llm_token_usage...\`.
 */
function captureSql(): { fn: TaggedSql; calls: Array<{ sql: string; values: unknown[] }> } {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const fn: TaggedSql = <T = unknown>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T> => {
    const sql = strings.join('?').trim();
    calls.push({ sql, values });
    if (sql.toUpperCase().startsWith('SELECT')) {
      // recordUsage expects `[{ total: '0' }]` shape for the pre-flight sum.
      return Promise.resolve([{ total: '0' }] as unknown as T);
    }
    return Promise.resolve(undefined as unknown as T);
  };
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('generateQueries: rejects empty hypothesis', async () => {
  const client = mockAnthropicReturningToolUse(validQueriesPayload());
  await assert.rejects(
    () => generateQueries('   ', { client }),
    (err: unknown) => err instanceof IpSearchQueryConfigError,
  );
});

test('generateQueries: happy path returns parsed queries', async () => {
  const payload = validQueriesPayload();
  const client = mockAnthropicReturningToolUse(payload);
  const result = await generateQueries('our cryogenic process improves yield by 30%', { client });
  assert.deepEqual(result.ip_australia, payload.ip_australia);
  assert.deepEqual(result.semantic_scholar, payload.semantic_scholar);
  assert.deepEqual(result.pubmed, payload.pubmed);
  assert.deepEqual(result.arxiv, payload.arxiv);
});

test('generateQueries: returns queries for each database (acceptance criterion)', async () => {
  const client = mockAnthropicReturningToolUse(validQueriesPayload());
  const result = await generateQueries('our cryogenic process improves yield by 30%', { client });
  for (const db of ['ip_australia', 'semantic_scholar', 'pubmed', 'arxiv'] as const) {
    assert.ok(
      result[db].length >= 1 && result[db].length <= 8,
      `${db} should have 1-8 queries; got ${result[db].length}`,
    );
    for (const q of result[db]) {
      assert.equal(typeof q, 'string');
      assert.ok(q.length > 0, `${db} query was empty string`);
    }
  }
});

test('generateQueries: malformed tool input throws IpSearchQueryParseError', async () => {
  // Missing `arxiv` field — Zod should reject.
  const client = mockAnthropicReturningToolUse({
    ip_australia: ['a'],
    semantic_scholar: ['b'],
    pubmed: ['c'],
    // arxiv omitted
  });
  await assert.rejects(
    () => generateQueries('hyp', { client }),
    (err: unknown) =>
      err instanceof IpSearchQueryParseError && err.rawSnippet.includes('semantic_scholar'),
  );
});

test('generateQueries: SDK transport failure throws IpSearchQueryUpstreamError', async () => {
  const client = mockAnthropicThrowing(new Error('Internal Server Error'));
  await assert.rejects(
    () => generateQueries('hyp', { client }),
    (err: unknown) => err instanceof IpSearchQueryUpstreamError,
  );
});

test('generateQueries: AbortSignal interrupts the call', async () => {
  const ac = new AbortController();
  const client = mockAnthropicSlow();
  setTimeout(() => ac.abort(), 10);
  await assert.rejects(
    () => generateQueries('hyp', { client, signal: ac.signal }),
    (err: unknown) => (err as Error).name === 'AbortError',
  );
});

test('generateQueries: model omits tool_use block -> IpSearchQueryUpstreamError', async () => {
  // Mock returns a text block instead of tool_use.
  const client: Pick<Anthropic, 'messages'> = {
    messages: {
      create: () =>
        Promise.resolve({
          id: 'msg_fake',
          type: 'message' as const,
          role: 'assistant' as const,
          model: 'claude-sonnet-4-5',
          content: [
            { type: 'text' as const, text: 'oops, I forgot to call the tool' },
          ] as Anthropic.Messages.ContentBlock[],
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
    },
  } as unknown as Pick<Anthropic, 'messages'>;
  await assert.rejects(
    () => generateQueries('hyp', { client }),
    (err: unknown) => err instanceof IpSearchQueryUpstreamError,
  );
});

test('generateQueries: writes a ledger row with agent_name="ip-search-query"', async () => {
  const client = mockAnthropicReturningToolUse(validQueriesPayload(), {
    tokens_in: 300,
    tokens_out: 500,
  });
  const { fn, calls } = captureSql();

  await generateQueries('our cryogenic process improves yield by 30%', {
    client,
    sqlFn: fn,
    tenantId: '00000000-0000-0000-0000-000000000001',
    claimId: '00000000-0000-0000-0000-000000000002',
  });

  // Expect 2 SQL calls: SELECT (pre-flight sum) + INSERT.
  assert.equal(calls.length, 2, `expected 2 SQL calls, got ${calls.length}`);
  assert.match(calls[0].sql, /^SELECT/);
  assert.match(calls[1].sql, /^INSERT INTO llm_token_usage/);
  // Values are positional; agent_name is one of them.
  assert.ok(
    calls[1].values.includes('ip-search-query'),
    `INSERT values should include agent_name="ip-search-query"; got: ${JSON.stringify(calls[1].values)}`,
  );
  // tokens_in / tokens_out captured from the mock response usage.
  assert.ok(calls[1].values.includes(300), 'tokens_in (300) should be in INSERT values');
  assert.ok(calls[1].values.includes(500), 'tokens_out (500) should be in INSERT values');
});

test('generateQueries: skips ledger write when sqlFn is omitted', async () => {
  const client = mockAnthropicReturningToolUse(validQueriesPayload());
  // No sqlFn / tenantId — should NOT throw and should NOT call any sql.
  const result = await generateQueries('hyp', { client });
  assert.ok(result.ip_australia.length >= 1);
});
