/**
 * Email-sending interface (P3 stub, C10-C11 SES wiring later).
 *
 * Routes call `sendEmail({ to, subject, body })` and don't care about
 * the underlying transport. The console-stub impl is the default in P3:
 * employee-invite + magic-link flows will log the rendered email to
 * stderr-via-pino, sufficient for local dev and CI verification that
 * the route triggered the send.
 *
 * The `from` field is intentionally omitted from the public interface —
 * the SES impl will derive it from `brand_config.email_sender_domain`
 * (DKIM-verified per-firm sender) so callers can't accidentally spoof.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain-text body. HTML rendering arrives with the SES impl in C10. */
  body: string;
  /**
   * Optional tenant-id for the SES impl to derive the per-firm sender
   * from `brand_config.email_sender_domain`. The console-stub ignores
   * it; the SES impl will require it.
   */
  tenantId?: string;
}

export interface EmailSender {
  send(msg: EmailMessage): Promise<void>;
}

/**
 * Console-stub sender: logs the message and resolves. Used in P3 + tests.
 *
 * Intentionally not silent under LOG_LEVEL=silent — magic-link bodies
 * carry the raw token, and surfacing them via stderr is what makes the
 * employee-invite e2e test runnable without a mailbox provider.
 */
export const consoleEmailSender: EmailSender = {
  send(msg: EmailMessage): Promise<void> {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        kind: 'email.console-stub',
        to: msg.to,
        subject: msg.subject,
        body: msg.body,
        ...(msg.tenantId !== undefined ? { tenant_id: msg.tenantId } : {}),
      }),
    );
    return Promise.resolve();
  },
};

/**
 * Convenience top-level function — most callers don't want to pass an
 * `EmailSender` instance around. The SES wiring (C10-C11) will swap in
 * a module-scoped sender configured from env, while keeping the same
 * `sendEmail({...})` callsite.
 */
export function sendEmail(msg: EmailMessage): Promise<void> {
  return consoleEmailSender.send(msg);
}
