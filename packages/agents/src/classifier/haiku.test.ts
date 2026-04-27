import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import nock from 'nock';
import { HaikuClassifier } from './haiku.js';
import { _resetAnthropicClientForTests } from '../runtime/anthropic-client.js';

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  _resetAnthropicClientForTests();
  nock.cleanAll();
});

after(() => {
  nock.cleanAll();
});

test('HaikuClassifier round-trips through Anthropic SDK', async () => {
  nock('https://api.anthropic.com')
    .post('/v1/messages')
    .reply(200, {
      id: 'msg',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5',
      content: [
        {
          type: 'tool_use',
          id: 't',
          name: 'classify_evidence',
          input: {
            kind: 'HYPOTHESIS',
            confidence: 0.9,
            rationale: 'r',
            statutory_anchor: '§355-25(1)(a)',
          },
        },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 200, output_tokens: 50 },
    });

  const c = new HaikuClassifier();
  const out = await c.classify({ raw_text: 'we hypothesised the catalyst would last 200 hours' });
  assert.equal(out.kind, 'HYPOTHESIS');
  assert.equal(out.confidence, 0.9);
  assert.equal(out.statutory_anchor, '§355-25(1)(a)');
  assert.equal(out.model, 'claude-haiku-4-5');
  assert.equal(out.prompt_version, 'classify@1.0.0');
  assert.equal(out.tokens_in, 200);
  assert.equal(out.tokens_out, 50);
});
