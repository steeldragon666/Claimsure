/**
 * Founder notification email — fires after every signup pipeline run.
 *
 * Both approves AND denies notify, giving the founder full visibility into
 * autonomous decisions. For `decision='deny' AND reason='claude_deny'`, the
 * email includes a 1-click magic link that overrides the deny: see
 * `apps/api/src/routes/auth/founder-approve.ts`.
 *
 * Gating:
 *   - Caller passes `recipients` already parsed from
 *     `FOUNDER_NOTIFICATION_EMAIL`. If the array is empty, the sender is a
 *     no-op (returns immediately) — the caller should not even call us in
 *     that case, but defence-in-depth.
 *   - `@cpa/email` is lazy-imported by the caller (same pattern as
 *     engagement-reminder), so this file imports its types only and the
 *     dependency tree stays clean.
 *
 * Errors:
 *   - Never throw out to the signup route. The caller MUST wrap in
 *     try/catch and log via `req.log.warn` — a failed founder notification
 *     must NOT block the signup response (the founder can backfill from
 *     the signup_decision table; the user cannot recover from a hung
 *     signup).
 */
import type { SignupPipelineResult, SignupDecisionReason } from './signup-pipeline.js';
import { signFounderApproveToken } from './founder-override-token.js';

/** Minimum interface the caller's sender must implement. */
export interface FounderNotificationSender {
  send: (input: {
    to: string | string[];
    subject: string;
    html: string;
    text: string;
  }) => Promise<{ id: string }>;
}

export interface FounderNotificationInput {
  decisionId: string;
  email: string;
  firmName: string;
  displayName: string | null;
  clientIp: string | null;
  userAgent: string | null;
  outcome: SignupPipelineResult['outcome'];
  audit: SignupPipelineResult['audit'];
}

export interface FounderNotificationConfig {
  /** Parsed FOUNDER_NOTIFICATION_EMAIL recipients. */
  recipients: string[];
  /** Required when any of the recipients might receive an override link. */
  overrideSecret: string;
  /** Site origin for the override link, e.g. https://archiveone.com.au. */
  publicBaseUrl: string;
}

/**
 * Parse a comma-separated list of email addresses. Empty / whitespace-only
 * entries are dropped. Lower-cased for stable comparison.
 */
export function parseFounderRecipients(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** ABR summary line ('N matches' / 'no matches' / 'skipped' / 'error: ...'). */
function summariseAbr(abr: unknown): string {
  if (abr === null || abr === undefined) return 'skipped';
  // The pipeline stores either the raw ABR response (object) or null.
  // We only surface a coarse summary — the full row is in signup_decision.
  if (typeof abr === 'object') {
    const matchCount = (abr as { matches?: { length?: number } })?.matches?.length;
    if (typeof matchCount === 'number') {
      return matchCount === 0 ? 'no matches' : `${matchCount} match${matchCount === 1 ? '' : 'es'}`;
    }
    return 'present';
  }
  return 'present';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface RenderedNotification {
  subject: string;
  text: string;
  html: string;
}

/**
 * Compose the subject/text/html for a single signup. Exported for tests.
 *
 * When `overrideLink` is non-null, the body includes the 1-click line. The
 * caller passes the URL it built using {@link buildOverrideLink}.
 */
export function renderFounderNotification(
  input: FounderNotificationInput,
  overrideLink: string | null,
): RenderedNotification {
  const { outcome, audit } = input;
  const decision = outcome.decision;
  const reason: SignupDecisionReason = outcome.reason;
  const subject = `[ArchiveOne signup] ${decision}: ${input.firmName}`;

  const lines: string[] = [];
  lines.push(`Decision: ${decision} (${reason})`);
  lines.push('');
  lines.push(`Applicant email: ${input.email}`);
  lines.push(`Firm name:       ${input.firmName}`);
  if (input.displayName) {
    lines.push(`Display name:    ${input.displayName}`);
  }
  if (audit.claudeConfidence !== null) {
    lines.push(`Claude confidence: ${audit.claudeConfidence}`);
  }
  if (audit.claudeDecision) {
    lines.push(`Claude decision:   ${audit.claudeDecision}`);
  }
  if (audit.claudeRationale) {
    lines.push(`Claude rationale:  ${audit.claudeRationale}`);
  }
  if (audit.claudeRedFlags && audit.claudeRedFlags.length > 0) {
    lines.push(`Red flags:         ${audit.claudeRedFlags.join('; ')}`);
  }
  lines.push(`ABR lookup:        ${summariseAbr(audit.abrLookup)}`);
  if (input.clientIp) {
    lines.push(`IP:                ${input.clientIp}`);
  }
  if (input.userAgent) {
    lines.push(`User-Agent:        ${input.userAgent}`);
  }
  lines.push('');
  lines.push(`Decision id: ${input.decisionId}`);

  if (overrideLink) {
    lines.push('');
    lines.push(`1-click approve override: ${overrideLink}`);
  }

  const text = lines.join('\n');

  // Simple HTML — same fields, escape user-provided strings.
  const rows: string[] = [];
  rows.push(`<p><strong>Decision:</strong> ${escapeHtml(decision)} (${escapeHtml(reason)})</p>`);
  rows.push('<ul>');
  rows.push(`<li><strong>Applicant email:</strong> ${escapeHtml(input.email)}</li>`);
  rows.push(`<li><strong>Firm name:</strong> ${escapeHtml(input.firmName)}</li>`);
  if (input.displayName) {
    rows.push(`<li><strong>Display name:</strong> ${escapeHtml(input.displayName)}</li>`);
  }
  if (audit.claudeConfidence !== null) {
    rows.push(
      `<li><strong>Claude confidence:</strong> ${escapeHtml(String(audit.claudeConfidence))}</li>`,
    );
  }
  if (audit.claudeDecision) {
    rows.push(`<li><strong>Claude decision:</strong> ${escapeHtml(audit.claudeDecision)}</li>`);
  }
  if (audit.claudeRationale) {
    rows.push(`<li><strong>Claude rationale:</strong> ${escapeHtml(audit.claudeRationale)}</li>`);
  }
  if (audit.claudeRedFlags && audit.claudeRedFlags.length > 0) {
    rows.push(
      `<li><strong>Red flags:</strong> ${escapeHtml(audit.claudeRedFlags.join('; '))}</li>`,
    );
  }
  rows.push(`<li><strong>ABR lookup:</strong> ${escapeHtml(summariseAbr(audit.abrLookup))}</li>`);
  if (input.clientIp) {
    rows.push(`<li><strong>IP:</strong> ${escapeHtml(input.clientIp)}</li>`);
  }
  if (input.userAgent) {
    rows.push(`<li><strong>User-Agent:</strong> ${escapeHtml(input.userAgent)}</li>`);
  }
  rows.push(`<li><strong>Decision id:</strong> ${escapeHtml(input.decisionId)}</li>`);
  rows.push('</ul>');

  if (overrideLink) {
    rows.push(
      `<p><strong>1-click approve override:</strong> <a href="${escapeHtml(overrideLink)}">${escapeHtml(overrideLink)}</a></p>`,
    );
  }

  const html = rows.join('\n');

  return { subject, text, html };
}

/** Build the override magic-link URL for a `claude_deny` decision. */
export function buildOverrideLink(args: {
  decisionId: string;
  applicantEmail: string;
  secret: string;
  publicBaseUrl: string;
}): string {
  const token = signFounderApproveToken({
    decisionId: args.decisionId,
    applicantEmail: args.applicantEmail,
    secret: args.secret,
  });
  const base = args.publicBaseUrl.replace(/\/+$/, '');
  return `${base}/v1/admin/signup-decisions/${encodeURIComponent(args.decisionId)}/approve?token=${encodeURIComponent(token)}`;
}

/**
 * Send the founder notification. Throws on send failure — caller MUST
 * try/catch and never let a failure propagate into the signup response.
 */
export async function sendFounderNotification(
  sender: FounderNotificationSender,
  input: FounderNotificationInput,
  config: FounderNotificationConfig,
): Promise<void> {
  if (config.recipients.length === 0) return;

  const includesOverride =
    input.outcome.decision === 'deny' && input.outcome.reason === 'claude_deny';
  const overrideLink = includesOverride
    ? buildOverrideLink({
        decisionId: input.decisionId,
        applicantEmail: input.email,
        secret: config.overrideSecret,
        publicBaseUrl: config.publicBaseUrl,
      })
    : null;

  const rendered = renderFounderNotification(input, overrideLink);

  await sender.send({
    to: config.recipients,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
  });
}
