import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import type { EvaluateSuggestionInput } from './evaluate.js';
import {
  evaluate,
  EvaluatorConfigError,
  EvaluatorUpstreamError,
  EvaluatorParseError,
  EvaluatorLoopExhaustedError,
} from './evaluate.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeSuggestion(): EvaluateSuggestionInput {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    tenant_id: '00000000-0000-0000-0000-000000000002',
    flagged_by_user_id: '00000000-0000-0000-0000-000000000003',
    source_kind: 'consultant_flag',
    affected_prompt_module: 'classify-expenditure@1.0.0',
    affected_section_kind: 'hypothesis',
    issue_summary: 'Model keeps confusing core vs supporting activities.',
  };
}

function validEvaluationJson(overrides?: Record<string, unknown>): string {
  return JSON.stringify({
    suggestion_id: '00000000-0000-0000-0000-000000000001',
    classification: 'prompt_change',
    files: [
      {
        path: 'packages/agents/src/classifier-expenditure/prompts/x.ts',
        change_kind: 'modify',
        rationale:
          'Tighten the decision tree to distinguish core vs supporting activities clearly.',
        diff_preview: '@@ -10,3 +10,3 @@ ...',
        newContent: 'export const X = "y";\n',
      },
    ],
    cross_file_consistency_checks_run: ['verified contract test passes'],
    rationale_summary:
      'Consultant flagged misclassification of core vs supporting activities. The prompt decision tree lacked an explicit disambiguation step.',
    prompt_version: '1.0.0',
    model: 'claude-opus-4-7',
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Mock Anthropic client helpers
// ---------------------------------------------------------------------------

/** Build a fake Anthropic client that returns a single fixed response. */
function mockAnthropicReturning(response: {
  content: Anthropic.Messages.ContentBlock[];
  stop_reason: string;
}): Anthropic {
  return {
    messages: {
      create: () =>
        Promise.resolve({
          ...response,
          id: 'msg_fake',
          type: 'message' as const,
          role: 'assistant' as const,
          model: 'claude-opus-4-7',
          usage: { input_tokens: 100, output_tokens: 200 },
        }),
    },
  } as unknown as Anthropic;
}

/** Build a fake Anthropic client that returns responses in sequence. */
function mockAnthropicSequence(
  responses: Array<{
    content: Anthropic.Messages.ContentBlock[];
    stop_reason: string;
  }>,
): Anthropic {
  let callIdx = 0;
  return {
    messages: {
      create: () => {
        const r = responses[callIdx++];
        if (!r) return Promise.reject(new Error('mockAnthropicSequence: no more responses'));
        return Promise.resolve({
          ...r,
          id: `msg_fake_${callIdx}`,
          type: 'message' as const,
          role: 'assistant' as const,
          model: 'claude-opus-4-7',
          usage: { input_tokens: 100, output_tokens: 200 },
        });
      },
    },
  } as unknown as Anthropic;
}

/** Build a fake Anthropic client that always returns stop_reason='tool_use'. */
function mockAnthropicAlwaysToolUse(): Anthropic {
  return {
    messages: {
      create: () =>
        Promise.resolve({
          id: 'msg_loop',
          type: 'message' as const,
          role: 'assistant' as const,
          model: 'claude-opus-4-7',
          content: [
            {
              type: 'tool_use' as const,
              id: `tu_${Date.now()}`,
              name: 'list_directory',
              input: { path: '.' },
            },
          ] as Anthropic.Messages.ContentBlock[],
          stop_reason: 'tool_use',
          usage: { input_tokens: 50, output_tokens: 50 },
        }),
    },
  } as unknown as Anthropic;
}

/** Build a fake Anthropic client that throws on every call. */
function mockAnthropicThrowing(err: Error): Anthropic {
  return {
    messages: {
      create: () => Promise.reject(err),
    },
  } as unknown as Anthropic;
}

/** Build a fake Anthropic client that resolves slowly (for abort tests). */
function mockAnthropicSlow(): Anthropic {
  return {
    messages: {
      create: async (_args: unknown, opts?: { signal?: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          const timer = setTimeout(() => {
            _resolve({
              id: 'msg_slow',
              type: 'message' as const,
              role: 'assistant' as const,
              model: 'claude-opus-4-7',
              content: [{ type: 'text' as const, text: validEvaluationJson() }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 100, output_tokens: 200 },
            });
          }, 5000);
          if (opts?.signal) {
            opts.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              const abortErr = new DOMException('This operation was aborted', 'AbortError');
              reject(abortErr);
            });
          }
        });
      },
    },
  } as unknown as Anthropic;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('evaluate.ts: exports the expected public API', () => {
  assert.equal(typeof evaluate, 'function');
  assert.equal(typeof EvaluatorConfigError, 'function');
  assert.equal(typeof EvaluatorUpstreamError, 'function');
  assert.equal(typeof EvaluatorParseError, 'function');
  assert.equal(typeof EvaluatorLoopExhaustedError, 'function');
});

test('evaluate: happy path — model returns final JSON in one turn', async () => {
  const fakeAnthropic = mockAnthropicReturning({
    content: [{ type: 'text' as const, text: validEvaluationJson() }],
    stop_reason: 'end_turn',
  });
  const result = await evaluate({
    suggestion: makeSuggestion(),
    repoRoot: '/tmp/fake',
    anthropic: fakeAnthropic,
  });
  assert.equal(result.suggestion_id, '00000000-0000-0000-0000-000000000001');
  assert.equal(result.classification, 'prompt_change');
  assert.equal(result.files.length, 1);
});

test('evaluate: tool-use turn then final answer (multi-turn)', async () => {
  const fakeAnthropic = mockAnthropicSequence([
    {
      content: [
        {
          type: 'tool_use' as const,
          id: 't1',
          name: 'list_directory',
          input: { path: '.' },
        },
      ],
      stop_reason: 'tool_use',
    },
    {
      content: [{ type: 'text' as const, text: validEvaluationJson() }],
      stop_reason: 'end_turn',
    },
  ]);
  // Use process.cwd() as repoRoot so list_directory can actually resolve
  const result = await evaluate({
    suggestion: makeSuggestion(),
    repoRoot: process.cwd(),
    anthropic: fakeAnthropic,
  });
  assert.ok(result.files);
  assert.equal(result.suggestion_id, '00000000-0000-0000-0000-000000000001');
});

test('evaluate: loop hits maxTurns cap', async () => {
  const fakeAnthropic = mockAnthropicAlwaysToolUse();
  await assert.rejects(
    () =>
      evaluate({
        suggestion: makeSuggestion(),
        repoRoot: process.cwd(),
        anthropic: fakeAnthropic,
        maxTurns: 2,
      }),
    (err: unknown) => err instanceof EvaluatorLoopExhaustedError && err.turnsUsed === 2,
  );
});

test('evaluate: final response not valid JSON throws EvaluatorParseError', async () => {
  const fakeAnthropic = mockAnthropicReturning({
    content: [{ type: 'text' as const, text: 'this is not JSON at all' }],
    stop_reason: 'end_turn',
  });
  await assert.rejects(
    () =>
      evaluate({
        suggestion: makeSuggestion(),
        repoRoot: process.cwd(),
        anthropic: fakeAnthropic,
      }),
    (err: unknown) => err instanceof EvaluatorParseError && err.rawSnippet.includes('not JSON'),
  );
});

test('evaluate: AbortSignal fires throws AbortError', async () => {
  const ac = new AbortController();
  const fakeAnthropic = mockAnthropicSlow();
  setTimeout(() => ac.abort(), 10);
  await assert.rejects(
    () =>
      evaluate({
        suggestion: makeSuggestion(),
        repoRoot: process.cwd(),
        anthropic: fakeAnthropic,
        signal: ac.signal,
      }),
    (err: unknown) => (err as Error).name === 'AbortError',
  );
});

test('evaluate: Anthropic SDK throws 5xx -> EvaluatorUpstreamError', async () => {
  const fakeAnthropic = mockAnthropicThrowing(new Error('Internal Server Error'));
  await assert.rejects(
    () =>
      evaluate({
        suggestion: makeSuggestion(),
        repoRoot: process.cwd(),
        anthropic: fakeAnthropic,
      }),
    (err: unknown) => err instanceof EvaluatorUpstreamError,
  );
});

test('evaluate: missing API key (no anthropic + no env) -> EvaluatorConfigError', async () => {
  const saved = process.env['ANTHROPIC_API_KEY'];
  delete process.env['ANTHROPIC_API_KEY'];
  try {
    await assert.rejects(
      () =>
        evaluate({
          suggestion: makeSuggestion(),
          repoRoot: process.cwd(),
        }),
      (err: unknown) => err instanceof EvaluatorConfigError,
    );
  } finally {
    if (saved !== undefined) process.env['ANTHROPIC_API_KEY'] = saved;
  }
});
