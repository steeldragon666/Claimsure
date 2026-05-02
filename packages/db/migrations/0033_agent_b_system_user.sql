-- DO NOT REGENERATE THIS MIGRATION VIA `pnpm --filter @cpa/db generate`.
-- Hand-authored migration: idempotent INSERT seed of a system-attributed
-- user row. drizzle-kit only emits schema changes — data seeds (CHECK
-- constraints, RLS policies, INSERTs, etc.) are always hand-authored
-- (existing pattern: see 0014/0015/0023/0024/0025/0026/0027/0028).
--
-- ============================================================
-- P6 Theme 4 — Agent B (activity register synthesizer) system user
-- ============================================================
-- The pg-boss worker that runs Agent B has no request user; the
-- chain's `event.captured_by_user_id` FK requires a real `user.id`.
-- This migration creates a non-loginable, system-attributed user row
-- that the worker uses as `captured_by_user_id` when emitting
-- ACTIVITY_REGISTER_DRAFTED events.
--
-- Distinct from Agent A's system user (migration 0032, p6b worktree)
-- so audit-log queries can attribute chain entries by agent — filter
-- on captured_by_user_id to see only Agent B's emissions, etc.
--
-- `primary_idp = 'microsoft'`: the schema's TS-only enum is
-- {'microsoft','google'}; the SQL column is plain text without a
-- CHECK constraint, but we pick a real-IdP value to stay
-- forward-compatible if a future migration tightens the column to a
-- DB-level enum/CHECK. The synthetic `external_id = 'system:agent-b'`
-- keeps the (primary_idp, external_id) unique index satisfied (no
-- collision with real Microsoft tenants whose external_ids are
-- 'microsoft:<oid>') and signals "this is a synthetic system row,
-- not a real Microsoft principal" to anyone reading the table.
--
-- ON CONFLICT DO NOTHING makes the seed idempotent across re-runs
-- (test setups, dev rebuilds) — the row already existing is the
-- desired state, not an error.
--
-- See apps/api/src/jobs/activity-register-synthesize.ts —
-- AGENT_B_SYSTEM_USER_ID for the call site.
-- ============================================================

INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
VALUES (
  '00000000-0000-4000-8000-000000a90002',
  'system+agent-b@cpa.local',
  'microsoft',
  'system:agent-b',
  'Agent B (Activity Register Synthesizer)'
)
ON CONFLICT (id) DO NOTHING;
