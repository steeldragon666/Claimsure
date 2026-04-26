import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeClassifier } from './factory.js';
import { StubClassifier } from './stub.js';
import { HaikuClassifier } from './haiku.js';

beforeEach(() => {
  delete process.env.CLASSIFIER_IMPL;
  delete process.env.CI;
  delete process.env.ANTHROPIC_API_KEY;
});

test('CLASSIFIER_IMPL=stub → StubClassifier', () => {
  process.env.CLASSIFIER_IMPL = 'stub';
  assert.ok(makeClassifier() instanceof StubClassifier);
});

test('CLASSIFIER_IMPL=haiku + ANTHROPIC_API_KEY set → HaikuClassifier', () => {
  process.env.CLASSIFIER_IMPL = 'haiku';
  process.env.ANTHROPIC_API_KEY = 'k';
  assert.ok(makeClassifier() instanceof HaikuClassifier);
});

test('CI=true and unset CLASSIFIER_IMPL → StubClassifier', () => {
  process.env.CI = 'true';
  assert.ok(makeClassifier() instanceof StubClassifier);
});

test('unknown CLASSIFIER_IMPL throws', () => {
  process.env.CLASSIFIER_IMPL = 'nonsense';
  assert.throws(() => makeClassifier(), /unknown CLASSIFIER_IMPL/);
});
