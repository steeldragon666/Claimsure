-- 0003_nullif_unset_guc.sql
-- Wraps current_setting() in NULLIF so an empty-string GUC value
-- fails-safe to NULL → policy excludes rows, instead of throwing
-- 'invalid input syntax for type uuid' on cast.
--
-- Why this is needed
-- ------------------
-- postgres-js (and any pooled connection) keeps custom GUCs in the
-- 'recognized' state across connection reuse: once SET LOCAL has run
-- on a connection, current_setting('app.current_tenant_id', true)
-- returns '' (empty string) on subsequent transactions where the GUC
-- isn't re-set, NOT NULL as the two-arg form's docs suggest.
--
-- Without NULLIF: ''::uuid throws on every read/write that forgot the
-- SET LOCAL — operationally noisy and not the documented fail-safe.
-- With NULLIF: '' becomes NULL → NULL::uuid is NULL → tenant_id = NULL
-- is UNKNOWN → policy excludes all rows (correct fail-safe).
--
-- Surfaced by T12's integration test.

DROP POLICY "subject_tenant_tenant_isolation" ON "subject_tenant";
CREATE POLICY "subject_tenant_tenant_isolation" ON "subject_tenant"
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY "tenant_user_tenant_isolation" ON "tenant_user";
CREATE POLICY "tenant_user_tenant_isolation" ON "tenant_user"
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY "subject_tenant_user_tenant_isolation" ON "subject_tenant_user";
CREATE POLICY "subject_tenant_user_tenant_isolation" ON "subject_tenant_user"
  USING (
    subject_tenant_id IN (
      SELECT id FROM "subject_tenant"
      WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    )
  )
  WITH CHECK (
    subject_tenant_id IN (
      SELECT id FROM "subject_tenant"
      WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    )
  );

DROP POLICY "delegation_token_tenant_isolation" ON "delegation_token";
CREATE POLICY "delegation_token_tenant_isolation" ON "delegation_token"
  USING (issuer_tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (issuer_tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
