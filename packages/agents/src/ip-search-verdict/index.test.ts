/**
 * Unit tests for ip-search-verdict.
 *
 * Table-driven coverage of the three verdict shapes plus error paths.
 * Mocks Anthropic via the same DI seam as ip-search-query/index.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import {
  draftVerdict,
  IpSearchVerdictConfigError,
  IpSearchVerdictParseError,
  IpSearchVerdictUpstreamError,
  type IpSearchHit,
  type IpSearchVerdict,
} from './index.js';
import type { TaggedSql } from '../runtime/token-ledger.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function mockAnthropicReturningVerdict(
  verdict: IpSearchVerdict,
  analysisMarkdown: string,
  opts: { tokens_in?: number; tokens_out?: number } = {},
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
              name: 'emit_verdict',
              input: { verdict, analysis_markdown: analysisMarkdown },
            },
          ] as Anthropic.Messages.ContentBlock[],
          stop_reason: 'tool_use',
          usage: {
            input_tokens: opts.tokens_in ?? 800,
            output_tokens: opts.tokens_out ?? 600,
          },
        }),
    },
  } as unknown as Pick<Anthropic, 'messages'>;
}

function mockAnthropicReturningRawToolInput(input: unknown): Pick<Anthropic, 'messages'> {
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
              name: 'emit_verdict',
              input,
            },
          ] as Anthropic.Messages.ContentBlock[],
          stop_reason: 'tool_use',
          usage: { input_tokens: 100, output_tokens: 100 },
        }),
    },
  } as unknown as Pick<Anthropic, 'messages'>;
}

function mockAnthropicThrowing(err: Error): Pick<Anthropic, 'messages'> {
  return {
    messages: { create: () => Promise.reject(err) },
  } as unknown as Pick<Anthropic, 'messages'>;
}

function captureSql(): {
  fn: TaggedSql;
  calls: Array<{ sql: string; values: unknown[] }>;
} {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const fn: TaggedSql = <T = unknown>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T> => {
    const sql = strings.join('?').trim();
    calls.push({ sql, values });
    if (sql.toUpperCase().startsWith('SELECT')) {
      return Promise.resolve([{ total: '0' }] as unknown as T);
    }
    return Promise.resolve(undefined as unknown as T);
  };
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HYPOTHESIS = 'our cryogenic process improves yield by 30% through novel phase-separation';

const HIGHLY_RELEVANT_HIT: IpSearchHit = {
  database: 'ip_australia',
  externalId: 'AU2019123456',
  title: 'Cryogenic phase-separation process for high-yield chemical extraction',
  abstract:
    'A cryogenic phase-separation method using liquid nitrogen pre-cooling stages to achieve 32% yield improvement over conventional distillation. Claims cover the temperature staging, separator geometry, and feedback control loop.',
  url: 'https://patents.example/AU2019123456',
  relevanceScore: 0.94,
};

const BORDERLINE_HIT: IpSearchHit = {
  database: 'semantic_scholar',
  externalId: 'SS-87654321',
  title: 'Energy efficiency in low-temperature industrial processes: a review',
  abstract:
    'A review of energy efficiency in low-temperature industrial processes including refrigeration cycles, but not specifically addressing yield optimisation through phase separation.',
  url: 'https://semanticscholar.org/paper/87654321',
  relevanceScore: 0.42,
};

const PASS_ANALYSIS = `Across the four databases queried, no hits directly anticipate the cryogenic phase-separation yield improvement described in the hypothesis. The adjacent prior art focuses on conventional distillation efficiency rather than the novel phase-separation mechanism here.

Therefore, this hypothesis is **PASS** for R&DTI core-activity eligibility.`;

const FAIL_ANALYSIS = `Patent [AU2019123456] "Cryogenic phase-separation process for high-yield chemical extraction" directly anticipates the hypothesis. The patent describes the same cryogenic phase-separation mechanism with a comparable 32% yield improvement, and its claims cover the temperature staging and separator geometry the hypothesis appears to rely on.

Therefore, this hypothesis is **FAIL** for R&DTI core-activity eligibility.`;

const INCONCLUSIVE_ANALYSIS = `The hits returned are tangentially relevant: [SS-87654321] reviews energy efficiency in low-temperature processes but does not address phase separation for yield improvement specifically. Without access to the full claim text of related patents and a clearer specification of the hypothesis's novel mechanism, the question cannot be resolved from this evidence alone.

Therefore, this hypothesis is **INCONCLUSIVE** for R&DTI core-activity eligibility.`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('draftVerdict: rejects empty hypothesis', async () => {
  const client = mockAnthropicReturningVerdict('pass', PASS_ANALYSIS);
  await assert.rejects(
    () => draftVerdict({ hypothesis: '', hits: [], client }),
    (err: unknown) => err instanceof IpSearchVerdictConfigError,
  );
});

test('draftVerdict: rejects non-array hits', async () => {
  const client = mockAnthropicReturningVerdict('pass', PASS_ANALYSIS);
  await assert.rejects(
    () =>
      draftVerdict({
        hypothesis: HYPOTHESIS,
        hits: null as unknown as IpSearchHit[],
        client,
      }),
    (err: unknown) => err instanceof IpSearchVerdictConfigError,
  );
});

test('draftVerdict: empty hits → pass verdict with "no prior art found" reasoning', async () => {
  // Mock the LLM doing what the prompt asks for an empty-hits input.
  const client = mockAnthropicReturningVerdict('pass', PASS_ANALYSIS);
  const result = await draftVerdict({ hypothesis: HYPOTHESIS, hits: [], client });
  assert.equal(result.verdict, 'pass');
  assert.match(result.analysisMarkdown, /no hits|no prior art|adjacent prior art/i);
  assert.match(result.analysisMarkdown, /\*\*PASS\*\*/);
});

test('draftVerdict: highly-relevant hit → fail verdict citing the hit', async () => {
  const client = mockAnthropicReturningVerdict('fail', FAIL_ANALYSIS);
  const result = await draftVerdict({
    hypothesis: HYPOTHESIS,
    hits: [HIGHLY_RELEVANT_HIT],
    client,
  });
  assert.equal(result.verdict, 'fail');
  // Must cite the highly-relevant hit by externalId.
  assert.match(
    result.analysisMarkdown,
    /\[AU2019123456\]/,
    'analysis should cite the highly-relevant hit by [externalId]',
  );
  assert.match(result.analysisMarkdown, /\*\*FAIL\*\*/);
});

test('draftVerdict: borderline hit → inconclusive verdict allowed', async () => {
  const client = mockAnthropicReturningVerdict('inconclusive', INCONCLUSIVE_ANALYSIS);
  const result = await draftVerdict({
    hypothesis: HYPOTHESIS,
    hits: [BORDERLINE_HIT],
    client,
  });
  assert.equal(result.verdict, 'inconclusive');
  assert.match(result.analysisMarkdown, /\*\*INCONCLUSIVE\*\*/);
});

test('draftVerdict: malformed tool input → IpSearchVerdictParseError', async () => {
  // Missing analysis_markdown.
  const client = mockAnthropicReturningRawToolInput({ verdict: 'pass' });
  await assert.rejects(
    () => draftVerdict({ hypothesis: HYPOTHESIS, hits: [], client }),
    (err: unknown) =>
      err instanceof IpSearchVerdictParseError && err.rawSnippet.includes('verdict'),
  );
});

test('draftVerdict: invalid verdict value → IpSearchVerdictParseError', async () => {
  // 'maybe' is not in the enum.
  const client = mockAnthropicReturningRawToolInput({
    verdict: 'maybe',
    analysis_markdown:
      'A sufficiently long analysis string to satisfy the min-length validator for the schema.',
  });
  await assert.rejects(
    () => draftVerdict({ hypothesis: HYPOTHESIS, hits: [], client }),
    (err: unknown) => err instanceof IpSearchVerdictParseError,
  );
});

test('draftVerdict: SDK transport failure → IpSearchVerdictUpstreamError', async () => {
  const client = mockAnthropicThrowing(new Error('500 Internal Server Error'));
  await assert.rejects(
    () => draftVerdict({ hypothesis: HYPOTHESIS, hits: [], client }),
    (err: unknown) => err instanceof IpSearchVerdictUpstreamError,
  );
});

test('draftVerdict: model omits tool_use → IpSearchVerdictUpstreamError', async () => {
  const client: Pick<Anthropic, 'messages'> = {
    messages: {
      create: () =>
        Promise.resolve({
          id: 'msg_fake',
          type: 'message' as const,
          role: 'assistant' as const,
          model: 'claude-sonnet-4-5',
          content: [{ type: 'text' as const, text: 'oops' }] as Anthropic.Messages.ContentBlock[],
          stop_reason: 'end_turn',
          usage: { input_tokens: 50, output_tokens: 10 },
        }),
    },
  } as unknown as Pick<Anthropic, 'messages'>;
  await assert.rejects(
    () => draftVerdict({ hypothesis: HYPOTHESIS, hits: [], client }),
    (err: unknown) => err instanceof IpSearchVerdictUpstreamError,
  );
});

test('draftVerdict: writes a ledger row with agent_name="ip-search-verdict"', async () => {
  const client = mockAnthropicReturningVerdict('fail', FAIL_ANALYSIS, {
    tokens_in: 1500,
    tokens_out: 700,
  });
  const { fn, calls } = captureSql();

  await draftVerdict({
    hypothesis: HYPOTHESIS,
    hits: [HIGHLY_RELEVANT_HIT],
    client,
    sqlFn: fn,
    tenantId: '00000000-0000-0000-0000-000000000010',
    claimId: '00000000-0000-0000-0000-000000000020',
  });

  assert.equal(calls.length, 2, `expected 2 SQL calls, got ${calls.length}`);
  assert.match(calls[0].sql, /^SELECT/);
  assert.match(calls[1].sql, /^INSERT INTO llm_token_usage/);
  assert.ok(
    calls[1].values.includes('ip-search-verdict'),
    `INSERT should include agent_name="ip-search-verdict"; values=${JSON.stringify(calls[1].values)}`,
  );
  assert.ok(calls[1].values.includes(1500), 'tokens_in (1500) should be in INSERT values');
  assert.ok(calls[1].values.includes(700), 'tokens_out (700) should be in INSERT values');
});

test('draftVerdict: skips ledger write when sqlFn omitted', async () => {
  const client = mockAnthropicReturningVerdict('pass', PASS_ANALYSIS);
  const result = await draftVerdict({ hypothesis: HYPOTHESIS, hits: [], client });
  assert.equal(result.verdict, 'pass');
});

test('draftVerdict: passes hits grouped by database in the prompt (smoke)', async () => {
  // Smoke test: assemble multiple hits across databases and ensure
  // the call succeeds and returns the expected structure. The real
  // prompt-grouping behaviour is internal — we don't intercept the
  // user message here, but we do verify the agent doesn't crash with
  // a multi-database input.
  const client = mockAnthropicReturningVerdict('inconclusive', INCONCLUSIVE_ANALYSIS);
  const hits: IpSearchHit[] = [
    HIGHLY_RELEVANT_HIT,
    BORDERLINE_HIT,
    {
      database: 'arxiv',
      externalId: 'arXiv:2401.12345',
      title: 'Thermodynamic modelling of cryogenic phase separation',
      abstract: 'A theoretical analysis...',
      url: 'https://arxiv.org/abs/2401.12345',
    },
  ];
  const result = await draftVerdict({ hypothesis: HYPOTHESIS, hits, client });
  assert.equal(result.verdict, 'inconclusive');
  assert.equal(typeof result.analysisMarkdown, 'string');
  assert.ok(result.analysisMarkdown.length >= 50);
});
