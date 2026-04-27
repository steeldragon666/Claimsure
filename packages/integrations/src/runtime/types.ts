/**
 * Common types shared across integration runtime helpers.
 *
 * These are provider-agnostic — provider-specific shapes live alongside
 * each integration (e.g. `deepgram/`, `docusign/`).
 */

export type OAuthTokens = {
  access_token: string;
  refresh_token?: string;
  expires_at: Date;
  scopes?: string[];
  external_account_id?: string;
};

export type WebhookVerifyResult = {
  valid: boolean;
  reason?: string;
};

export type RetryOptions = {
  /** Maximum number of attempts (including the first). Default 5. */
  max_attempts?: number;
  /** Initial delay in ms before the second attempt. Default 200. */
  initial_delay_ms?: number;
  /** Cap on the exponential backoff delay in ms. Default 30_000. */
  max_delay_ms?: number;
  /** Jitter ratio applied symmetrically (±jitter). Default 0.3 (±30%). */
  jitter_ratio?: number;
};

export type RateLimitOptions = {
  /** Maximum tokens the bucket can hold. */
  capacity: number;
  /** Tokens added per second (steady-state rate). */
  refill_per_second: number;
};
