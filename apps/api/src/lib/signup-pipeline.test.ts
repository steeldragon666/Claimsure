import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSignupPipeline, type SignupPipelineDeps } from './signup-pipeline.js';

// We use `unknown as Sql` shape in test mocks (typeof postgres-js client).
// Pull the type from the deps interface so we don't have to import `postgres`
// directly into apps/api's test file.
type Sql = SignupPipelineDeps['privilegedSql'];
import type {
  SignupEvaluator,
  SignupEvaluatorInput,
  SignupEvaluatorOutput,
} from '@cpa/agents/signup-evaluator';
import type { AbrLookupResult } from './abr-client.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/**
 * Fake Sql client that returns a fixed count for the rate-limit query.
 * We don't try to mimic postgres-js fully — just respond to the one query
 * pattern the pipeline issues.
 */
function fakeSql(opts: { rateLimitCount?: number; throwOnCount?: boolean }): Sql {
  // Tagged-template proxy: every call returns the count row. The pipeline
  // only issues SELECT count(*) ... so a single row is enough.
  const tag = ((..._args: unknown[]) => {
    if (opts.throwOnCount) {
      return Promise.reject(new Error('synthetic DB failure'));
    }
    return Promise.resolve([{ c: String(opts.rateLimitCount ?? 0) }]);
  }) as unknown as Sql;
  return tag;
}

function fakeEvaluator(output: Partial<SignupEvaluatorOutput>): SignupEvaluator {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async evaluate(_input: SignupEvaluatorInput): Promise<SignupEvaluatorOutput> {
      return {
        decision: 'approve',
        confidence: 0.8,
        rationale: 'fake',
        red_flags: [],
        model: 'fake-model',
        prompt_version: 'evaluate-signup@1.0.0',
        tokens_in: 100,
        tokens_out: 30,
        ...output,
      };
    },
  };
}

function throwingEvaluator(): SignupEvaluator {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async evaluate(): Promise<SignupEvaluatorOutput> {
      throw new Error('synthetic anthropic 5xx');
    },
  };
}

function abrSkipped(): (firmName: string) => Promise<AbrLookupResult> {
  return () => Promise.resolve({ skipped: true, matches: [], raw: null, error: null });
}

function abrWithMatches(
  matches: AbrLookupResult['matches'],
): (firmName: string) => Promise<AbrLookupResult> {
  return () => Promise.resolve({ skipped: false, matches, raw: { Names: matches }, error: null });
}

function silentLogger(): SignupPipelineDeps['logger'] {
  return { warn: () => {}, error: () => {}, info: () => {} };
}

function baseDeps(over: Partial<SignupPipelineDeps>): SignupPipelineDeps {
  return {
    privilegedSql: fakeSql({}),
    evaluator: fakeEvaluator({}),
    abrLookup: abrSkipped(),
    logger: silentLogger(),
    env: {},
    ...over,
  };
}

const baseInput = {
  email: 'jordan@acme.com.au',
  firmName: 'Acme R&D Advisory',
  displayName: 'Jordan Blake',
  clientIp: '203.0.113.7',
  userAgent: 'TestAgent/1.0',
};

// ---------------------------------------------------------------------------
// Step 1: admin override
// ---------------------------------------------------------------------------

test('Step 1: admin override email auto-approves without calling the evaluator', async () => {
  let evaluatorCalled = false;
  const deps = baseDeps({
    env: {
      SIGNUP_AUTO_APPROVE_OVERRIDE_EMAILS: 'aaron@carbonproject.com.au, op@archiveone.com.au',
    },
    evaluator: {
      evaluate: () => {
        evaluatorCalled = true;
        return Promise.reject(new Error('should not be called'));
      },
    },
  });
  const result = await runSignupPipeline(
    { ...baseInput, email: 'Aaron@CarbonProject.com.au' }, // case-insensitive
    deps,
  );
  assert.equal(result.outcome.decision, 'approve');
  assert.equal(result.outcome.reason, 'admin_override');
  assert.equal(result.audit.adminOverrideHit, true);
  assert.equal(evaluatorCalled, false);
});

test('Step 1: admin override list is case-insensitive and trim-tolerant', async () => {
  const deps = baseDeps({
    env: { SIGNUP_AUTO_APPROVE_OVERRIDE_EMAILS: '  AARON@cp.com.au , beta@example.com ' },
  });
  const r1 = await runSignupPipeline({ ...baseInput, email: 'aaron@cp.com.au' }, deps);
  const r2 = await runSignupPipeline({ ...baseInput, email: 'BETA@example.com' }, deps);
  assert.equal(r1.outcome.reason, 'admin_override');
  assert.equal(r2.outcome.reason, 'admin_override');
});

// ---------------------------------------------------------------------------
// Step 2: rate limit
// ---------------------------------------------------------------------------

test('Step 2: rate limit (5/hour) is enforced — at 5 the next signup denies', async () => {
  const deps = baseDeps({ privilegedSql: fakeSql({ rateLimitCount: 5 }) });
  const result = await runSignupPipeline(baseInput, deps);
  assert.equal(result.outcome.decision, 'deny');
  assert.equal(result.outcome.reason, 'rate_limit');
  assert.equal(result.audit.rateLimitCountInWindow, 5);
});

test('Step 2: under the rate limit, pipeline proceeds', async () => {
  const deps = baseDeps({ privilegedSql: fakeSql({ rateLimitCount: 4 }) });
  const result = await runSignupPipeline(baseInput, deps);
  // No deny — should reach evaluator → approve
  assert.equal(result.outcome.decision, 'approve');
  assert.equal(result.audit.rateLimitCountInWindow, 4);
});

test('Step 2: rate-limit DB failure resolves to permissive approve', async () => {
  const deps = baseDeps({ privilegedSql: fakeSql({ throwOnCount: true }) });
  const result = await runSignupPipeline(baseInput, deps);
  assert.equal(result.outcome.decision, 'approve');
  assert.equal(result.outcome.reason, 'infra_failure_permissive');
});

test('Step 2: missing client IP cannot rate-limit but proceeds', async () => {
  let queryRan = false;
  const sql = ((..._args: unknown[]) => {
    queryRan = true;
    return Promise.resolve([{ c: '0' }]);
  }) as unknown as Sql;
  const deps = baseDeps({ privilegedSql: sql });
  const result = await runSignupPipeline({ ...baseInput, clientIp: null }, deps);
  assert.equal(result.outcome.decision, 'approve');
  // The pipeline does NOT consult the DB when clientIp is null.
  assert.equal(queryRan, false);
});

// ---------------------------------------------------------------------------
// Step 3: email shape
// ---------------------------------------------------------------------------

test('Step 3: throwaway domain (mailinator) → deny', async () => {
  const deps = baseDeps({});
  const result = await runSignupPipeline({ ...baseInput, email: 'someone@mailinator.com' }, deps);
  assert.equal(result.outcome.decision, 'deny');
  assert.equal(result.outcome.reason, 'email_shape');
  assert.equal(result.audit.emailShapeOk, false);
});

test('Step 3: yopmail throwaway → deny', async () => {
  const deps = baseDeps({});
  const result = await runSignupPipeline({ ...baseInput, email: 'a@yopmail.com' }, deps);
  assert.equal(result.outcome.reason, 'email_shape');
});

test('Step 3: invalid TLD shape → deny', async () => {
  const deps = baseDeps({});
  const result = await runSignupPipeline({ ...baseInput, email: 'jordan@acme' }, deps);
  assert.equal(result.outcome.decision, 'deny');
  assert.equal(result.outcome.reason, 'email_shape');
});

test('Step 3: legitimate work email passes shape gate', async () => {
  const deps = baseDeps({});
  const result = await runSignupPipeline(baseInput, deps);
  assert.equal(result.audit.emailShapeOk, true);
  assert.equal(result.outcome.decision, 'approve');
});

// ---------------------------------------------------------------------------
// Step 4: ABR lookup
// ---------------------------------------------------------------------------

test('Step 4: ABR matches are forwarded to the evaluator', async () => {
  // Capture the input via a single-cell array — ESLint's no-unsafe-member-access
  // narrows .pop() cleanly, whereas a `let capturedInput | null` captured in a
  // closure defeats tsc's flow analysis across the async boundary.
  const captured: SignupEvaluatorInput[] = [];
  const evaluator: SignupEvaluator = {
    // eslint-disable-next-line @typescript-eslint/require-await
    async evaluate(input) {
      captured.push(input);
      return {
        decision: 'approve',
        confidence: 0.85,
        rationale: 'looks fine',
        red_flags: [],
        model: 'fake',
        prompt_version: 'evaluate-signup@1.0.0',
        tokens_in: 1,
        tokens_out: 1,
      };
    },
  };
  const deps = baseDeps({
    evaluator,
    abrLookup: abrWithMatches([
      {
        matched_name: 'Acme Pty Ltd',
        abn: '12345',
        entity_type: 'Australian Private Company',
        abn_status: 'Active',
        registration_state: 'NSW',
      },
    ]),
  });
  await runSignupPipeline(baseInput, deps);
  assert.equal(captured.length, 1);
  const evalInput = captured[0];
  if (!evalInput) throw new Error('evaluator was not invoked');
  assert.equal(evalInput.abr_match.length, 1);
  assert.equal(evalInput.abr_match[0]?.abn, '12345');
});

test('Step 4: ABR skipped (no GUID) → evaluator still runs with empty matches', async () => {
  let abrMatch: SignupEvaluatorInput['abr_match'] | null = null;
  const evaluator: SignupEvaluator = {
    // eslint-disable-next-line @typescript-eslint/require-await
    async evaluate(input) {
      abrMatch = input.abr_match;
      return {
        decision: 'approve',
        confidence: 0.8,
        rationale: '',
        red_flags: [],
        model: 'fake',
        prompt_version: 'evaluate-signup@1.0.0',
        tokens_in: 0,
        tokens_out: 0,
      };
    },
  };
  const deps = baseDeps({ evaluator, abrLookup: abrSkipped() });
  await runSignupPipeline(baseInput, deps);
  assert.deepEqual(abrMatch, []);
});

// ---------------------------------------------------------------------------
// Step 5: Claude evaluator (compose final decision)
// ---------------------------------------------------------------------------

test('Step 5: Claude deny with high confidence (>0.7) → deny', async () => {
  const deps = baseDeps({
    evaluator: fakeEvaluator({
      decision: 'deny',
      confidence: 0.92,
      rationale: 'random firm name',
      red_flags: ['firm name appears generated'],
    }),
  });
  const result = await runSignupPipeline(baseInput, deps);
  assert.equal(result.outcome.decision, 'deny');
  assert.equal(result.outcome.reason, 'claude_deny');
  assert.equal(result.audit.claudeDecision, 'deny');
  assert.equal(result.audit.claudeConfidence, 0.92);
  assert.deepEqual(result.audit.claudeRedFlags, ['firm name appears generated']);
});

test('Step 5: Claude deny with low confidence (<=0.7) → permissive approve', async () => {
  const deps = baseDeps({
    evaluator: fakeEvaluator({ decision: 'deny', confidence: 0.5 }),
  });
  const result = await runSignupPipeline(baseInput, deps);
  assert.equal(result.outcome.decision, 'approve');
  assert.equal(result.outcome.reason, 'permissive_fallback');
});

test('Step 5: Claude approve with confidence > 0.5 → approve', async () => {
  const deps = baseDeps({ evaluator: fakeEvaluator({ decision: 'approve', confidence: 0.7 }) });
  const result = await runSignupPipeline(baseInput, deps);
  assert.equal(result.outcome.decision, 'approve');
  assert.equal(result.outcome.reason, 'claude_approve');
});

test('Step 5: Claude approve with confidence <= 0.5 → permissive approve', async () => {
  const deps = baseDeps({ evaluator: fakeEvaluator({ decision: 'approve', confidence: 0.4 }) });
  const result = await runSignupPipeline(baseInput, deps);
  assert.equal(result.outcome.decision, 'approve');
  assert.equal(result.outcome.reason, 'permissive_fallback');
});

test('Step 5: Claude review → permissive approve', async () => {
  const deps = baseDeps({ evaluator: fakeEvaluator({ decision: 'review', confidence: 0.6 }) });
  const result = await runSignupPipeline(baseInput, deps);
  assert.equal(result.outcome.decision, 'approve');
  assert.equal(result.outcome.reason, 'permissive_fallback');
});

test('Step 5: Claude evaluator throws → infra_failure_permissive approve', async () => {
  const deps = baseDeps({ evaluator: throwingEvaluator() });
  const result = await runSignupPipeline(baseInput, deps);
  assert.equal(result.outcome.decision, 'approve');
  assert.equal(result.outcome.reason, 'infra_failure_permissive');
});

// ---------------------------------------------------------------------------
// Audit row population
// ---------------------------------------------------------------------------

test('Audit: every approve carries elapsedMs and claude token counts', async () => {
  const deps = baseDeps({
    evaluator: fakeEvaluator({ tokens_in: 250, tokens_out: 80 }),
  });
  const result = await runSignupPipeline(baseInput, deps);
  assert.ok(result.audit.elapsedMs >= 0);
  assert.equal(result.audit.tokensIn, 250);
  assert.equal(result.audit.tokensOut, 80);
  assert.equal(result.audit.classifierModel, 'fake-model');
});

test('Audit: admin override carries no claude or ABR data', async () => {
  const deps = baseDeps({
    env: { SIGNUP_AUTO_APPROVE_OVERRIDE_EMAILS: 'aaron@carbonproject.com.au' },
  });
  const result = await runSignupPipeline(
    { ...baseInput, email: 'aaron@carbonproject.com.au' },
    deps,
  );
  assert.equal(result.audit.classifierModel, null);
  assert.equal(result.audit.abrLookup, null);
  assert.equal(result.audit.claudeConfidence, null);
});
