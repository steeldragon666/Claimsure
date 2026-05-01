import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_PRICING, computeCost } from './pricing.js';

test('MODEL_PRICING contains claude-haiku-4-5 with correct rates', () => {
  assert.equal(MODEL_PRICING['claude-haiku-4-5'].input_per_mtok, 0.25);
  assert.equal(MODEL_PRICING['claude-haiku-4-5'].output_per_mtok, 1.25);
});

test('MODEL_PRICING contains claude-sonnet-4-5 with correct rates', () => {
  assert.equal(MODEL_PRICING['claude-sonnet-4-5'].input_per_mtok, 3.0);
  assert.equal(MODEL_PRICING['claude-sonnet-4-5'].output_per_mtok, 15.0);
});

test('computeCost: haiku at 1M in + 1M out = $1.50', () => {
  // 1M tokens * $0.25/Mtok input + 1M tokens * $1.25/Mtok output = $0.25 + $1.25 = $1.50
  assert.equal(computeCost('claude-haiku-4-5', 1_000_000, 1_000_000), 1.5);
});

test('computeCost: sonnet at 1M in + 1M out = $18.00', () => {
  // 1M tokens * $3/Mtok input + 1M tokens * $15/Mtok output = $3 + $15 = $18
  assert.equal(computeCost('claude-sonnet-4-5', 1_000_000, 1_000_000), 18);
});

test('computeCost: unknown model returns 0 (no throw)', () => {
  assert.equal(computeCost('unknown-model', 1000, 1000), 0);
});

test('computeCost: empty-string model returns 0', () => {
  assert.equal(computeCost('', 100, 100), 0);
});

test('computeCost: zero usage on known model returns 0', () => {
  assert.equal(computeCost('claude-haiku-4-5', 0, 0), 0);
  assert.equal(computeCost('claude-sonnet-4-5', 0, 0), 0);
});

test('computeCost: fractional dollar amount for small token counts (haiku)', () => {
  // 100 input tokens at $0.25/Mtok = 100 * 0.25 / 1_000_000 = 0.000025
  // 50 output tokens at $1.25/Mtok = 50 * 1.25 / 1_000_000 = 0.0000625
  // total = 0.0000875
  const got = computeCost('claude-haiku-4-5', 100, 50);
  assert.equal(got, 0.0000875);
});

test('computeCost: input-only usage (sonnet)', () => {
  // 2M input tokens at $3/Mtok = $6
  assert.equal(computeCost('claude-sonnet-4-5', 2_000_000, 0), 6);
});

test('computeCost: output-only usage (haiku)', () => {
  // 4M output tokens at $1.25/Mtok = $5
  assert.equal(computeCost('claude-haiku-4-5', 0, 4_000_000), 5);
});
