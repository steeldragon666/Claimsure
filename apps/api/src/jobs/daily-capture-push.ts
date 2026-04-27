import { privilegedSql } from '@cpa/db/client';

/**
 * Daily-capture push notification job (T-A12).
 *
 * Runs once per day (the pg-boss cron subscriber wiring lands later)
 * and nudges every active employee who hasn't captured an event yet
 * today to open the app and record one.
 *
 * For v1 the actual Expo Push Notifications API call is a STUB — the
 * job logs the matching tokens + returns a count, so the cron driver
 * + observability scaffolding can be exercised end-to-end without
 * burning real device deliveries during integration tests. The real
 * impl will POST to https://exp.host/--/api/v2/push/send in batches
 * of up to 100 tokens.
 *
 * Eligibility (all conditions ANDed):
 *   - The employee has an unrevoked, unexpired mobile_session with a
 *     non-null push_token.
 *   - The employee has been active in the last 30 days
 *     (last_seen_at > NOW() - 30 days).
 *   - The employee is NOT deactivated (deactivated_at IS NULL).
 *   - The employee has NOT already captured an event today
 *     (`captured_at::date = CURRENT_DATE`).
 *
 * Timezone: v1 uses server-side CURRENT_DATE — single platform-wide
 * trigger, no per-employee TZ. Multi-tz support (a per-firm
 * preferred_send_hour + IANA timezone) is a follow-up; the cron
 * dispatcher would partition the job by timezone offset.
 */
export type DailyCapturePushInput = Record<string, never>;

export type DailyCapturePushResult = {
  /** Count of (employee_id, push_token) rows that WOULD be notified. */
  sent: number;
  /** Count skipped pre-flight (currently always 0; placeholder for the
   *  future per-tenant/per-employee opt-out + quiet-hours filtering). */
  skipped: number;
};

/**
 * Row shape returned by the eligibility query. Pulled out as a named
 * type so future filters (e.g. preferred_locale for the body string)
 * can be added without churning the SELECT in two places.
 */
type EligibleRecipient = {
  employee_id: string;
  push_token: string;
};

/**
 * Run the daily-capture push job.
 *
 * Returns the count of notifications that WOULD have been sent + a
 * placeholder skipped count. The caller (pg-boss subscriber, future)
 * surfaces these to OTel + dashboards.
 *
 * Exported separately from `selectEligibleRecipients` so tests can
 * exercise the SQL filter independently of the (stubbed) send loop.
 */
export async function runDailyCapturePushJob(
  _input: DailyCapturePushInput = {},
): Promise<DailyCapturePushResult> {
  const recipients = await selectEligibleRecipients();

  // STUB: real Expo Push Notifications API call. The shape we'll
  // post is a JSON array of message objects with { to, title, body,
  // data } — token batching at 100/req. For v1 we only count.
  for (const r of recipients) {
    console.log(
      '[daily-capture-push] STUB: would notify employee',
      r.employee_id,
      'with token',
      r.push_token.slice(0, 10) + '…',
    );
  }

  return { sent: recipients.length, skipped: 0 };
}

/**
 * Resolve the set of (employee_id, push_token) pairs to notify on
 * this run. Exported separately so the test suite can assert the
 * eligibility filter in isolation — the stubbed send loop has no
 * meaningful side effect to assert against.
 *
 * `DISTINCT` deduplicates the rare case where an employee has two
 * active sessions on different devices with the same push_token
 * (re-installs that re-registered the same token). One notification
 * per employee is the right behaviour either way.
 */
export async function selectEligibleRecipients(): Promise<EligibleRecipient[]> {
  return await privilegedSql<EligibleRecipient[]>`
    SELECT DISTINCT s.employee_id, s.push_token
      FROM mobile_session s
      JOIN subject_tenant_employee e ON e.id = s.employee_id
     WHERE s.push_token IS NOT NULL
       AND s.revoked_at IS NULL
       AND s.expires_at > NOW()
       AND e.last_seen_at > NOW() - INTERVAL '30 days'
       AND e.deactivated_at IS NULL
       AND NOT EXISTS (
         -- Mobile captures land with captured_by_employee_id set + user_id
         -- null (migration 0011 + chain.ts dual-capturer model). Match the
         -- claimant-side employee column so this exclusion correctly catches
         -- "this employee already captured today" — the original
         -- captured_by_user_id check would never match since user.id and
         -- subject_tenant_employee.id live in disjoint namespaces.
         SELECT 1 FROM event ev
          WHERE ev.captured_by_employee_id = e.id
            AND ev.captured_at::date = CURRENT_DATE
       )
  `;
}
