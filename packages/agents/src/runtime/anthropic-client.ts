import Anthropic from '@anthropic-ai/sdk';

let client: Anthropic | null = null;

/**
 * Lazy singleton accessor for the Anthropic SDK client.
 *
 * The client is constructed on first access using ANTHROPIC_API_KEY from env.
 * `maxRetries=3` and `timeout=30_000` are SDK defaults for transient-failure
 * resilience without unbounded latency. If the env var is missing we throw
 * an explanatory error pointing at the stub fallback so callers see a
 * descriptive failure rather than an SDK-internal one.
 */
export function getAnthropicClient(): Anthropic {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY required (or set CLASSIFIER_IMPL=stub for stub-only mode)');
  }
  client = new Anthropic({ apiKey, maxRetries: 3, timeout: 30_000 });
  return client;
}

/**
 * Test-only escape hatch: clear the cached client so the next
 * {@link getAnthropicClient} call rebuilds it. Used by nock-based tests that
 * need to swap ANTHROPIC_API_KEY mid-run; production code should never call
 * this.
 */
export function _resetAnthropicClientForTests(): void {
  client = null;
}
