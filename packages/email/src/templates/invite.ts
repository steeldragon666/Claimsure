/**
 * Team member invitation email template.
 *
 * Sent when a firm admin invites a consultant or viewer to join the firm.
 * Contains the invitation link that the recipient clicks to accept and
 * set up their account.
 */

export interface InviteEmailData {
  /** Name of the person being invited. */
  inviteeName: string;
  /** Name of the person who sent the invite (firm admin). */
  inviterName: string;
  /** Firm/tenant name. */
  firmName: string;
  /** Role being assigned: admin, consultant, or viewer. */
  role: 'admin' | 'consultant' | 'viewer';
  /** URL to accept the invitation. Includes the invite token. */
  acceptUrl: string;
  /** Number of days until the invite expires. Default: 7. */
  expiresInDays?: number;
}

const BRAND_COLOR = '#5C7A6B';
const BG_COLOR = '#FAF8F3';

const ROLE_DESCRIPTIONS: Record<string, string> = {
  admin: 'Full access to manage the firm, team members, and all claimant data',
  consultant: 'Access to assigned claimants, activity capture, and narrative drafting',
  viewer: 'Read-only access to claimant data and reports',
};

export function inviteEmail(data: InviteEmailData): {
  subject: string;
  html: string;
  text: string;
} {
  const expiresInDays = data.expiresInDays ?? 7;
  const roleDescription = ROLE_DESCRIPTIONS[data.role] ?? data.role;

  const subject = `${data.inviterName} invited you to ${data.firmName} on CPA Platform`;

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
          You have been invited to join ${escapeHtml(data.firmName)}
        </h2>
        <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#333;">
          Hi ${escapeHtml(data.inviteeName)},
        </p>
        <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#333;">
          <strong>${escapeHtml(data.inviterName)}</strong> has invited you to join
          <strong>${escapeHtml(data.firmName)}</strong> as a <strong>${escapeHtml(data.role)}</strong>.
        </p>
        <div style="margin:0 0 24px;padding:16px;background:#f0f4f2;border-radius:6px;border-left:4px solid ${BRAND_COLOR};">
          <p style="margin:0;font-size:14px;color:#555;">
            <strong>Your role:</strong> ${escapeHtml(data.role)}<br />
            ${escapeHtml(roleDescription)}
          </p>
        </div>
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
          This invitation expires in ${expiresInDays} day${expiresInDays === 1 ? '' : 's'}.
          If you did not expect this invitation, you can safely ignore this email.
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding-top:24px;border-top:1px solid #e5e5e5;">
        <p style="margin:0;font-size:12px;color:#999;line-height:1.5;">
          CPA Platform &mdash; Australian R&amp;D Tax Incentive consulting tool.<br />
          You received this because ${escapeHtml(data.inviterName)} invited you to their firm.<br />
          This is a transactional email; no unsubscribe is required.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = `You have been invited to join ${data.firmName} on CPA Platform

Hi ${data.inviteeName},

${data.inviterName} has invited you to join ${data.firmName} as a ${data.role}.

Your role: ${data.role}
${roleDescription}

Accept your invitation: ${data.acceptUrl}

This invitation expires in ${expiresInDays} day${expiresInDays === 1 ? '' : 's'}.
If you did not expect this invitation, you can safely ignore this email.

---
CPA Platform - Australian R&D Tax Incentive consulting tool.
You received this because ${data.inviterName} invited you to their firm.`;

  return { subject, html, text };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
