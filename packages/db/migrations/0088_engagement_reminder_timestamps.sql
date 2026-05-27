-- Migration 0088 — Wizard Step 1 Task 04 engagement-letter reminder timestamps.
--
-- Adds idempotency columns to `engagement_letter` for the daily
-- engagement-reminder-tick pg-boss job:
--
--   reminded_7d_at  — set when the 7-day reminder email is queued
--   reminded_14d_at — set when the 14-day reminder + consultant
--                     notification email is queued
--
-- Both are nullable timestamptz. The job's idempotency guard is a
-- `WHERE reminded_Nd_at IS NULL` predicate in the UPDATE…RETURNING that
-- bookmarks the row before the email is queued — running the job twice
-- in the same day re-evaluates the predicate against the just-updated
-- row and finds it non-NULL, so the second pass is a no-op.
--
-- The 30-day auto-expire path doesn't need its own column: the
-- `expired_at` timestamptz already exists from migration 0087 and the
-- `engagement_status = 'expired'` transition (driven by the same job)
-- is itself idempotent — once flipped, the row no longer matches the
-- handler's `engagement_status = 'sent'` filter.
--
-- IDEMPOTENT via IF NOT EXISTS so re-running is safe; no down migration
-- (append-only schema is the convention, see README "Cross-task
-- conventions"). RLS already enabled on the table (0087); column adds
-- don't touch the policy.

ALTER TABLE engagement_letter
  ADD COLUMN IF NOT EXISTS reminded_7d_at  timestamptz,
  ADD COLUMN IF NOT EXISTS reminded_14d_at timestamptz;
