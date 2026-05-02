import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeRegisterSynthesizer } from './factory.js';
import { StubRegisterSynthesizer } from './stub.js';
import { SonnetRegisterSynthesizer } from './sonnet.js';

beforeEach(() => {
  delete process.env.ACTIVITY_REGISTER_SYNTHESIZER_IMPL;
  delete process.env.CI;
  delete process.env.ANTHROPIC_API_KEY;
});

test('ACTIVITY_REGISTER_SYNTHESIZER_IMPL=stub → StubRegisterSynthesizer', () => {
  process.env.ACTIVITY_REGISTER_SYNTHESIZER_IMPL = 'stub';
  assert.ok(makeRegisterSynthesizer() instanceof StubRegisterSynthesizer);
});

test('ACTIVITY_REGISTER_SYNTHESIZER_IMPL=sonnet + ANTHROPIC_API_KEY set → SonnetRegisterSynthesizer', () => {
  process.env.ACTIVITY_REGISTER_SYNTHESIZER_IMPL = 'sonnet';
  process.env.ANTHROPIC_API_KEY = 'k';
  assert.ok(makeRegisterSynthesizer() instanceof SonnetRegisterSynthesizer);
});

test('CI=true and unset IMPL → StubRegisterSynthesizer', () => {
  process.env.CI = 'true';
  assert.ok(makeRegisterSynthesizer() instanceof StubRegisterSynthesizer);
});

test('unknown ACTIVITY_REGISTER_SYNTHESIZER_IMPL throws', () => {
  process.env.ACTIVITY_REGISTER_SYNTHESIZER_IMPL = 'nonsense';
  assert.throws(() => makeRegisterSynthesizer(), /unknown ACTIVITY_REGISTER_SYNTHESIZER_IMPL/);
});

test('default (no env) → SonnetRegisterSynthesizer', () => {
  assert.ok(makeRegisterSynthesizer() instanceof SonnetRegisterSynthesizer);
});
