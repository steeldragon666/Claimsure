/**
 * Founder override token — HMAC-SHA256 over `${decisionId}:${applicantEmail}`,
 * keyed with `FOUNDER_OVERRIDE_SECRET`, base64url-encoded.
 *
 * Used by the magic-link in the founder notification email to authorise
 * a 1-click override approve. The token is verified by constant-time
 * compare (see `verifyFounderApproveToken`).
 *
 * The secret is configured per-environment. If `FOUNDER_NOTIFICATION_EMAIL`
 * is set but `FOUNDER_OVERRIDE_SECRET` is unset, the boot path throws (see
 * server.ts assertion) so we never ship a notification email containing an
 * unsignable link.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

function payload(decisionId: string, applicantEmail: string): string {
  return `${decisionId}:${applicantEmail.trim().toLowerCase()}`;
}

/** Sign and return a base64url HMAC token. */
export function signFounderApproveToken(args: {
  decisionId: string;
  applicantEmail: string;
  secret: string;
}): string {
  if (args.secret.length === 0) {
    throw new Error('signFounderApproveToken: secret must be non-empty');
  }
  return createHmac('sha256', args.secret)
    .update(payload(args.decisionId, args.applicantEmail))
    .digest('base64url');
}

/**
 * Constant-time verify. Returns `true` iff the token matches the expected
 * HMAC for the given decisionId + applicantEmail.
 */
export function verifyFounderApproveToken(args: {
  token: string;
  decisionId: string;
  applicantEmail: string;
  secret: string;
}): boolean {
  if (args.secret.length === 0) return false;
  if (typeof args.token !== 'string' || args.token.length === 0) return false;

  const expected = signFounderApproveToken({
    decisionId: args.decisionId,
    applicantEmail: args.applicantEmail,
    secret: args.secret,
  });

  const a = Buffer.from(args.token);
  const b = Buffer.from(expected);
  // timingSafeEqual requires equal-length buffers; length is not a secret.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
