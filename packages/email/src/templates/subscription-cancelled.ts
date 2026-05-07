/**
 * Subscription cancelled confirmation email (P9.2.4).
 *
 * Sent to the firm administrator when their Stripe subscription is deleted
 * (customer.subscription.deleted webhook event). Confirms the cancellation
 * and provides next steps.
 *
 * HTML + plain-text variants for maximum deliverability.
 */

export interface SubscriptionCancelledData {
  /** Recipient's display name. */
  name: string;
  /** Firm/tenant name. */
  firmName: string;
}

const BRAND_COLOR = '#5C7A6B'; // patina green per design system
const BG_COLOR = '#FAF8F3'; // warm cream paper base per design system

export function subscriptionCancelledEmail(data: SubscriptionCancelledData): {
  subject: string;
  html: string;
  text: string;
} {
  const { name, firmName } = data;
  const safeName = escapeHtml(name);
  const safeFirmName = escapeHtml(firmName);

  const subject = `Your CPA Platform subscription for ${firmName} has been cancelled`;

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
          Hi ${safeName}, your subscription has been cancelled
        </h2>
        <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#333;">
          Your CPA Platform subscription for <strong>${safeFirmName}</strong> has been cancelled.
          Access to your account has been suspended.
        </p>
        <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#333;">
          Your data is retained for 90 days. If you would like to reactivate your account,
          please contact us and we will assist you with the process.
        </p>
        <p style="margin:0 0 24px;font-size:16px;line-height:1.6;color:#333;">
          Thank you for using CPA Platform. We hope to work with you again in the future.
        </p>
        <p style="margin:0;font-size:14px;color:#666;">
          Questions? Reply to this email or contact us at
          <a href="mailto:support@cpaplatform.com.au" style="color:${BRAND_COLOR};">support@cpaplatform.com.au</a>.
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding-top:24px;border-top:1px solid #e5e5e5;">
        <p style="margin:0;font-size:12px;color:#999;line-height:1.5;">
          CPA Platform &mdash; Australian R&amp;D Tax Incentive consulting tool.<br />
          You received this because your subscription has ended.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = `Hi ${name},

Your CPA Platform subscription for "${firmName}" has been cancelled. Access to your account has been suspended.

Your data is retained for 90 days. If you would like to reactivate your account, please contact us at support@cpaplatform.com.au.

Thank you for using CPA Platform. We hope to work with you again in the future.

---
CPA Platform - Australian R&D Tax Incentive consulting tool.
Questions? Contact us at support@cpaplatform.com.au`;

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
