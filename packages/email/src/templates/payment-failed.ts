/**
 * Payment failed dunning email (P9.2.4).
 *
 * Sent to the firm administrator when a Stripe invoice payment fails for the
 * first time (subscription status transitions to past_due). Encourages the
 * customer to update their payment method via the Stripe Customer Portal.
 *
 * HTML + plain-text variants for maximum deliverability.
 */

export interface PaymentFailedData {
  /** Recipient's display name. */
  name: string;
  /** Firm/tenant name. */
  firmName: string;
  /** URL to the Stripe Customer Portal to update payment method. */
  portalUrl: string;
}

const BRAND_COLOR = '#5C7A6B'; // patina green per design system
const BG_COLOR = '#FAF8F3'; // warm cream paper base per design system

export function paymentFailedEmail(data: PaymentFailedData): {
  subject: string;
  html: string;
  text: string;
} {
  const { name, firmName, portalUrl } = data;
  const safeName = escapeHtml(name);
  const safeFirmName = escapeHtml(firmName);
  const safePortalUrl = escapeHtml(portalUrl);

  const subject = `Payment failed for ${firmName} — please update your payment method`;

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
          Hi ${safeName}, your payment did not go through
        </h2>
        <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#333;">
          We were unable to process the payment for <strong>${safeFirmName}</strong> on CPA Platform.
          This can happen if a card expires or has insufficient funds.
        </p>
        <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#333;">
          Please update your payment method to keep uninterrupted access to your R&amp;D claims and data.
        </p>
        <table role="presentation" cellpadding="0" cellspacing="0">
          <tr>
            <td style="border-radius:6px;background:${BRAND_COLOR};">
              <a href="${safePortalUrl}"
                 style="display:inline-block;padding:14px 28px;color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;">
                Update Payment Method
              </a>
            </td>
          </tr>
        </table>
        <p style="margin:24px 0 0;font-size:14px;color:#666;">
          Questions? Reply to this email or contact us at
          <a href="mailto:support@cpaplatform.com.au" style="color:${BRAND_COLOR};">support@cpaplatform.com.au</a>.
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding-top:24px;border-top:1px solid #e5e5e5;">
        <p style="margin:0;font-size:12px;color:#999;line-height:1.5;">
          CPA Platform &mdash; Australian R&amp;D Tax Incentive consulting tool.<br />
          You received this because a payment for your account failed.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = `Hi ${name},

We were unable to process the payment for "${firmName}" on CPA Platform.

Please update your payment method to keep uninterrupted access to your R&D claims and data.

Update your payment method here: ${portalUrl}

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
