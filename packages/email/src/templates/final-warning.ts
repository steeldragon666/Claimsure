/**
 * Final warning dunning email (P9.2.4).
 *
 * Sent to the firm administrator when a payment fails and the subscription is
 * already past_due (i.e., this is a repeated failure). Warns that the
 * subscription will be cancelled on a specific date unless payment is resolved.
 *
 * HTML + plain-text variants for maximum deliverability.
 */

export interface FinalWarningData {
  /** Recipient's display name. */
  name: string;
  /** Firm/tenant name. */
  firmName: string;
  /** URL to the Stripe Customer Portal to update payment method. */
  portalUrl: string;
  /** Human-readable date when the subscription will be cancelled, e.g. "20 May 2026". */
  cancellationDate: string;
}

const BRAND_COLOR = '#5C7A6B'; // patina green per design system
const BG_COLOR = '#FAF8F3'; // warm cream paper base per design system

export function finalWarningEmail(data: FinalWarningData): {
  subject: string;
  html: string;
  text: string;
} {
  const { name, firmName, portalUrl, cancellationDate } = data;
  const safeName = escapeHtml(name);
  const safeFirmName = escapeHtml(firmName);
  const safePortalUrl = escapeHtml(portalUrl);
  const safeCancellationDate = escapeHtml(cancellationDate);

  const subject = `Final warning: your CPA Platform subscription will be cancelled on ${cancellationDate}`;

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
        <h2 style="margin:0 0 16px;font-size:20px;color:#c0392b;">
          Action required: subscription cancellation on ${safeCancellationDate}
        </h2>
        <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#333;">
          Hi ${safeName},
        </p>
        <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#333;">
          We have been unable to collect payment for <strong>${safeFirmName}</strong> on CPA Platform.
          If payment is not resolved by <strong>${safeCancellationDate}</strong>, your subscription will
          be cancelled and access to your account will be suspended.
        </p>
        <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#333;">
          Update your payment method now to avoid losing access to your R&amp;D claims, activities, and data.
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
          You received this because payment for your account has not been received.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = `Hi ${name},

FINAL WARNING: Your CPA Platform subscription for "${firmName}" will be cancelled on ${cancellationDate} if payment is not resolved.

We have been unable to collect payment for your account. Please update your payment method immediately to avoid losing access to your R&D claims, activities, and data.

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
