/**
 * Federation invitation email template — sent when a consultant firm
 * invites a financier partner to view shared claim data.
 *
 * Both HTML and plain-text variants for maximum deliverability.
 */

export interface FederationInvitationEmailData {
  /** Recipient email address (financier). */
  recipientEmail: string;
  /** Name of the consulting firm sending the invitation. */
  firmName: string;
  /** Name of the subject entity whose data is being shared. */
  entityName: string;
  /** Name of the user who sent the invitation. */
  inviterName: string;
  /** Full URL to accept the invitation (contains token). */
  acceptUrl: string;
  /** When the invitation expires. */
  expiresAt: Date;
}

const BRAND_COLOR = '#5C7A6B'; // patina green per design system
const BG_COLOR = '#FAF8F3'; // warm cream paper base per design system

export function federationInvitationEmail(data: FederationInvitationEmailData): {
  subject: string;
  html: string;
  text: string;
} {
  const expiresFormatted = data.expiresAt.toLocaleDateString('en-AU', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const subject = `${escapeHtml(data.firmName)} has shared R&D claim data with you`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${BG_COLOR};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;padding:32px 16px;">
    <tr>
      <td style="padding-bottom:24px;border-bottom:2px solid ${BRAND_COLOR};">
        <h1 style="margin:0;font-size:24px;color:${BRAND_COLOR};font-family:Georgia,'Times New Roman',serif;">
          CPA Platform
        </h1>
      </td>
    </tr>
    <tr>
      <td style="padding:32px 0;">
        <h2 style="margin:0 0 16px;font-size:20px;color:#1a1a1a;">
          You have been invited to view shared claim data
        </h2>
        <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#333;">
          <strong>${escapeHtml(data.inviterName)}</strong> from
          <strong>${escapeHtml(data.firmName)}</strong> has invited you to view
          R&amp;D Tax Incentive claim data for
          <strong>${escapeHtml(data.entityName)}</strong>.
        </p>
        <p style="margin:0 0 8px;font-size:16px;line-height:1.6;color:#333;">
          This grants <strong>read-only</strong> access to the shared claims, activities,
          and expenditure data. You will not be able to modify any records.
        </p>
        <p style="margin:0 0 24px;font-size:14px;color:#666;">
          This invitation expires on <strong>${escapeHtml(expiresFormatted)}</strong>.
        </p>
        <table role="presentation" cellpadding="0" cellspacing="0">
          <tr>
            <td style="border-radius:6px;background:${BRAND_COLOR};">
              <a href="${escapeHtml(data.acceptUrl)}"
                 style="display:inline-block;padding:14px 28px;color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;">
                Accept Invitation
              </a>
            </td>
          </tr>
        </table>
        <p style="margin:24px 0 0;font-size:14px;color:#666;">
          If you did not expect this invitation, you can safely ignore this email.
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding-top:24px;border-top:1px solid #e5e5e5;">
        <p style="margin:0;font-size:12px;color:#999;line-height:1.5;">
          CPA Platform &mdash; Australian R&amp;D Tax Incentive consulting tool.<br />
          You received this email because ${escapeHtml(data.firmName)} invited you to view shared data.<br />
          This is a transactional email; no unsubscribe is required.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = `You have been invited to view shared claim data

${data.inviterName} from ${data.firmName} has invited you to view R&D Tax Incentive claim data for ${data.entityName}.

This grants read-only access to the shared claims, activities, and expenditure data. You will not be able to modify any records.

This invitation expires on ${expiresFormatted}.

Accept the invitation: ${data.acceptUrl}

If you did not expect this invitation, you can safely ignore this email.

---
CPA Platform - Australian R&D Tax Incentive consulting tool.
You received this email because ${data.firmName} invited you to view shared data.`;

  return { subject, html, text };
}

/** Escape HTML special characters to prevent XSS in email templates. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
