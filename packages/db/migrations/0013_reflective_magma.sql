-- DO NOT REGENERATE THIS MIGRATION VIA `pnpm --filter @cpa/db generate`.
-- The block at the bottom is hand-authored: 5 CHECK constraints, 2 RLS
-- policies, and 3 GRANTs to cpa_app. drizzle-kit will silently regenerate
-- this file and clobber them. If you need to change a P4 table's shape,
-- write a new migration.
--
-- Three new tables: expenditure, expenditure_line, expenditure_mapping_rule (P4 F3).
--
-- `expenditure_line` deliberately gets a GRANT but NO direct RLS / FORCE /
-- policy: it has no `tenant_id` column (per F3 design — see JSDoc on
-- `expenditure_line.ts`). Postgres RLS doesn't walk FKs, so isolation here
-- is enforced by the route layer (which always joins through `expenditure`,
-- which IS RLS-protected) plus GRANT scoping, not row-level security on
-- the child table.
--
-- The partial unique index `expenditure_source_external_unique`
-- (tenant_id, source, source_external_id WHERE source_external_id IS NOT
-- NULL) is emitted by drizzle-kit from the schema (declared in
-- `expenditure.ts`); it is NOT hand-authored in the appended block.

CREATE TABLE "expenditure_line" (
	"id" uuid PRIMARY KEY NOT NULL,
	"expenditure_id" uuid NOT NULL,
	"description" text NOT NULL,
	"account_code" text,
	"amount" numeric(12, 2) NOT NULL,
	"rd_percent" integer
);
--> statement-breakpoint
CREATE TABLE "expenditure_mapping_rule" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source" text,
	"vendor_pattern" text,
	"account_code" text,
	"description_pattern" text,
	"activity_id" uuid NOT NULL,
	"rd_percent" integer NOT NULL,
	"priority" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expenditure" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_tenant_id" uuid NOT NULL,
	"source" text NOT NULL,
	"source_external_id" text,
	"vendor_name" text NOT NULL,
	"reference" text,
	"expenditure_date" date NOT NULL,
	"total_amount" numeric(12, 2) NOT NULL,
	"currency" text NOT NULL,
	"reimbursed_to_user_id" uuid,
	"raw_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "expenditure_line" ADD CONSTRAINT "expenditure_line_expenditure_id_expenditure_id_fk" FOREIGN KEY ("expenditure_id") REFERENCES "public"."expenditure"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenditure_mapping_rule" ADD CONSTRAINT "expenditure_mapping_rule_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenditure_mapping_rule" ADD CONSTRAINT "expenditure_mapping_rule_activity_id_activity_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenditure" ADD CONSTRAINT "expenditure_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenditure" ADD CONSTRAINT "expenditure_subject_tenant_id_subject_tenant_id_fk" FOREIGN KEY ("subject_tenant_id") REFERENCES "public"."subject_tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenditure" ADD CONSTRAINT "expenditure_reimbursed_to_user_id_user_id_fk" FOREIGN KEY ("reimbursed_to_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expenditure_line_expenditure_idx" ON "expenditure_line" USING btree ("expenditure_id");--> statement-breakpoint
CREATE INDEX "expenditure_mapping_rule_tenant_idx" ON "expenditure_mapping_rule" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "expenditure_mapping_rule_activity_idx" ON "expenditure_mapping_rule" USING btree ("activity_id");--> statement-breakpoint
CREATE INDEX "expenditure_tenant_idx" ON "expenditure" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "expenditure_subject_tenant_idx" ON "expenditure" USING btree ("subject_tenant_id");--> statement-breakpoint
CREATE INDEX "expenditure_source_idx" ON "expenditure" USING btree ("source");--> statement-breakpoint
CREATE UNIQUE INDEX "expenditure_source_external_unique" ON "expenditure" USING btree ("tenant_id","source","source_external_id") WHERE "expenditure"."source_external_id" IS NOT NULL;
--> statement-breakpoint
-- ============================================================
-- DB-level CHECK constraints
-- ============================================================

-- The `source` literal list MUST match `EXPENDITURE_SOURCES` const in
-- `packages/db/src/schema/expenditure.ts`. Same order, same content.
-- Drift would surface as a runtime constraint violation on insert/update.
ALTER TABLE "expenditure" ADD CONSTRAINT expenditure_source_valid
  CHECK (source IN ('xero_invoice', 'xero_bank_tx', 'xero_receipt', 'manual'));

ALTER TABLE "expenditure" ADD CONSTRAINT expenditure_currency_aud
  CHECK (currency = 'AUD');

ALTER TABLE "expenditure_line" ADD CONSTRAINT expenditure_line_rd_percent_range
  CHECK (rd_percent IS NULL OR (rd_percent >= 0 AND rd_percent <= 100));

ALTER TABLE "expenditure_mapping_rule" ADD CONSTRAINT mapping_rule_rd_percent_range
  CHECK (rd_percent >= 0 AND rd_percent <= 100);

-- NULL-as-wildcard semantics for mapping_rule.source: a rule with NULL
-- source applies to any source classification. Mirror the same literal
-- list as `expenditure_source_valid` (must match `EXPENDITURE_SOURCES`).
ALTER TABLE "expenditure_mapping_rule" ADD CONSTRAINT mapping_rule_source_valid
  CHECK (source IS NULL OR source IN ('xero_invoice', 'xero_bank_tx', 'xero_receipt', 'manual'));

--> statement-breakpoint
-- ============================================================
-- RLS — same FORCE + USING + WITH CHECK pattern as 0002 / 0006 / 0008 / 0009 / 0010 / 0012
--
-- `expenditure_line` is intentionally omitted: no tenant_id column, isolation
-- is enforced by the route layer joining through `expenditure` (which IS
-- RLS-protected) plus GRANT scoping. See JSDoc on expenditure_line.ts.
-- ============================================================

ALTER TABLE "expenditure" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "expenditure" FORCE ROW LEVEL SECURITY;
CREATE POLICY "expenditure_tenant_isolation" ON "expenditure"
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE "expenditure_mapping_rule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "expenditure_mapping_rule" FORCE ROW LEVEL SECURITY;
CREATE POLICY "expenditure_mapping_rule_tenant_isolation" ON "expenditure_mapping_rule"
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "expenditure" TO cpa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "expenditure_line" TO cpa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "expenditure_mapping_rule" TO cpa_app;