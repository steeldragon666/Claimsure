/**
 * Wizard Step 1 Task 04 — Daily engagement-letter reminder + auto-expire job.
 *
 * Runs daily at ~02:00 AEST (off-peak window). For every `engagement_letter`
 * row in the `sent` state, computes age = `now() - sent_to_claimant_at` and:
 *
 *   * 7d  → queues a "first reminder" email to the claimant, stamps
 *           `reminded_7d_at = now()` so the same row is filtered out on
 *           subsequent same-day runs.
 *   * 14d → queues a second reminder (with stronger copy) AND a parallel
 *           notification to the consultant — currently delivered as a
 *           second email, since the codebase has no in-app notification
 *           table yet (see docs/plans/wizard-step-1/04 §Notes). Stamps
 *           `reminded_14d_at`.
 *   * 30d → UPDATE `claim.engagement_status = 'expired'`,
 *           `engagement_letter.expired_at = now()`, invalidate
 *           `send_token` (set to NULL — the column is UNIQUE so a single
 *           rotated token doesn't block re-send).
 *
 * Idempotency: the `reminded_Nd_at IS NULL` predicate inside each
 * UPDATE…RETURNING bookmarks the row before the email is queued. If the
 * job runs twice in one day, the second pass's predicate sees the
 * non-null stamp and the email path is never reached. The 30d auto-
 * expire path is naturally idempotent — once flipped, the row no longer
 * matches the `engagement_status = 'sent'` outer filter.
 *
 * Runs as a worker (no session GUC set), so all DB access goes through
 * `privilegedSql` which is owner-of-engagement_letter and bypasses RLS.
 *
 * The email path is injected (rather than constructed inside the
 * handler) so tests can pass a deterministic in-memory recorder.
 * Production wires the same `@cpa/email`-backed sender that signup +
 * federation already use.
 *
 * **Window semantics**: the spec says "7d ± 12h" / "14d ± 12h". We
 * model this as a closed range on `sent_to_claimant_at`:
 *
 *   reminder_7d:  6.5d ≤ age < 14d   AND reminded_7d_at  IS NULL
 *   reminder_14d: 13.5d ≤ age < 30d  AND reminded_14d_at IS NULL
 *   expire:       age ≥ 30d
 *
 * The "lower-bound minus 12h, upper-bound = next-tier lower-bound"
 * shape means a row that misses a window (job didn't run that day)
 * still picks up the reminder on the next eligible day, up until the
 * next tier takes over. This is a deliberate trade-off: a row sent
 * exactly 14.0d ago picks up the 14d reminder, not the 7d — the older
 * tier wins.
 */

import type { PgBoss } from 'pg-boss';
import { privilegedSql } from '@cpa/db/client';

export const ENGAGEMENT_REMINDER_TICK_JOB_NAME = 'engagement-reminder-tick';
/** 02:00 AEST daily — off-peak window for reminder fan-out. */
export const ENGAGEMENT_REMINDER_TICK_CRON = '0 2 * * *';

/** Minimum payload an injectable email sender must accept. */
export interface ReminderEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** Minimum surface tests can stub against. */
export interface ReminderEmailSender {
  send: (input: ReminderEmailInput) => Promise<{ id: string }>;
}

/** Per-tenant lookup of the claimant + consultant contact addresses. */
export interface RecipientResolver {
  /**
   * Return the claimant primary contact email for a given engagement
   * letter, or `null` if no contact can be resolved (the row is then
   * skipped — silently, to avoid the job loop dying on bad data).
   */
  resolveClaimantEmail: (engagementLetterId: string) => Promise<string | null>;
  /**
   * Return the consultant(s) to notify at the 14d mark. May return an
   * empty array; the 14d reminder still goes to the claimant either way.
   */
  resolveConsultantEmails: (engagementLetterId: string) => Promise<string[]>;
}

export interface EngagementReminderTickResult {
  /** Rows that received a 7-day reminder this run. */
  reminded_7d: number;
  /** Rows that received a 14-day reminder this run. */
  reminded_14d: number;
  /** Rows transitioned to `expired` this run. */
  expired: number;
}

interface CandidateRow {
  id: string;
  claim_id: string;
  tenant_id: string;
  age_seconds: number;
  reminded_7d_at: Date | null;
  reminded_14d_at: Date | null;
}

const DAY_SECONDS = 24 * 60 * 60;
const HALF_DAY_SECONDS = 12 * 60 * 60;

/**
 * Run one tick of the engagement-letter reminder + auto-expire cycle.
 *
 * @param sender    Email transport (production: `@cpa/email`'s
 *                  `createEmailSender`; tests: in-memory recorder).
 * @param resolver  Lookup of claimant + consultant contact addresses
 *                  for a given engagement_letter row. Externalised
 *                  because the actual address resolution depends on
 *                  subject_tenant / employee / brand_config wiring that
 *                  isn't yet finalised across the codebase.
 */
export async function runEngagementReminderTick(
  sender: ReminderEmailSender,
  resolver: RecipientResolver,
): Promise<EngagementReminderTickResult> {
  // Pull every candidate row in one query. The set is small (open
  // engagement letters across all tenants) and the per-row work is
  // ordering-independent, so we iterate sequentially in JS — keeps the
  // logic readable and avoids interleaving partial UPDATEs across
  // categories.
  const candidates = await privilegedSql<CandidateRow[]>`
    SELECT
      el.id,
      el.claim_id,
      el.tenant_id,
      EXTRACT(EPOCH FROM (NOW() - el.sent_to_claimant_at))::bigint AS age_seconds,
      el.reminded_7d_at,
      el.reminded_14d_at
    FROM engagement_letter el
    JOIN claim c ON c.id = el.claim_id
    WHERE c.engagement_status = 'sent'
      AND el.sent_to_claimant_at IS NOT NULL
  `;

  let reminded_7d = 0;
  let reminded_14d = 0;
  let expired = 0;

  for (const row of candidates) {
    const ageSec = Number(row.age_seconds);

    // --- 30d auto-expire path (highest precedence) -----------------
    if (ageSec >= 30 * DAY_SECONDS) {
      const updated = await privilegedSql<{ id: string }[]>`
        UPDATE engagement_letter
           SET expired_at  = NOW(),
               send_token  = NULL
         WHERE id = ${row.id}
           AND expired_at IS NULL
        RETURNING id
      `;
      if (updated.length > 0) {
        await privilegedSql`
          UPDATE claim
             SET engagement_status = 'expired',
                 updated_at        = NOW()
           WHERE id = ${row.claim_id}
             AND engagement_status = 'sent'
        `;
        expired++;
      }
      continue;
    }

    // --- 14d reminder path (mid precedence) ------------------------
    // Window: 13.5d ≤ age < 30d AND not previously stamped.
    if (
      ageSec >= 14 * DAY_SECONDS - HALF_DAY_SECONDS &&
      ageSec < 30 * DAY_SECONDS &&
      row.reminded_14d_at === null
    ) {
      // Conditional UPDATE first to claim the row — emits the bookmark
      // BEFORE the email goes out so a crash mid-send doesn't double-
      // queue on the next run. Worst case: we stamp and the email
      // fails (sender throws); the row is now flagged but the
      // recipient never got the message. That's the same trade-off
      // the rest of the system makes for outbound transactional email
      // (welcome / magic-link / etc) — at-most-once.
      const claimed = await privilegedSql<{ id: string }[]>`
        UPDATE engagement_letter
           SET reminded_14d_at = NOW()
         WHERE id = ${row.id}
           AND reminded_14d_at IS NULL
        RETURNING id
      `;
      if (claimed.length > 0) {
        const claimantEmail = await resolver.resolveClaimantEmail(row.id);
        const consultantEmails = await resolver.resolveConsultantEmails(row.id);
        if (claimantEmail !== null) {
          const subject = 'Engagement letter — second reminder (14 days outstanding)';
          const body =
            'Your engagement letter has been awaiting your signature for two weeks.\n\n' +
            'If you intended to decline, please let your consultant know.\n' +
            'Otherwise, please sign at your earliest convenience — the letter ' +
            'will auto-expire 30 days after it was sent.';
          await sender.send({
            to: claimantEmail,
            subject,
            html: `<p>${body.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br/>')}</p>`,
            text: body,
          });
        }
        // Consultant notification: until the platform has an in-app
        // notification table this lands as an extra email. Each
        // consultant address gets its own send so a single bad
        // recipient doesn't poison the others.
        for (const consultantEmail of consultantEmails) {
          const subject = 'Engagement letter outstanding 14 days — claimant follow-up needed';
          const body =
            'A claimant engagement letter is still unsigned 14 days after being sent.\n\n' +
            'The platform will auto-expire the letter at the 30-day mark unless the ' +
            'claimant signs or declines first.';
          await sender.send({
            to: consultantEmail,
            subject,
            html: `<p>${body.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br/>')}</p>`,
            text: body,
          });
        }
        reminded_14d++;
      }
      continue;
    }

    // --- 7d reminder path (lowest precedence) ----------------------
    // Window: 6.5d ≤ age < 14d (the 14d window above takes over from
    // 13.5d) AND not previously stamped.
    if (
      ageSec >= 7 * DAY_SECONDS - HALF_DAY_SECONDS &&
      ageSec < 14 * DAY_SECONDS - HALF_DAY_SECONDS &&
      row.reminded_7d_at === null
    ) {
      const claimed = await privilegedSql<{ id: string }[]>`
        UPDATE engagement_letter
           SET reminded_7d_at = NOW()
         WHERE id = ${row.id}
           AND reminded_7d_at IS NULL
        RETURNING id
      `;
      if (claimed.length > 0) {
        const claimantEmail = await resolver.resolveClaimantEmail(row.id);
        if (claimantEmail !== null) {
          const subject = 'Engagement letter — gentle reminder (7 days outstanding)';
          const body =
            'This is a gentle reminder that your engagement letter is awaiting ' +
            'your signature.\n\n' +
            'It was sent one week ago. Please review and sign at your convenience.';
          await sender.send({
            to: claimantEmail,
            subject,
            html: `<p>${body.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br/>')}</p>`,
            text: body,
          });
        }
        reminded_7d++;
      }
    }
  }

  return { reminded_7d, reminded_14d, expired };
}

/**
 * Default production resolver — pulls the claimant primary-contact and
 * consultant addresses from the existing schema.
 *
 * Wiring assumptions (current schema as of migration 0087):
 *   * claimant email = subject_tenant_employee for the claim's
 *     subject_tenant, marked as primary contact. The schema doesn't yet
 *     have a single "primary contact" flag; fall back to the most
 *     recently active employee (most recent last_seen_at) with a
 *     non-null email. If no employee has an email, return null.
 *   * consultant emails = users with a tenant_user role for the firm
 *     that's tagged as the claim's consultant. Until a notification-
 *     prefs table lands, we keep this list empty in production by
 *     default — the 14d email still goes to the claimant. Override
 *     via a custom resolver in callers that have richer wiring.
 *
 * Tests should pass their own resolver rather than relying on this.
 */
export function createDefaultRecipientResolver(): RecipientResolver {
  return {
    async resolveClaimantEmail(engagementLetterId: string): Promise<string | null> {
      const rows = await privilegedSql<{ email: string | null }[]>`
        SELECT ste.email
          FROM engagement_letter el
          JOIN claim c              ON c.id = el.claim_id
          JOIN subject_tenant_employee ste
            ON ste.subject_tenant_id = c.subject_tenant_id
         WHERE el.id = ${engagementLetterId}
           AND ste.email IS NOT NULL
           AND ste.deactivated_at IS NULL
         ORDER BY ste.last_seen_at DESC NULLS LAST,
                  ste.first_seen_at DESC NULLS LAST
         LIMIT 1
      `;
      return rows[0]?.email ?? null;
    },
    resolveConsultantEmails(_engagementLetterId: string): Promise<string[]> {
      // No firm-level notification prefs in the schema yet — keep the
      // production default list empty. The 14d claimant reminder still
      // fires; the consultant notification lands as a follow-up once
      // a notification-prefs table exists. Not `async` because there's
      // nothing to await — the explicit `Promise.resolve(...)` keeps
      // the function's return type aligned with the interface.
      return Promise.resolve([]);
    },
  };
}

/**
 * Register the daily engagement-reminder tick with pg-boss.
 *
 * Mirrors `registerRifDailyScrapeJob` — explicit `createQueue` before
 * `work`/`schedule` because pg-boss v12+ no longer auto-creates queues.
 */
export async function registerEngagementReminderTickJob(
  boss: PgBoss,
  sender: ReminderEmailSender,
  resolver: RecipientResolver = createDefaultRecipientResolver(),
): Promise<void> {
  await boss.createQueue(ENGAGEMENT_REMINDER_TICK_JOB_NAME);
  await boss.work(ENGAGEMENT_REMINDER_TICK_JOB_NAME, async () => {
    const result = await runEngagementReminderTick(sender, resolver);
    console.log(
      `[engagement-reminder-tick] reminded_7d=${result.reminded_7d} ` +
        `reminded_14d=${result.reminded_14d} expired=${result.expired}`,
    );
    return result;
  });
  await boss.schedule(ENGAGEMENT_REMINDER_TICK_JOB_NAME, ENGAGEMENT_REMINDER_TICK_CRON, null, {
    tz: 'Australia/Sydney',
  });
}
