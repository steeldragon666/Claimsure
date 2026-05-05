/**
 * Magic-link email template for passwordless login.
 *
 * Used for:
 * - Claimant portal access (primary auth method for claimants)
 * - Consultant passwordless sign-in (fallback when SSO is unavailable)
 *
 * The link contains a one-time token with a short TTL (15 minutes).
 * On click, the API verifies the token and issues a session cookie.
 */

export interface MagicLinkEmailData {
  /** Recipient's display name, if known. */
  name?: string;
  /** The magic-link URL including the one-time token. */
  magicLinkUrl: string;
  /** Minutes until the link expires. Default: 15. */
  expiresInMinutes?: number;
  /** Context: which portal this link is for. */
  portalType: 'claimant' | 'consultant';
}

const BRAND_COLOR = '#5C7A6B';
const BG_COLOR = '#FAF8F3';

export function magicLinkEmail(data: MagicLinkEmailData): {
  subject: string;
  html: string;
  text: string;
} {
  const expiresIn = data.expiresInMinutes ?? 15;
  const greeting = data.name ? `Hi ${escapeHtml(data.name)},` : 'Hi,';
  const portalLabel = data.portalType === 'claimant' ? 'Claimant Portal' : 'CPA Platform';

  const subject = `Your sign-in link for ${portalLabel}`;

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
          Sign in to ${escapeHtml(portalLabel)}
        </h2>
        <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#333;">
          ${greeting}
        </p>
        <p style="margin:0 0 24px;font-size:16px;line-height:1.6;color:#333;">
          Click the button below to sign in. This link is valid for
          <strong>${expiresIn} minute${expiresIn === 1 ? '' : 's'}</strong>
          and can only be used once.
        </p>
        <table role="presentation" cellpadding="0" cellspacing="0">
          <tr>
            <td style="border-radius:6px;background:${BRAND_COLOR};">
              <a href="${escapeHtml(data.magicLinkUrl)}"
                 style="display:inline-block;padding:14px 28px;color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;">
                Sign In
              </a>
            </td>
          </tr>
        </table>
        <p style="margin:24px 0 0;font-size:14px;color:#666;">
          If you did not request this link, you can safely ignore this email.
          No account changes will be made.
        </p>
        <div style="margin:24px 0 0;padding:12px;background:#f5f5f5;border-radius:4px;">
          <p style="margin:0;font-size:12px;color:#888;word-break:break-all;">
            If the button does not work, copy and paste this URL into your browser:<br />
            ${escapeHtml(data.magicLinkUrl)}
          </p>
        </div>
      </td>
    </tr>
    <tr>
      <td style="padding-top:24px;border-top:1px solid #e5e5e5;">
        <p style="margin:0;font-size:12px;color:#999;line-height:1.5;">
          CPA Platform &mdash; Australian R&amp;D Tax Incentive consulting tool.<br />
          This is a transactional sign-in email; no unsubscribe is required.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = `Sign in to ${portalLabel}

${data.name ? `Hi ${data.name},` : 'Hi,'}

Click the link below to sign in. This link is valid for ${expiresIn} minute${expiresIn === 1 ? '' : 's'} and can only be used once.

${data.magicLinkUrl}

If you did not request this link, you can safely ignore this email. No account changes will be made.

---
CPA Platform - Australian R&D Tax Incentive consulting tool.
This is a transactional sign-in email.`;

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
