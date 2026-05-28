-- 0092_auth_login_attempt.sql
-- Per-IP rate-limit ledger for passwordless login (POST /v1/auth/login).
--
-- Why this exists:
--   The passwordless login route (routes/auth/login.ts) mints a session from
--   an email address alone — a deliberate trust-based product decision for
--   the current ArchiveOne phase. The only abuse gate is a per-IP rate limit,
--   enforced with the SAME `pg_advisory_xact_lock(hashtext('login-ip:<ip>'))`
--   serialisation the signup pipeline uses for its per-IP limit. Signup counts
--   prior rows in its own audit table (`signup_decision`); login has no audit
--   table, so this lightweight ledger backs the rolling-window count.
--
-- One row per login attempt (found OR not — recorded before the user lookup
-- so the limit cannot be bypassed by probing unknown emails). Rows are only
-- ever counted within a 1-hour window; old rows can be pruned by a future
-- housekeeping job without affecting correctness.
--
-- No RLS. Auth infrastructure (sibling of `auth_magic_link`, `user`,
-- `tenant_user`) accessed exclusively by the public, pre-session login route
-- through `privilegedSql` — the session this attempt may MINT does not exist
-- yet, so the `app.current_tenant_id` GUC that cpa_app's RLS policies require
-- cannot be set. Same rationale as 0091_auth_magic_link.sql / dev-login.ts.

CREATE TABLE IF NOT EXISTS auth_login_attempt (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_ip    inet        NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);

-- Rolling-window count query is `WHERE client_ip = $1 AND attempted_at > now()
-- - interval '1 hour'`. DESC matches the query so the index is range-scannable
-- without an extra sort.
CREATE INDEX IF NOT EXISTS auth_login_attempt_ip_idx
  ON auth_login_attempt (client_ip, attempted_at DESC);

-- Lock the table down for cpa_app. The route writes via privilegedSql so the
-- application role never needs access. Defensive against future shared-grant
-- migrations (mirrors 0091).
REVOKE ALL ON auth_login_attempt FROM cpa_app;
