-- DO NOT REGENERATE THIS MIGRATION VIA `pnpm --filter @cpa/db generate`.
-- Hand-authored migration: two cache tables (xero_contact, xero_account)
-- with composite primary keys, a functional GIN index, RLS policies, and
-- GRANTs to cpa_app. drizzle-kit cannot fully express two of these:
--   1. The functional GIN index on `to_tsvector('english', name)` for
--      fuzzy vendor matching — drizzle-kit emits btree-only indexes
--      from the schema model.
--   2. The RLS / FORCE / policy block (same hand-authored pattern as
--      0013 — see DO-NOT-REGENERATE header there).
--
-- ============================================================
-- MIGRATION NUMBERING — A1 vs B5 SWIMLANE COORDINATION
-- ============================================================
-- The original P4 plan listed this as 0015_xero_caches.sql. Migration
-- 0015 has since been claimed by Swimlane A's A1 task
-- (0015_project_updated_kind.sql on branch p4a/evidence-engine), which
-- this branch (p4b/xero-expenditure) does not yet see — separate
-- worktree. Locally drizzle-kit's _journal.json on this branch jumps
-- 0014 → 0016 (idx=14 → idx=16, no idx=15 entry); drizzle-orm iterates
-- the entries array and tolerates the gap.
--
-- At swimlane merge time, A1's 0015 + B5's 0016 will sit consecutively.
-- If _journal.json conflicts at merge, the combined version should have
-- entries `idx=15` (project_updated_kind) and `idx=16` (xero_caches) in
-- order. CI (`pnpm --filter @cpa/db migrate`) validates the journal-vs-
-- file contract and will surface any divergence before merge.
-- ============================================================

CREATE TABLE "xero_contact" (
	"tenant_id" uuid NOT NULL,
	"xero_contact_id" text NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"is_supplier" boolean DEFAULT false NOT NULL,
	"is_customer" boolean DEFAULT false NOT NULL,
	"contact_status" text NOT NULL,
	"raw_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "xero_contact_tenant_id_xero_contact_id_pk" PRIMARY KEY("tenant_id","xero_contact_id")
);
--> statement-breakpoint
CREATE TABLE "xero_account" (
	"tenant_id" uuid NOT NULL,
	"xero_account_id" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"raw_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "xero_account_tenant_id_xero_account_id_pk" PRIMARY KEY("tenant_id","xero_account_id")
);
--> statement-breakpoint
ALTER TABLE "xero_contact" ADD CONSTRAINT "xero_contact_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "xero_account" ADD CONSTRAINT "xero_account_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "xero_contact_tenant_idx" ON "xero_contact" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "xero_account_tenant_code_idx" ON "xero_account" USING btree ("tenant_id","code");
--> statement-breakpoint

-- ============================================================
-- Hand-authored: functional GIN index for fuzzy vendor matching.
-- drizzle-kit cannot emit indexes on a function expression
-- (to_tsvector(...)). Powers the F5 mapping-rule UI's "find
-- vendor by partial name" path — consultants typing "smith" should
-- match "Smith Industries Pty Ltd" without a btree-prefix scan.
-- ============================================================

CREATE INDEX "xero_contact_name_idx" ON "xero_contact"
  USING gin (to_tsvector('english', "name"));

--> statement-breakpoint
-- ============================================================
-- RLS — same FORCE + USING + WITH CHECK pattern as 0002 / 0006 / 0008
-- / 0009 / 0010 / 0012 / 0013. Both cache tables are tenant-scoped;
-- although they hold no PII beyond contact name/email and the chart
-- of accounts, RLS keeps the multi-tenancy invariant uniform across
-- the schema.
-- ============================================================

ALTER TABLE "xero_contact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "xero_contact" FORCE ROW LEVEL SECURITY;
CREATE POLICY "xero_contact_tenant_isolation" ON "xero_contact"
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE "xero_account" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "xero_account" FORCE ROW LEVEL SECURITY;
CREATE POLICY "xero_account_tenant_isolation" ON "xero_account"
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "xero_contact" TO cpa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "xero_account" TO cpa_app;
