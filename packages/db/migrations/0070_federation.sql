-- 0070_federation.sql
-- Hand-authored migration. DO NOT REGENERATE via `pnpm --filter @cpa/db generate`.
--
-- P9 Phase 3 — Federation Primitives.
-- Creates three new tables for cross-tenant read sharing:
--   1. federation_share       — core share grant (source→target for a subject_tenant)
--   2. federation_invitation  — pre-share invitation with token-hash
--   3. federation_audit       — immutable log of every federated read
--
-- All three tables are RLS-protected using the canonical
-- NULLIF(current_setting('app.current_tenant_id', true), '')::uuid pattern.
--
-- See docs/plans/2026-05-05-p9-design.md § Phase 3 for design rationale.

-- ============================================================
-- Table 1: federation_share
-- ============================================================
-- Records that firm A (source) has granted firm B (target) read-only
-- access to a specific subject_tenant's claim data.

CREATE TABLE "federation_share" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "subject_tenant_id" uuid NOT NULL REFERENCES "subject_tenant" ("id"),
  "source_tenant_id" uuid NOT NULL REFERENCES "tenant" ("id"),
  "target_tenant_id" uuid NOT NULL REFERENCES "tenant" ("id"),
  "granted_by_user_id" uuid NOT NULL REFERENCES "user" ("id"),
  "granted_at" timestamp with time zone NOT NULL DEFAULT now(),
  "revoked_at" timestamp with time zone,
  "revoked_by_user_id" uuid REFERENCES "user" ("id"),
  "revoked_reason" text,
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

ALTER TABLE "federation_share" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "federation_share" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- USING: both source and target tenants can read shares they participate in.
-- WITH CHECK: only the source tenant can create/update shares.
CREATE POLICY "federation_share_tenant_isolation" ON "federation_share"
  USING (
    source_tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR target_tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  )
  WITH CHECK (
    source_tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  );
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "federation_share" TO cpa_app;
--> statement-breakpoint

-- Index for lookups by target tenant (financier portal "my shared claims")
CREATE INDEX "federation_share_target_tenant_idx" ON "federation_share" ("target_tenant_id");
--> statement-breakpoint

-- Index for lookups by source tenant (consultant "shares I've granted")
CREATE INDEX "federation_share_source_tenant_idx" ON "federation_share" ("source_tenant_id");
--> statement-breakpoint

-- Index for RLS subquery performance on claim/activity/etc policies
CREATE INDEX "federation_share_subject_tenant_idx" ON "federation_share" ("subject_tenant_id")
  WHERE "revoked_at" IS NULL;
--> statement-breakpoint

-- ============================================================
-- Table 2: federation_invitation
-- ============================================================
-- Pre-share stage: consultant emails an invitation; financier accepts
-- to create the share.

CREATE TABLE "federation_invitation" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "subject_tenant_id" uuid NOT NULL REFERENCES "subject_tenant" ("id"),
  "source_tenant_id" uuid NOT NULL REFERENCES "tenant" ("id"),
  "target_email" text NOT NULL,
  "target_tenant_id" uuid REFERENCES "tenant" ("id"),
  "invited_by_user_id" uuid NOT NULL REFERENCES "user" ("id"),
  "token_hash" text NOT NULL UNIQUE,
  "status" text NOT NULL DEFAULT 'pending'
    CONSTRAINT "federation_invitation_status_valid" CHECK (
      status IN ('pending', 'accepted', 'expired', 'revoked')
    ),
  "expires_at" timestamp with time zone NOT NULL,
  "accepted_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

ALTER TABLE "federation_invitation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "federation_invitation" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- USING: source tenant always sees their invitations; target tenant sees
-- only after acceptance (target_tenant_id is NULL until then, so the OR
-- clause is effectively inert for pending invitations viewed by non-source).
-- WITH CHECK: only the source tenant can create invitations.
CREATE POLICY "federation_invitation_tenant_isolation" ON "federation_invitation"
  USING (
    source_tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    OR target_tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  )
  WITH CHECK (
    source_tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  );
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "federation_invitation" TO cpa_app;
--> statement-breakpoint

-- ============================================================
-- Table 3: federation_audit
-- ============================================================
-- Immutable log of every federated read action.

CREATE TABLE "federation_audit" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "federation_share_id" uuid NOT NULL REFERENCES "federation_share" ("id"),
  "accessed_by_user_id" uuid NOT NULL REFERENCES "user" ("id"),
  "resource_type" text NOT NULL,
  "resource_id" uuid NOT NULL,
  "action" text NOT NULL DEFAULT 'read',
  "accessed_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

ALTER TABLE "federation_audit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "federation_audit" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- USING: visible to tenants that participate in the underlying share.
-- WITH CHECK: only the target tenant (the one reading) can insert audit rows.
CREATE POLICY "federation_audit_tenant_isolation" ON "federation_audit"
  USING (
    federation_share_id IN (
      SELECT id FROM federation_share
      WHERE source_tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        OR target_tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    )
  )
  WITH CHECK (
    federation_share_id IN (
      SELECT id FROM federation_share
      WHERE target_tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    )
  );
--> statement-breakpoint

GRANT SELECT, INSERT ON "federation_audit" TO cpa_app;
--> statement-breakpoint

-- Index for audit lookups by share
CREATE INDEX "federation_audit_share_idx" ON "federation_audit" ("federation_share_id");
--> statement-breakpoint

-- Revoke UPDATE/DELETE on federation_audit — append-only table.
-- (GRANT above only gives SELECT + INSERT; this is a belt-and-suspenders
-- explicit revoke in case future DEFAULT PRIVILEGES widen grants.)
REVOKE UPDATE, DELETE ON "federation_audit" FROM cpa_app;
