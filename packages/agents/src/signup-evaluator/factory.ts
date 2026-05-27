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
  // process.env.CI is a STRING (or undefined). Truthy checks like
  // `process.env.CI ? 'stub' : 'opus'` evaluate the literal string 'false' as
  // truthy — surprising. Normalise to a strict boolean accepting '1' or 'true'
  // (case-insensitive) so deployments that explicitly set CI=false don't
  // silently land on the stub evaluator.
  const isCi = /^(1|true)$/i.test(process.env.CI ?? '');
  const impl = explicit ?? (isCi ? 'stub' : 'opus');
  switch (impl) {
    case 'stub':
      return new StubSignupEvaluator();
    case 'opus':
      return new OpusSignupEvaluator();
    default:
      throw new Error(`unknown SIGNUP_EVALUATOR_IMPL: ${impl} (expected 'opus' or 'stub')`);
  }
}
