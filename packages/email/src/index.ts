/**
 * @cpa/email — Transactional email infrastructure.
 *
 * Built on Resend. Provides:
 * - A configured client with retry logic (`./client`)
 * - A unified send function with rate limiting (`./send`)
 * - Email templates for platform transactional flows (`./templates/*`)
 */
export { createResendClient, withRetry, isRetryableError } from './client.js';
export type { ResendClient, ResendClientOptions } from './client.js';

export { createEmailSender, RateLimiter } from './send.js';
export type { SendEmailInput, SendEmailResult, EmailSenderOptions } from './send.js';

export { welcomeEmail } from './templates/welcome.js';
export { inviteEmail } from './templates/invite.js';
export { magicLinkEmail } from './templates/magic-link.js';
export { claimStatusEmail } from './templates/claim-status.js';
