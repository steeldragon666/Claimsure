import { SonnetRegisterSynthesizer } from './sonnet.js';
import { StubRegisterSynthesizer } from './stub.js';
import type { RegisterSynthesizer } from './types.js';

/**
 * Selects a {@link RegisterSynthesizer} implementation from environment.
 *
 * Resolution order:
 * 1. `ACTIVITY_REGISTER_SYNTHESIZER_IMPL` is honored verbatim if set
 *    (`stub` or `sonnet`).
 * 2. Otherwise, `CI=true` opts into the stub (no API key required, fully
 *    deterministic).
 * 3. Otherwise, defaults to `sonnet` (live model, requires
 *    `ANTHROPIC_API_KEY`).
 *
 * Unknown values throw rather than silently falling back, so misconfigured
 * deployments fail loudly at startup.
 */
export function makeRegisterSynthesizer(): RegisterSynthesizer {
  const explicit = process.env.ACTIVITY_REGISTER_SYNTHESIZER_IMPL;
  const impl = explicit ?? (process.env.CI ? 'stub' : 'sonnet');
  switch (impl) {
    case 'stub':
      return new StubRegisterSynthesizer();
    case 'sonnet':
      return new SonnetRegisterSynthesizer();
    default:
      throw new Error(
        `unknown ACTIVITY_REGISTER_SYNTHESIZER_IMPL: ${impl} (expected 'sonnet' or 'stub')`,
      );
  }
}
