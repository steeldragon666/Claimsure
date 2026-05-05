/**
 * P7 Theme D Task D.9 — Error classifier for RIF source fetch failures.
 *
 * Maps fetch/parse errors to `last_polled_status` enum values so the
 * /intelligence UI can surface actionable diagnostics (e.g.
 * "rate_limited" -> back off; "parse_error" -> connector needs update;
 * "network_error" -> transient, retry).
 */

import type { REGULATORY_SOURCE_POLLED_STATUSES } from '@cpa/db/schema';

/**
 * Map of polled status literal types (excluding 'success' which is the happy path).
 */
type ErrorStatus = Exclude<(typeof REGULATORY_SOURCE_POLLED_STATUSES)[number], 'success'>;

/**
 * Classify a fetch/parse error into a last_polled_status enum value.
 *
 * Used by the daily scrape cron to persist a meaningful status when
 * a source connector fails, so the /intelligence UI can surface
 * actionable diagnostics.
 */
export function classifyError(err: unknown): ErrorStatus {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    // HTTP 429 or explicit rate-limit signal
    if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')) {
      return 'rate_limited';
    }
    // Parse/decode failures
    if (
      msg.includes('parse') ||
      msg.includes('syntax') ||
      msg.includes('unexpected token') ||
      msg.includes('invalid json') ||
      msg.includes('malformed')
    ) {
      return 'parse_error';
    }
    // Network-level failures
    if (
      msg.includes('econnrefused') ||
      msg.includes('enotfound') ||
      msg.includes('etimedout') ||
      msg.includes('fetch failed') ||
      msg.includes('network') ||
      msg.includes('socket') ||
      msg.includes('dns')
    ) {
      return 'network_error';
    }
  }
  // Default: network_error is the safest catch-all for unknown failures
  return 'network_error';
}
