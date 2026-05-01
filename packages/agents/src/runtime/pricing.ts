/**
 * Per-model pricing for Anthropic API calls. Rates are quoted in USD per
 * million tokens (the unit Anthropic publishes on
 * https://www.anthropic.com/pricing). Update this table when:
 *   - Anthropic publishes new prices for an existing model, OR
 *   - we start using a new model that isn't already listed here.
 *
 * Keep the table small and explicit — `computeCost` falls back to 0 for
 * unknown models so callers never throw, and a separate ops alert in
 * Grafana fires on missing-pricing emissions (see design doc Section 6).
 *
 * `as const` narrows the keys to literal types so consumers using the
 * helper get autocomplete on known model names.
 */
export const MODEL_PRICING = {
  'claude-haiku-4-5': { input_per_mtok: 0.25, output_per_mtok: 1.25 },
  'claude-sonnet-4-5': { input_per_mtok: 3.0, output_per_mtok: 15.0 },
} as const;

/**
 * Compute the USD cost (in dollars, NOT cents) for a single agent call.
 *
 * Returns 0 for unknown models — intentionally non-throwing. Telemetry is
 * a side-effect of the request: failing the entire user-visible request
 * just because we couldn't price the call would be a worse outcome than
 * recording a $0 cost. Operators see "missing pricing" via a separate
 * Grafana alert that watches for `agent.cost_usd = 0` paired with
 * non-zero token counts, so the gap is observable without breaking
 * anything.
 *
 * @param model      Model identifier as returned by the Anthropic API
 *                   (e.g. `'claude-haiku-4-5'`).
 * @param tokens_in  Input (prompt) token count from the API response.
 * @param tokens_out Output (completion) token count from the API response.
 * @returns Cost in USD. `0` for unknown models or zero usage.
 */
export function computeCost(model: string, tokens_in: number, tokens_out: number): number {
  const pricing = MODEL_PRICING[model as keyof typeof MODEL_PRICING];
  if (!pricing) return 0; // unknown model — telemetry shows 0; ops sees "missing pricing" alert
  return (tokens_in * pricing.input_per_mtok + tokens_out * pricing.output_per_mtok) / 1_000_000;
}
