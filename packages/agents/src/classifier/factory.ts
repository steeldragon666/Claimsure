import { HaikuClassifier } from './haiku.js';
import { StubClassifier } from './stub.js';
import type { Classifier } from './types.js';

/**
 * Selects a {@link Classifier} implementation from environment.
 *
 * Resolution order:
 * 1. `CLASSIFIER_IMPL` is honored verbatim if set (`stub` or `haiku`).
 * 2. Otherwise, `CI=true` opts into the stub (no API key required, fully
 *    deterministic).
 * 3. Otherwise, defaults to `haiku` (live model, requires `ANTHROPIC_API_KEY`).
 *
 * Unknown values throw rather than silently falling back, so misconfigured
 * deployments fail loudly at startup.
 */
export function makeClassifier(): Classifier {
  const explicit = process.env.CLASSIFIER_IMPL;
  const impl = explicit ?? (process.env.CI ? 'stub' : 'haiku');
  switch (impl) {
    case 'stub':
      return new StubClassifier();
    case 'haiku':
      return new HaikuClassifier();
    default:
      throw new Error(`unknown CLASSIFIER_IMPL: ${impl} (expected 'haiku' or 'stub')`);
  }
}
