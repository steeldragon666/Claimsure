-- DO NOT REGENERATE THIS MIGRATION VIA `pnpm --filter @cpa/db generate`.
-- Hand-authored migration: compliance capture tables for the Australian
-- R&D Tax Incentive platform. drizzle-kit cannot fully express:
--   1. CHECK constraints (owner_kind, similarity_kind, reviewer_disposition,
--      forecast_year_offset, confidence, activity_pair_ordered,
--      search_before_activity) — drizzle's check() helper round-trips poorly
--      and is omitted from the schema model on this branch (existing pattern
--      in 0006/0008/0010/0012/0013/0016/0018/0022/0029/0030/0038).
--   2. GENERATED ALWAYS AS ... STORED columns (beneficial_ownership).
--   3. The RLS / FORCE / policy block (same hand-authored pattern as
--      0016 / 0018 / 0022 / 0029 / 0030 / 0038).
--
-- ============================================================
-- P7 Theme D Task D.5 — compliance capture tables
-- ============================================================
-- Five tables that capture structured compliance data required for the
-- Australian R&D Tax Incentive registration and offset claim workflow.
-- These tables support the Compliance Data Capture layer described in
-- Section 4.5.2 of the P7 design document.
--
-- FIVE TABLES:
--   1. beneficial_ownership          — UBO register for TA 2023 s4/s5 flags
--   2. knowledge_search_record       — prior-art / knowledge-gap searches
--   3. multi_entity_similarity_score — cross-entity activity dedup scoring
--   4. r_and_d_facility              — facility register for Form D
--   5. rd_forecast                   — 3-year spend forecast (Form C / ATP)
--
-- TENANT ISOLATION: all five tables carry a tenant_id column with RLS
-- policy using the NULLIF-wrapped current_setting pattern (see 0003
-- commentary + 0022 audit_log keystone) so an unset GUC fails-safe to
-- "deny everything". FORCE is required even on owner-controlled tables,
-- otherwise the cpa role bypasses RLS.
--
-- GENERATED COLUMNS: beneficial_ownership.ta_2023_4_flag and
-- ta_2023_5_flag are GENERATED ALWAYS AS ... STORED so the compliance
-- flag derivation is structural and cannot drift from the source booleans
-- (is_associate, is_foreign_related). These columns appear in the
-- registration form export and must always reflect current row state.
--
-- NULLABLE activity_b_id: multi_entity_similarity_score allows NULL
-- activity_b_id for rows representing similarity against the historical-
-- rejection corpus (regulatory_event rows). In that case only activity_a_id
-- references a local activity. The activity_pair_ordered constraint permits
-- NULL in the b-slot.
--
-- INDEXES:
--   - beneficial_ownership (tenant_id, subject_tenant_id, fy_label)
--   - knowledge_search_record (tenant_id, activity_id)
--   - multi_entity_similarity_score (tenant_id, activity_a_id)
--   - multi_entity_similarity_score (tenant_id, activity_b_id)
--   - r_and_d_facility (tenant_id, subject_tenant_id, fy_label)
--   - rd_forecast (tenant_id, subject_tenant_id, base_fy_label)
-- ============================================================

-- ============================================================
-- 1. beneficial_ownership — UBO register for TA 2023 s4/s5 flags.
-- ============================================================

CREATE TABLE "beneficial_ownership" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"subject_tenant_id" uuid NOT NULL,
	"fy_label" text NOT NULL,
	"owner_kind" text NOT NULL,
	"owner_name" text NOT NULL,
	"owner_country" text,
	"ownership_pct" numeric(5,2) NOT NULL,
	"is_associate" boolean NOT NULL DEFAULT false,
	"is_foreign_related" boolean NOT NULL DEFAULT false,
	"ta_2023_4_flag" boolean GENERATED ALWAYS AS ("is_associate") STORED,
	"ta_2023_5_flag" boolean GENERATED ALWAYS AS ("is_foreign_related") STORED,
	"first_recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "beneficial_ownership_owner_kind_valid" CHECK (
		"owner_kind" IN ('individual','entity','foreign_entity','associate')
	)
);
--> statement-breakpoint

ALTER TABLE "beneficial_ownership" ADD CONSTRAINT "beneficial_ownership_tenant_id_tenant_id_fk"
	FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "beneficial_ownership" ADD CONSTRAINT "beneficial_ownership_subject_tenant_id_subject_tenant_id_fk"
	FOREIGN KEY ("subject_tenant_id") REFERENCES "public"."subject_tenant"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "beneficial_ownership" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "beneficial_ownership" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "beneficial_ownership_tenant_isolation" ON "beneficial_ownership"
	USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON "beneficial_ownership" TO cpa_app;
-- DELETE intentionally not granted: ownership records are compliance evidence;
-- corrections are made via new rows or UPDATEs, never hard deletes.
REVOKE DELETE ON "beneficial_ownership" FROM cpa_app;
--> statement-breakpoint

-- Per-subject per-FY lookup: "show all UBOs for subject X in FY 2024-25"
CREATE INDEX "beneficial_ownership_subject_fy_idx" ON "beneficial_ownership" USING btree ("tenant_id","subject_tenant_id","fy_label");
--> statement-breakpoint

-- ============================================================
-- 2. knowledge_search_record — prior-art / knowledge-gap searches.
-- ============================================================

CREATE TABLE "knowledge_search_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"subject_tenant_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"search_date" date NOT NULL,
	"search_query" text NOT NULL,
	"sources_consulted" jsonb NOT NULL,
	"finding_summary" text NOT NULL,
	"recorded_by_user_id" uuid,
	"first_recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_search_record_search_before_activity" CHECK ("search_date" <= CURRENT_DATE)
);
--> statement-breakpoint

ALTER TABLE "knowledge_search_record" ADD CONSTRAINT "knowledge_search_record_tenant_id_tenant_id_fk"
	FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge_search_record" ADD CONSTRAINT "knowledge_search_record_subject_tenant_id_subject_tenant_id_fk"
	FOREIGN KEY ("subject_tenant_id") REFERENCES "public"."subject_tenant"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge_search_record" ADD CONSTRAINT "knowledge_search_record_activity_id_activity_id_fk"
	FOREIGN KEY ("activity_id") REFERENCES "public"."activity"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge_search_record" ADD CONSTRAINT "knowledge_search_record_recorded_by_user_id_user_id_fk"
	FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "knowledge_search_record" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "knowledge_search_record" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "knowledge_search_record_tenant_isolation" ON "knowledge_search_record"
	USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON "knowledge_search_record" TO cpa_app;
-- DELETE intentionally not granted: search records are compliance evidence
-- (demonstrates the "new knowledge" criterion was investigated).
REVOKE DELETE ON "knowledge_search_record" FROM cpa_app;
--> statement-breakpoint

-- Per-activity lookup: "show all knowledge searches for activity X"
CREATE INDEX "knowledge_search_record_activity_idx" ON "knowledge_search_record" USING btree ("tenant_id","activity_id");
--> statement-breakpoint

-- ============================================================
-- 3. multi_entity_similarity_score — cross-entity activity dedup scoring.
-- ============================================================

CREATE TABLE "multi_entity_similarity_score" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"activity_a_id" uuid NOT NULL,
	"activity_b_id" uuid,
	"similarity_score" numeric(4,3) NOT NULL,
	"similarity_kind" text NOT NULL,
	"flagged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_by_user_id" uuid,
	"reviewed_at" timestamp with time zone,
	"reviewer_disposition" text,
	CONSTRAINT "multi_entity_similarity_score_score_range" CHECK (
		"similarity_score" BETWEEN 0 AND 1
	),
	CONSTRAINT "multi_entity_similarity_score_kind_valid" CHECK (
		"similarity_kind" IN ('lexical','semantic','hybrid','vs_historical_rejection')
	),
	CONSTRAINT "multi_entity_similarity_score_disposition_valid" CHECK (
		"reviewer_disposition" IS NULL OR "reviewer_disposition" IN (
			'benign_overlap','requires_differentiation','duplicate_must_remove'
		)
	),
	CONSTRAINT "multi_entity_similarity_score_pair_ordered" CHECK (
		"activity_a_id" < "activity_b_id" OR "activity_b_id" IS NULL
	)
);
--> statement-breakpoint

ALTER TABLE "multi_entity_similarity_score" ADD CONSTRAINT "multi_entity_similarity_score_tenant_id_tenant_id_fk"
	FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "multi_entity_similarity_score" ADD CONSTRAINT "multi_entity_similarity_score_activity_a_id_activity_id_fk"
	FOREIGN KEY ("activity_a_id") REFERENCES "public"."activity"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "multi_entity_similarity_score" ADD CONSTRAINT "multi_entity_similarity_score_activity_b_id_activity_id_fk"
	FOREIGN KEY ("activity_b_id") REFERENCES "public"."activity"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "multi_entity_similarity_score" ADD CONSTRAINT "multi_entity_similarity_score_reviewed_by_user_id_user_id_fk"
	FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "multi_entity_similarity_score" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "multi_entity_similarity_score" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "multi_entity_similarity_score_tenant_isolation" ON "multi_entity_similarity_score"
	USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON "multi_entity_similarity_score" TO cpa_app;
-- DELETE intentionally not granted: similarity scores are audit evidence;
-- reviewer dispositions flip state rather than removing rows.
REVOKE DELETE ON "multi_entity_similarity_score" FROM cpa_app;
--> statement-breakpoint

-- Per-activity-a lookup: "show all similarity flags for activity X"
CREATE INDEX "multi_entity_similarity_score_activity_a_idx" ON "multi_entity_similarity_score" USING btree ("tenant_id","activity_a_id");
--> statement-breakpoint

-- Per-activity-b lookup: "show all similarity flags where activity Y is
-- the comparator" (NULL-safe: NULLs won't appear in btree leaf pages).
CREATE INDEX "multi_entity_similarity_score_activity_b_idx" ON "multi_entity_similarity_score" USING btree ("tenant_id","activity_b_id");
--> statement-breakpoint

-- ============================================================
-- 4. r_and_d_facility — facility register for Form D.
-- ============================================================

CREATE TABLE "r_and_d_facility" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"subject_tenant_id" uuid NOT NULL,
	"fy_label" text NOT NULL,
	"facility_name" text NOT NULL,
	"address" text NOT NULL,
	"is_owned" boolean NOT NULL,
	"used_for_activity_ids" uuid[] NOT NULL,
	"first_recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "r_and_d_facility" ADD CONSTRAINT "r_and_d_facility_tenant_id_tenant_id_fk"
	FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "r_and_d_facility" ADD CONSTRAINT "r_and_d_facility_subject_tenant_id_subject_tenant_id_fk"
	FOREIGN KEY ("subject_tenant_id") REFERENCES "public"."subject_tenant"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "r_and_d_facility" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "r_and_d_facility" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "r_and_d_facility_tenant_isolation" ON "r_and_d_facility"
	USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON "r_and_d_facility" TO cpa_app;
-- DELETE intentionally not granted: facility records are compliance evidence
-- for Form D; corrections are made via UPDATEs, never hard deletes.
REVOKE DELETE ON "r_and_d_facility" FROM cpa_app;
--> statement-breakpoint

-- Per-subject per-FY lookup: "show all facilities for subject X in FY 2024-25"
CREATE INDEX "r_and_d_facility_subject_fy_idx" ON "r_and_d_facility" USING btree ("tenant_id","subject_tenant_id","fy_label");
--> statement-breakpoint

-- ============================================================
-- 5. rd_forecast — 3-year spend forecast (Form C / ATP).
-- ============================================================

CREATE TABLE "rd_forecast" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"subject_tenant_id" uuid NOT NULL,
	"base_fy_label" text NOT NULL,
	"forecast_year_offset" int NOT NULL,
	"projected_spend_aud" numeric(14,2) NOT NULL,
	"projected_headcount" int NOT NULL,
	"confidence" text NOT NULL,
	"first_recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rd_forecast_year_offset_valid" CHECK (
		"forecast_year_offset" IN (1,2,3)
	),
	CONSTRAINT "rd_forecast_confidence_valid" CHECK (
		"confidence" IN ('low','medium','high')
	),
	CONSTRAINT "rd_forecast_subject_fy_offset_uniq" UNIQUE ("subject_tenant_id","base_fy_label","forecast_year_offset")
);
--> statement-breakpoint

ALTER TABLE "rd_forecast" ADD CONSTRAINT "rd_forecast_tenant_id_tenant_id_fk"
	FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rd_forecast" ADD CONSTRAINT "rd_forecast_subject_tenant_id_subject_tenant_id_fk"
	FOREIGN KEY ("subject_tenant_id") REFERENCES "public"."subject_tenant"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "rd_forecast" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "rd_forecast" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "rd_forecast_tenant_isolation" ON "rd_forecast"
	USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON "rd_forecast" TO cpa_app;
-- DELETE intentionally not granted: forecast records are compliance evidence
-- for Form C / ATP; corrections are made via UPDATEs, never hard deletes.
REVOKE DELETE ON "rd_forecast" FROM cpa_app;
--> statement-breakpoint

-- Per-subject per-base-FY lookup: "show all forecasts for subject X from FY 2024-25"
CREATE INDEX "rd_forecast_subject_fy_idx" ON "rd_forecast" USING btree ("tenant_id","subject_tenant_id","base_fy_label");
