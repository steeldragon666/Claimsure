/**
 * Claim-status transition notification email template.
 *
 * Sent when a claim moves between pipeline stages. Recipients vary by
 * transition: consultants get notified on all transitions; claimants get
 * notified on key milestones (e.g., activity_capture -> narrative_drafting,
 * and when a claim reaches signing_ready).
 *
 * The 7-stage pipeline taxonomy is defined in `@cpa/db/schema` as
 * `CLAIM_STAGES`: activity_capture, narrative_drafting, internal_review,
 * apportionment, signing_ready, lodgement, complete.
 */

export interface ClaimStatusEmailData {
  /** Recipient's display name. */
  recipientName: string;
  /** Claimant entity name. */
  claimantName: string;
  /** Firm name for context. */
  firmName: string;
  /** The stage the claim moved FROM. */
  previousStage: string;
  /** The stage the claim moved TO. */
  newStage: string;
  /** URL to view the claim in the platform. */
  claimUrl: string;
  /** Optional human-readable note about the transition. */
  note?: string;
}

const BRAND_COLOR = '#5C7A6B';
const BG_COLOR = '#FAF8F3';

/** Map pipeline stage identifiers to human-readable labels. */
const STAGE_LABELS: Record<string, string> = {
  activity_capture: 'Activity Capture',
  narrative_drafting: 'Narrative Drafting',
  internal_review: 'Internal Review',
  apportionment: 'Apportionment',
  signing_ready: 'Ready for Signing',
  lodgement: 'Lodgement',
  complete: 'Complete',
};

function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}

export function claimStatusEmail(data: ClaimStatusEmailData): {
  subject: string;
  html: string;
  text: string;
} {
  const newLabel = stageLabel(data.newStage);
  const prevLabel = stageLabel(data.previousStage);

  const subject = `${data.claimantName} claim moved to ${newLabel}`;

  const noteSection = data.note
    ? `<div style="margin:16px 0;padding:12px 16px;background:#f0f4f2;border-radius:6px;border-left:4px solid ${BRAND_COLOR};">
          <p style="margin:0;font-size:14px;color:#555;"><strong>Note:</strong> ${escapeHtml(data.note)}</p>
        </div>`
    : '';

  const noteText = data.note ? `\nNote: ${data.note}\n` : '';

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
          Claim Status Update
        </h2>
        <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#333;">
          Hi ${escapeHtml(data.recipientName)},
        </p>
        <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#333;">
          The R&amp;D Tax Incentive claim for <strong>${escapeHtml(data.claimantName)}</strong>
          has moved to a new stage.
        </p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
          <tr>
            <td style="padding:16px;background:#f9f9f7;border-radius:6px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:8px 0;">
                    <span style="font-size:12px;color:#888;text-transform:uppercase;letter-spacing:0.5px;">Previous Stage</span><br />
                    <span style="font-size:16px;color:#666;">${escapeHtml(prevLabel)}</span>
                  </td>
                  <td style="padding:8px 16px;font-size:20px;color:#999;text-align:center;">
                    &#8594;
                  </td>
                  <td style="padding:8px 0;">
                    <span style="font-size:12px;color:#888;text-transform:uppercase;letter-spacing:0.5px;">New Stage</span><br />
                    <span style="font-size:16px;color:${BRAND_COLOR};font-weight:600;">${escapeHtml(newLabel)}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        ${noteSection}
        <table role="presentation" cellpadding="0" cellspacing="0">
          <tr>
            <td style="border-radius:6px;background:${BRAND_COLOR};">
              <a href="${escapeHtml(data.claimUrl)}"
                 style="display:inline-block;padding:14px 28px;color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;">
                View Claim
              </a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
    <tr>
      <td style="padding-top:24px;border-top:1px solid #e5e5e5;">
        <p style="margin:0;font-size:12px;color:#999;line-height:1.5;">
          CPA Platform &mdash; ${escapeHtml(data.firmName)}<br />
          You received this because you are assigned to the ${escapeHtml(data.claimantName)} claim.<br />
          This is a transactional email; no unsubscribe is required.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = `Claim Status Update

Hi ${data.recipientName},

The R&D Tax Incentive claim for ${data.claimantName} has moved to a new stage.

Previous Stage: ${prevLabel}
New Stage: ${newLabel}
${noteText}
View the claim: ${data.claimUrl}

---
CPA Platform - ${data.firmName}
You received this because you are assigned to the ${data.claimantName} claim.`;

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
