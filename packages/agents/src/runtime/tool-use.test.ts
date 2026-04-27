import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import nock from 'nock';
import { z } from 'zod';
import { _resetAnthropicClientForTests, getAnthropicClient } from './anthropic-client.js';
import { callWithToolUse } from './tool-use.js';

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  _resetAnthropicClientForTests();
  nock.cleanAll();
});

after(() => {
  nock.cleanAll();
});

test('callWithToolUse extracts tool_use block and returns parsed output', async () => {
  const schema = z.object({ kind: z.string(), confidence: z.number() });

  nock('https://api.anthropic.com')
    .post('/v1/messages')
    .reply(200, {
      id: 'msg_x',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5',
      content: [
        {
          type: 'tool_use',
          id: 'tu_1',
          name: 'classify',
          input: { kind: 'HYPOTHESIS', confidence: 0.85 },
        },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 50 },
    });

  const r = await callWithToolUse(getAnthropicClient(), {
    model: 'claude-haiku-4-5',
    system: 'sys',
    user: 'classify this',
    tool: { name: 'classify', description: 'd', input_schema: schema },
  });
  assert.equal(r.output.kind, 'HYPOTHESIS');
  assert.equal(r.output.confidence, 0.85);
  assert.equal(r.tokens_in, 100);
  assert.equal(r.tokens_out, 50);
});

test('callWithToolUse throws when no tool_use block returned', async () => {
  const schema = z.object({ kind: z.string() });
  nock('https://api.anthropic.com')
    .post('/v1/messages')
    .reply(200, {
      id: 'm',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5',
      content: [{ type: 'text', text: 'I refused to use the tool' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    });
  await assert.rejects(
    callWithToolUse(getAnthropicClient(), {
      model: 'claude-haiku-4-5',
      system: 's',
      user: 'u',
      tool: { name: 'classify', description: 'd', input_schema: schema },
    }),
    /did not invoke the structured-output tool/,
  );
});
