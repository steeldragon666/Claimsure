import { OpusSignupEvaluator } from './opus.js';
import { StubSignupEvaluator } from './stub.js';
import type { SignupEvaluator } from './types.js';

/**
 * Selects a {@link SignupEvaluator} implementation from environment.
 *
 * Resolution order:
 * 1. `SIGNUP_EVALUATOR_IMPL` is honored verbatim if set (`stub` or `opus`).
 * 2. Otherwise, `CI=true` opts into the stub (no API key required, deterministic).
 * 3. Otherwise, defaults to `opus` (live model — name is historical; actually
 *    runs Claude Haiku 4.5 unless SIGNUP_EVALUATOR_MODEL overrides).
 *
 * Unknown values throw so misconfigured deployments fail loudly at startup.
 */
export function makeSignupEvaluator(): SignupEvaluator {
  const explicit = process.env.SIGNUP_EVALUATOR_IMPL;
  const impl = explicit ?? (process.env.CI ? 'stub' : 'opus');
  switch (impl) {
    case 'stub':
      return new StubSignupEvaluator();
    case 'opus':
      return new OpusSignupEvaluator();
    default:
      throw new Error(`unknown SIGNUP_EVALUATOR_IMPL: ${impl} (expected 'opus' or 'stub')`);
  }
}
