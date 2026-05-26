# 04 — Engagement Reminder + Expire Job

**Depends on:** 01, 02

## Goal

Periodic pg-boss job that runs daily, finds engagement letters in `sent` state, and triggers:
- 7-day reminder email (first reminder)
- 14-day reminder email + in-app notification to the consultant
- 30-day auto-expire (`engagement_status = 'expired'`)

## Files to add

- `apps/api/src/jobs/engagement-reminder-tick.ts` — the daily tick job
- `apps/api/src/jobs/engagement-reminder-tick.test.ts` — test
- Job registration in the bootstrap

## Implementation

1. Schedule: pg-boss recurring schedule, daily at ~02:00 AEST (off-peak).
2. Handler queries `engagement_letter` rows via `privilegedSql`:
   - `WHERE engagement_status = 'sent' AND sent_to_claimant_at IS NOT NULL`
3. For each row, compute `daysSinceSent = age(now(), sent_to_claimant_at)`:
   - **7d ± 12h** → send 7-day reminder via email-sender-state-machine (look for existing `email-sender-state-machine.test.ts` for the API pattern).
   - **14d ± 12h** → send 14-day reminder + create in-app notification for the consultant (use the `audit_log` or notification table — check what exists).
   - **30d** → UPDATE `claim.engagement_status = 'expired'`, `engagement_letter.expired_at = now()`, invalidate `send_token`.
4. Idempotency: track last-reminder-sent timestamps via a new column or via the existing email-sender ledger. Don't send 7-day reminder twice if the job runs twice in one day.

## Acceptance

- [ ] Job runs daily without errors.
- [ ] Test fixture: insert a row with `sent_to_claimant_at = now() - 7 days`, run the job, assert reminder email queued.
- [ ] Test fixture: insert a row with `sent_to_claimant_at = now() - 30 days`, run the job, assert `engagement_status = 'expired'`.
- [ ] Idempotent (re-running same day = no duplicate reminders).

## Deliverable

PR titled `feat(api): engagement letter reminder + auto-expire daily job`.

## Notes

If the codebase doesn't have a notification table, the 14-day "notify consultant" step can land as an email-only reminder for v1 — note as a follow-up.
