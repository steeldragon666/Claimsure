import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StubSignupEvaluator } from './stub.js';
import type { SignupEvaluatorInput } from './types.js';

const evaluator = new StubSignupEvaluator();

function input(over: Partial<SignupEvaluatorInput>): SignupEvaluatorInput {
  return {
    email: 'jordan@acme.com.au',
    firm_name: 'Acme R&D Advisory',
    display_name: 'Jordan Blake',
    abr_match: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Default-approve path
// ---------------------------------------------------------------------------

test('StubSignupEvaluator: legitimate-looking signup → approve', async () => {
  const out = await evaluator.evaluate(input({}));
  assert.equal(out.decision, 'approve');
  assert.ok(out.confidence >= 0.5);
  assert.equal(out.prompt_version, 'evaluate-signup@1.0.0');
});

test('StubSignupEvaluator: sole practitioner on gmail → approve', async () => {
  const out = await evaluator.evaluate(
    input({ email: 'sarah@gmail.com', firm_name: 'Sarah Patel R&D Advisory' }),
  );
  assert.equal(out.decision, 'approve');
});

// ---------------------------------------------------------------------------
// Deny path
// ---------------------------------------------------------------------------

test('StubSignupEvaluator: junk firm-name (no vowels) → deny', async () => {
  const out = await evaluator.evaluate(input({ firm_name: 'xkcdq' }));
  assert.equal(out.decision, 'deny');
  assert.ok(out.red_flags.length > 0);
});

test('StubSignupEvaluator: 5+ consecutive consonants → deny', async () => {
  const out = await evaluator.evaluate(input({ firm_name: 'azzqqwrtxz' }));
  assert.equal(out.decision, 'deny');
});

test('StubSignupEvaluator: generic localpart + generic firm → deny', async () => {
  const out = await evaluator.evaluate(input({ email: 'test@example.com', firm_name: 'test' }));
  assert.equal(out.decision, 'deny');
});

// ---------------------------------------------------------------------------
// Review (permissive bias) path
// ---------------------------------------------------------------------------

test('StubSignupEvaluator: very-short firm name → review', async () => {
  const out = await evaluator.evaluate(input({ firm_name: 'AB' }));
  assert.equal(out.decision, 'review');
});

test('StubSignupEvaluator: gmail + generic firm name → review', async () => {
  const out = await evaluator.evaluate(input({ email: 'me@gmail.com', firm_name: 'My Firm' }));
  assert.equal(out.decision, 'review');
});

// ---------------------------------------------------------------------------
// Output shape sanity
// ---------------------------------------------------------------------------

test('StubSignupEvaluator: output shape is well-formed across paths', async () => {
  for (const fn of [
    () => input({}),
    () => input({ firm_name: 'xkcdq' }),
    () => input({ firm_name: 'AB' }),
  ]) {
    const out = await evaluator.evaluate(fn());
    assert.ok(['approve', 'deny', 'review'].includes(out.decision));
    assert.ok(typeof out.confidence === 'number' && out.confidence >= 0 && out.confidence <= 1);
    assert.ok(typeof out.rationale === 'string' && out.rationale.length > 0);
    assert.ok(Array.isArray(out.red_flags));
    assert.equal(out.tokens_in, 0);
    assert.equal(out.tokens_out, 0);
    assert.equal(out.model, 'stub-signup-evaluator-v1.0.0');
  }
});
