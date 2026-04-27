-- DO NOT REGENERATE THIS MIGRATION VIA `pnpm --filter @cpa/db generate`.
-- The block at the bottom is hand-authored: RLS policy + GRANT to cpa_app.
-- drizzle-kit will silently regenerate this file and clobber them.

CREATE TABLE "audit_score_snapshot" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_tenant_id" uuid NOT NULL,
	"total_pts" integer NOT NULL,
	"max_pts" integer NOT NULL,
	"rule_breakdown" jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_score_snapshot" ADD CONSTRAINT "audit_score_snapshot_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_score_snapshot" ADD CONSTRAINT "audit_score_snapshot_subject_tenant_id_subject_tenant_id_fk" FOREIGN KEY ("subject_tenant_id") REFERENCES "public"."subject_tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_score_snapshot_timeline_idx" ON "audit_score_snapshot" USING btree ("subject_tenant_id","computed_at" DESC NULLS LAST);
--> statement-breakpoint
-- ============================================================
-- RLS — same FORCE + USING + WITH CHECK pattern as 0002 / 0006 / 0008 / 0009
-- ============================================================

ALTER TABLE "audit_score_snapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_score_snapshot" FORCE ROW LEVEL SECURITY;
CREATE POLICY "audit_score_snapshot_tenant_isolation" ON "audit_score_snapshot"
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "audit_score_snapshot" TO cpa_app;
