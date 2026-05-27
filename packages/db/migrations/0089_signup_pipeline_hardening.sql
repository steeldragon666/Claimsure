-- 0089_signup_pipeline_hardening.sql
-- Defence-in-depth for the auto-approve signup pipeline (PR #101 follow-up).
--
-- TWO concerns addressed in this single migration so they can be reasoned about
-- together. They share a "harden the signup happy-path" theme:
--
--   1. Tenant-creation race
--      The signup route does lookupActiveTenant → INSERT tenant → INSERT
--      tenant_user as four separate statements. Two concurrent approved signups
--      for the same email both pass the lookupActiveTenant check (neither has
--      committed yet) and both proceed to create a new tenant + tenant_user
--      pair. The route now wraps these in a transaction with a re-check inside,
--      but a defence-in-depth DB constraint catches the case even if the route
--      is bypassed (e.g. a future admin-tooling path inserts directly).
--
--      The constraint: at most ONE default tenant_user per user. This is
--      enforced as a partial unique index on (user_id) filtered to
--      is_default = true AND deleted_at IS NULL. A user can still belong to
--      multiple tenants (as a non-default member), but they can only have ONE
--      "home" workspace at a time, which is the invariant that the signup
--      pipeline establishes.
--
--   2. signup_decision schema drift
--      Migration 0088 created the table but left `reason` and `claude_decision`
--      as free-text. The application enforces the enum at the code layer
--      (writeSignupDecisionAudit only emits a closed set of strings), but a
--      bad code path or a manual insert from psql could quietly land a typo.
--      Add CHECK constraints to mirror the Zod / TS union at the DB layer —
--      three-way parity with the source of truth in
--      apps/api/src/lib/signup-pipeline.ts and signup-evaluator/types.ts.

-- ============================================================
-- Part 1: tenant_user — at most one default per user
-- ============================================================
--
-- The existing 0005 partial unique index covers (tenant_id, user_id) so a
-- user can't appear twice in the same tenant. This new index covers (user_id)
-- so a user can't have TWO default workspaces — which would happen if two
-- concurrent signups raced through the tenant-creation path.
--
-- Filter: is_default = true so non-default memberships (the user is a guest
-- in someone else's firm) don't fight for the slot. Also deleted_at IS NULL
-- so a soft-deleted default doesn't block a fresh signup.
--
-- Why this is a defence-in-depth constraint, not the primary fix: the route
-- handler now serialises the create inside `db.begin` with a re-check on
-- lookupActiveTenant. The index is the safety net.

CREATE UNIQUE INDEX IF NOT EXISTS "tenant_user_one_default_per_user_uniq"
  ON "tenant_user" (user_id)
  WHERE is_default = true AND deleted_at IS NULL;

-- ============================================================
-- Part 2: signup_decision — CHECK constraints on enum-shaped columns
-- ============================================================
--
-- `reason` is the gate that produced the final pipeline outcome. The
-- application emits one of:
--   admin_override            — env-list bypass at step 1
--   rate_limit                — IP exceeded 5/hour at step 2
--   email_shape               — disposable/malformed at step 3
--   claude_approve            — LLM approve + confidence > 0.5
--   claude_deny               — LLM deny + confidence > 0.7
--   permissive_fallback       — LLM review or low-confidence (resolves to approve)
--   infra_failure_permissive  — DB/ABR/Anthropic failed → permissive approve
--   already_registered        — duplicate email detected post-pipeline
--                                (route-side terminal, not a pipeline reason)
--
-- `claude_decision` is the LLM's raw verdict before the pipeline's confidence
-- floor is applied. Tri-state enum: approve / deny / review. NULL when the
-- LLM was never called (admin_override, rate_limit, email_shape, infra failure).

ALTER TABLE signup_decision
  ADD CONSTRAINT signup_decision_reason_valid CHECK (reason IN (
    'admin_override',
    'rate_limit',
    'email_shape',
    'claude_approve',
    'claude_deny',
    'permissive_fallback',
    'infra_failure_permissive',
    'already_registered'
  ));

ALTER TABLE signup_decision
  ADD CONSTRAINT signup_decision_claude_decision_valid CHECK (
    claude_decision IS NULL OR claude_decision IN ('approve', 'deny', 'review')
  );
