import type { ResendClient } from './client.js';
import { withRetry } from './client.js';

/**
 * Unified email send function with rate limiting and error handling.
 *
 * Wraps the Resend SDK's send method with:
 * - Input validation (required fields)
 * - Retry with exponential backoff (via client config)
 * - Structured error reporting
 * - Rate limiting via a simple token-bucket
 */

export interface SendEmailInput {
  /** Recipient email address. */
  to: string | string[];
  /** Email subject line. */
  subject: string;
  /** HTML body. */
  html: string;
  /** Plain-text fallback body. Required for accessibility + deliverability. */
  text: string;
  /** Reply-to address. Defaults to the from address. */
  replyTo?: string;
  /** Optional tags for Resend analytics. */
  tags?: Array<{ name: string; value: string }>;
}

export interface SendEmailResult {
  /** Resend message ID. */
  id: string;
}

export interface EmailSenderOptions {
  /** Verified sender address, e.g. "CPA Platform <noreply@cpaplatform.com>". */
  fromAddress: string;
  /** Maximum emails per second. Default: 10 (Resend's free-tier limit). */
  maxPerSecond?: number;
}

/**
 * Simple token-bucket rate limiter.
 *
 * Allows up to `maxTokens` operations per second. Each call to `acquire()`
 * either succeeds immediately or waits until the next refill. This prevents
 * bursting past Resend's rate limits when sending batch notifications
 * (e.g., claim-status updates to all consultants on a firm).
 */
export class RateLimiter {
  private tokens: number;
  private readonly maxTokens: number;
  private lastRefill: number;

  constructor(maxPerSecond: number) {
    this.maxTokens = maxPerSecond;
    this.tokens = maxPerSecond;
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens > 0) {
      this.tokens--;
      return;
    }
    // Wait until the next refill window.
    const waitMs = 1000 - (Date.now() - this.lastRefill);
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    this.refill();
    this.tokens--;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed >= 1000) {
      this.tokens = this.maxTokens;
      this.lastRefill = now;
    }
  }
}

/**
 * Validate the minimum required fields for sending an email.
 * Throws a descriptive error on invalid input. Fail-fast: never trust
 * client data — validate at the boundary.
 */
function validateInput(input: SendEmailInput): void {
  const errors: string[] = [];

  if (!input.to || (Array.isArray(input.to) && input.to.length === 0)) {
    errors.push('`to` is required and must be a non-empty string or array');
  }
  if (!input.subject || input.subject.trim().length === 0) {
    errors.push('`subject` is required');
  }
  if (!input.html || input.html.trim().length === 0) {
    errors.push('`html` body is required');
  }
  if (!input.text || input.text.trim().length === 0) {
    errors.push('`text` fallback body is required');
  }

  if (errors.length > 0) {
    throw new Error(`Email validation failed: ${errors.join('; ')}`);
  }
}

/**
 * Create a unified email sender.
 *
 * The returned `send` function validates input, acquires a rate-limit token,
 * and dispatches through the Resend SDK with automatic retry.
 *
 * Usage:
 * ```ts
 * import { createResendClient } from '@cpa/email/client';
 * import { createEmailSender } from '@cpa/email/send';
 *
 * const client = createResendClient();
 * const sender = createEmailSender(client, {
 *   fromAddress: 'CPA Platform <noreply@cpaplatform.com>',
 * });
 *
 * await sender.send({
 *   to: 'user@example.com',
 *   subject: 'Welcome!',
 *   html: welcomeHtml({ name: 'Jane' }),
 *   text: welcomeText({ name: 'Jane' }),
 * });
 * ```
 */
export function createEmailSender(
  client: ResendClient,
  options: EmailSenderOptions,
): { send: (input: SendEmailInput) => Promise<SendEmailResult> } {
  const { fromAddress, maxPerSecond = 10 } = options;
  const limiter = new RateLimiter(maxPerSecond);

  async function send(input: SendEmailInput): Promise<SendEmailResult> {
    validateInput(input);
    await limiter.acquire();

    const result = await withRetry(
      async () => {
        // Build the payload object. `exactOptionalPropertyTypes` requires
        // that optional fields are either present with a value or absent
        // entirely — `undefined` is not acceptable. Spread conditionally.
        const payload: Parameters<typeof client.sdk.emails.send>[0] = {
          from: fromAddress,
          to: Array.isArray(input.to) ? input.to : [input.to],
          subject: input.subject,
          html: input.html,
          text: input.text,
          ...(input.replyTo ? { replyTo: input.replyTo } : {}),
          ...(input.tags ? { tags: input.tags } : {}),
        };
        const response = await client.sdk.emails.send(payload);

        if (response.error) {
          // Resend returns errors in the response body rather than throwing.
          // Wrap as an Error with a statusCode so the retry logic can classify it.
          const err = new Error(`Resend API error: ${response.error.message}`) as Error & {
            statusCode?: number;
          };
          // Resend error objects include a `name` field like 'rate_limit_exceeded',
          // 'validation_error', etc. Map to HTTP-like status codes for retry logic.
          const name = response.error.name;
          if (name === 'rate_limit_exceeded') {
            err.statusCode = 429;
          } else if (name === 'internal_server_error') {
            err.statusCode = 500;
          } else {
            err.statusCode = 400;
          }
          throw err;
        }

        return { id: response.data.id };
      },
      client.maxRetries,
      client.baseDelayMs,
    );

    return result;
  }

  return { send };
}
