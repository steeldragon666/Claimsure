-- Backfill GRANTs on tables that were missed by the migration 0002
-- default-privileges rule, plus add DEFAULT PRIVILEGES for the actual
-- migration runner so future tables don't repeat the bug.
--
-- ROOT CAUSE
--   Migration 0002 set up:
--     ALTER DEFAULT PRIVILEGES FOR ROLE cpa IN SCHEMA public
--       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cpa_app;
--   This only auto-grants when tables are created BY THE cpa ROLE.
--   In Supabase the migration runner is actually `postgres` (which
--   has BYPASSRLS but isn't cpa), so every table created after 0002
--   (~50 tables) silently shipped without cpa_app grants. Symptom
--   masked in dev because the app also connects as postgres and so
--   never exercises the cpa_app code path — until we tried `SET LOCAL
--   ROLE cpa_app` and hit ERROR 42501 INSUFFICIENT_PRIVILEGE.
--
-- FIX
--   1. GRANT explicit privileges on the 9 currently-missing tables
--      (snapshot taken via audit on 2026-05-14).
--   2. ALTER DEFAULT PRIVILEGES FOR ROLE postgres so future tables
--      created by the actual migration runner auto-grant.
--   3. Keep the existing FOR ROLE cpa default for backward-compat
--      with anyone who later runs migrations as cpa.
--
-- This migration is IDEMPOTENT — re-running is safe (GRANT is no-op
-- if already granted; ALTER DEFAULT PRIVILEGES overwrites cleanly).

-- 1. Backfill missing GRANTs.
GRANT SELECT, INSERT, UPDATE, DELETE ON claimant_mobile_subscription TO cpa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON floor_topup_invoice          TO cpa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON founding_partner_slots       TO cpa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON llm_token_usage              TO cpa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON narrative_segment            TO cpa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON onboarding_payment           TO cpa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON processed_webhook_events     TO cpa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON subscription                 TO cpa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON subscription_item            TO cpa_app;

-- 2. Make sure FUTURE tables created by `postgres` auto-grant to cpa_app.
--    (The original 0002 rule for `cpa` stays in place; this just adds
--    a second rule for the role that's actually creating tables.)
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cpa_app;
