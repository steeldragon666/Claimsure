-- ============================================================
-- P6 Theme 3 - Agent A (expenditure classifier) system user
--
-- The pg-boss worker has no request user; the chain's
-- captured_by_user_id FK requires a real user row. This migration
-- creates a non-loginable, system-attributed user the worker uses
-- as captured_by_user_id when emitting EXPENDITURE_CLASSIFIED events.
--
-- The synthetic email + external_id keep this user distinguishable
-- in audit logs and prevent collision with any real Microsoft / Google
-- federated user. NOT marked deleted because the FK requires the row
-- to exist for the chain's lifetime.
--
-- primary_idp is set to 'microsoft' rather than a synthetic value
-- because the Drizzle schema (packages/db/src/schema/user.ts)
-- declares the column as a TS enum of {'microsoft','google'};
-- adding a third variant would force a schema-wide change for one
-- row. The external_id 'system:agent-a' is unambiguous and won't
-- collide under the (primary_idp, external_id) unique index from
-- migration 0004 because no real Microsoft Entra subject takes that
-- shape (real subjects are GUIDs, not 'system:*').
--
-- See apps/api/src/jobs/expenditure-classify.ts AGENT_A_SYSTEM_USER_ID
-- for the call site.
-- ============================================================

INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
VALUES (
  '00000000-0000-4000-8000-000000a90001',
  'system+agent-a@cpa.local',
  'microsoft',
  'system:agent-a',
  'Agent A (Expenditure Classifier)'
)
ON CONFLICT (id) DO NOTHING;
