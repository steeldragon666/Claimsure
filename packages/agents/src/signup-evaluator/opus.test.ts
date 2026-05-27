import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import nock from 'nock';
import { OpusSignupEvaluator } from './opus.js';
import { _resetAnthropicClientForTests } from '../runtime/anthropic-client.js';

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  _resetAnthropicClientForTests();
  nock.cleanAll();
});

after(() => {
  nock.cleanAll();
});

test('OpusSignupEvaluator round-trips through Anthropic SDK', async () => {
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
          name: 'evaluate_signup',
          input: {
            decision: 'approve',
            confidence: 0.82,
            rationale: 'firm name + work email look legitimate; no red flags',
            red_flags: [],
          },
        },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 250, output_tokens: 60 },
    });

  const e = new OpusSignupEvaluator();
  const out = await e.evaluate({
    email: 'jordan@acme.com.au',
    firm_name: 'Acme R&D Advisory',
    display_name: 'Jordan Blake',
    abr_match: [
      {
        matched_name: 'Acme Pty Ltd',
        abn: '12 345 678 901',
        entity_type: 'Australian Private Company',
        abn_status: 'Active',
        registration_state: 'NSW',
      },
    ],
  });

  assert.equal(out.decision, 'approve');
  assert.equal(out.confidence, 0.82);
  assert.equal(out.rationale, 'firm name + work email look legitimate; no red flags');
  assert.deepEqual(out.red_flags, []);
  assert.equal(out.model, 'claude-haiku-4-5');
  assert.equal(out.prompt_version, 'evaluate-signup@1.0.0');
  assert.equal(out.tokens_in, 250);
  assert.equal(out.tokens_out, 60);
});

test('OpusSignupEvaluator: deny verdict with red flags', async () => {
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
          name: 'evaluate_signup',
          input: {
            decision: 'deny',
            confidence: 0.91,
            rationale: 'random firm name; generic localpart; no ABR match',
            red_flags: ['firm name appears generated', 'generic email local-part'],
          },
        },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 240, output_tokens: 75 },
    });

  const e = new OpusSignupEvaluator();
  const out = await e.evaluate({
    email: 'test@example.com',
    firm_name: 'xkcdq',
    display_name: null,
    abr_match: [],
  });

  assert.equal(out.decision, 'deny');
  assert.equal(out.confidence, 0.91);
  assert.equal(out.red_flags.length, 2);
});

test('OpusSignupEvaluator: review verdict on uncertainty', async () => {
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
          name: 'evaluate_signup',
          input: {
            decision: 'review',
            confidence: 0.55,
            rationale: 'gmail with a generic firm name; uncertain',
            red_flags: ['personal-email domain'],
          },
        },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 220, output_tokens: 50 },
    });

  const e = new OpusSignupEvaluator();
  const out = await e.evaluate({
    email: 'jane@gmail.com',
    firm_name: 'My Firm',
    display_name: 'Jane',
    abr_match: [],
  });

  assert.equal(out.decision, 'review');
  assert.equal(out.confidence, 0.55);
});
