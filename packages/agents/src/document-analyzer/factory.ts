import { HaikuDocumentAnalyzer } from './haiku.js';
import { MockDocumentAnalyzer } from './mock.js';
import { StubDocumentAnalyzer } from './stub.js';
import type { DocumentAnalyzer } from './types.js';

/**
 * Selects a {@link DocumentAnalyzer} implementation from environment.
 *
 * Resolution order:
 * 1. `DOCUMENT_ANALYZER_IMPL` is honored verbatim if set
 *    (`stub` | `mock` | `haiku`).
 * 2. Otherwise, `CI=true` opts into the stub (no API key required, deterministic).
 * 3. Otherwise, defaults to `haiku` (live model, requires `ANTHROPIC_API_KEY`).
 *
 * Implementation choices:
 *   - `stub`   — returns empty arrays, usage=null. For routes that need
 *                a no-op analyzer (CI without API key).
 *   - `mock`   — returns varied schema-valid output with non-zero usage,
 *                deterministic per input. For integration tests that
 *                exercise the full pipeline including the token ledger.
 *   - `haiku`  — production path; real Anthropic call.
 *
 * Unknown values throw rather than silently falling back.
 */
export function makeDocumentAnalyzer(): DocumentAnalyzer {
  const explicit = process.env.DOCUMENT_ANALYZER_IMPL;
  const impl = explicit ?? (process.env.CI ? 'stub' : 'haiku');
  switch (impl) {
    case 'stub':
      return new StubDocumentAnalyzer();
    case 'mock':
      return new MockDocumentAnalyzer();
    case 'haiku':
      return new HaikuDocumentAnalyzer();
    default:
      throw new Error(
        `unknown DOCUMENT_ANALYZER_IMPL: ${impl} (expected 'haiku', 'mock', or 'stub')`,
      );
  }
}
