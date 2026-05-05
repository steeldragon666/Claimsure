/**
 * Welcome email template — sent to new firm administrators on signup.
 *
 * Provides:
 * - Confirmation that the firm account was created
 * - Quick-start guide links
 * - Support contact
 *
 * Both HTML and plain-text variants for maximum deliverability.
 */

export interface WelcomeEmailData {
  /** Recipient's display name. */
  name: string;
  /** Firm/tenant name. */
  firmName: string;
  /** URL to the platform dashboard. */
  dashboardUrl: string;
  /** URL to the getting-started guide. */
  guideUrl?: string;
}

const BRAND_COLOR = '#5C7A6B'; // patina green per design system
const BG_COLOR = '#FAF8F3'; // warm cream paper base per design system

export function welcomeEmail(data: WelcomeEmailData): {
  subject: string;
  html: string;
  text: string;
} {
  const guideUrl = data.guideUrl ?? `${data.dashboardUrl}/docs/getting-started`;

  const subject = `Welcome to CPA Platform, ${data.name}`;

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
          Welcome, ${escapeHtml(data.name)}!
        </h2>
        <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#333;">
          Your firm <strong>${escapeHtml(data.firmName)}</strong> has been successfully
          created on CPA Platform. You are the firm administrator.
        </p>
        <p style="margin:0 0 24px;font-size:16px;line-height:1.6;color:#333;">
          Here is what to do next:
        </p>
        <ol style="margin:0 0 24px;padding-left:20px;font-size:16px;line-height:1.8;color:#333;">
          <li>Invite your team members from the dashboard</li>
          <li>Add your first claimant entity</li>
          <li>Start capturing R&amp;D activities</li>
        </ol>
        <table role="presentation" cellpadding="0" cellspacing="0">
          <tr>
            <td style="border-radius:6px;background:${BRAND_COLOR};">
              <a href="${escapeHtml(data.dashboardUrl)}"
                 style="display:inline-block;padding:14px 28px;color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;">
                Go to Dashboard
              </a>
            </td>
          </tr>
        </table>
        <p style="margin:24px 0 0;font-size:14px;color:#666;">
          Need help getting started?
          <a href="${escapeHtml(guideUrl)}" style="color:${BRAND_COLOR};">Read our setup guide</a>.
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding-top:24px;border-top:1px solid #e5e5e5;">
        <p style="margin:0;font-size:12px;color:#999;line-height:1.5;">
          CPA Platform &mdash; Australian R&amp;D Tax Incentive consulting tool.<br />
          You received this email because a firm account was created with this address.<br />
          This is a transactional email; no unsubscribe is required.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = `Welcome to CPA Platform, ${data.name}!

Your firm "${data.firmName}" has been successfully created. You are the firm administrator.

What to do next:
1. Invite your team members from the dashboard
2. Add your first claimant entity
3. Start capturing R&D activities

Go to your dashboard: ${data.dashboardUrl}

Need help? Read our setup guide: ${guideUrl}

---
CPA Platform - Australian R&D Tax Incentive consulting tool.
You received this email because a firm account was created with this address.`;

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
