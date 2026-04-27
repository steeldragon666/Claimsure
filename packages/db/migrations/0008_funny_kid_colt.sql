-- DO NOT REGENERATE THIS MIGRATION VIA `pnpm --filter @cpa/db generate`.
-- The block at the bottom is hand-authored: 7 CHECK constraints, 5 RLS policies,
-- and GRANTs to cpa_app. drizzle-kit will silently regenerate this file and
-- clobber them. If you need to change a P3 table's shape, write a new migration.

CREATE TABLE "brand_config" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"logo_s3_key" text,
	"primary_color" text DEFAULT '#0066cc' NOT NULL,
	"accent_color" text DEFAULT '#00a86b' NOT NULL,
	"email_sender_domain" text,
	"email_sender_dkim_status" text DEFAULT 'unconfigured' NOT NULL,
	"support_email" text,
	"terms_of_service_url" text,
	"custom_subdomain" text,
	"custom_domain" text,
	"custom_domain_acm_arn" text,
	"custom_domain_status" text DEFAULT 'unconfigured' NOT NULL,
	"landing_page_config" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brand_config_custom_subdomain_unique" UNIQUE("custom_subdomain"),
	CONSTRAINT "brand_config_custom_domain_unique" UNIQUE("custom_domain")
);
--> statement-breakpoint
CREATE TABLE "magic_link_token" (
	"id" uuid PRIMARY KEY NOT NULL,
	"employee_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "magic_link_token_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "media_artefact" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_tenant_id" uuid NOT NULL,
	"event_id" uuid,
	"uploaded_by_employee_id" uuid NOT NULL,
	"s3_key" text NOT NULL,
	"content_hash" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"exif" jsonb,
	"ocr_text" text,
	"ocr_status" text DEFAULT 'pending' NOT NULL,
	"virus_scan_status" text DEFAULT 'pending' NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mobile_session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"employee_id" uuid NOT NULL,
	"device_fingerprint" text NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_refreshed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"push_token" text
);
--> statement-breakpoint
CREATE TABLE "signing_request" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_tenant_id" uuid NOT NULL,
	"initiated_by_user_id" uuid NOT NULL,
	"recipient_employee_id" uuid,
	"recipient_email" text NOT NULL,
	"document_kind" text NOT NULL,
	"document_template_id" text,
	"docusign_envelope_id" text NOT NULL,
	"status" text DEFAULT 'sent' NOT NULL,
	"signed_at" timestamp with time zone,
	"signed_pdf_s3_key" text,
	"signed_pdf_content_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signing_request_docusign_envelope_id_unique" UNIQUE("docusign_envelope_id")
);
--> statement-breakpoint
CREATE TABLE "subject_tenant_employee" (
	"id" uuid PRIMARY KEY NOT NULL,
	"subject_tenant_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"job_title" text,
	"payroll_external_id" text,
	"payroll_provider" text,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invited_by_user_id" uuid NOT NULL,
	"first_seen_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"deactivated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "time_entry" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"source" text NOT NULL,
	"external_id" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"duration_minutes" integer NOT NULL,
	"is_rd" boolean DEFAULT true NOT NULL,
	"apportionment_pct" numeric(5, 2),
	"apportioned_by_user_id" uuid,
	"apportioned_at" timestamp with time zone,
	"notes" text,
	"flagged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "brand_config" ADD CONSTRAINT "brand_config_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "magic_link_token" ADD CONSTRAINT "magic_link_token_employee_id_subject_tenant_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."subject_tenant_employee"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_artefact" ADD CONSTRAINT "media_artefact_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_artefact" ADD CONSTRAINT "media_artefact_subject_tenant_id_subject_tenant_id_fk" FOREIGN KEY ("subject_tenant_id") REFERENCES "public"."subject_tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_artefact" ADD CONSTRAINT "media_artefact_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_artefact" ADD CONSTRAINT "media_artefact_uploaded_by_employee_id_subject_tenant_employee_id_fk" FOREIGN KEY ("uploaded_by_employee_id") REFERENCES "public"."subject_tenant_employee"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mobile_session" ADD CONSTRAINT "mobile_session_employee_id_subject_tenant_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."subject_tenant_employee"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signing_request" ADD CONSTRAINT "signing_request_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signing_request" ADD CONSTRAINT "signing_request_subject_tenant_id_subject_tenant_id_fk" FOREIGN KEY ("subject_tenant_id") REFERENCES "public"."subject_tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signing_request" ADD CONSTRAINT "signing_request_initiated_by_user_id_user_id_fk" FOREIGN KEY ("initiated_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signing_request" ADD CONSTRAINT "signing_request_recipient_employee_id_subject_tenant_employee_id_fk" FOREIGN KEY ("recipient_employee_id") REFERENCES "public"."subject_tenant_employee"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_tenant_employee" ADD CONSTRAINT "subject_tenant_employee_subject_tenant_id_subject_tenant_id_fk" FOREIGN KEY ("subject_tenant_id") REFERENCES "public"."subject_tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_tenant_employee" ADD CONSTRAINT "subject_tenant_employee_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_tenant_employee" ADD CONSTRAINT "subject_tenant_employee_invited_by_user_id_user_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_subject_tenant_id_subject_tenant_id_fk" FOREIGN KEY ("subject_tenant_id") REFERENCES "public"."subject_tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_employee_id_subject_tenant_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."subject_tenant_employee"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_apportioned_by_user_id_user_id_fk" FOREIGN KEY ("apportioned_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "media_artefact_content_dedupe_unique" ON "media_artefact" USING btree ("tenant_id","subject_tenant_id","content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "subject_tenant_employee_active_email_unique" ON "subject_tenant_employee" USING btree ("subject_tenant_id","email") WHERE "subject_tenant_employee"."deactivated_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "time_entry_payroll_source_dedupe_unique" ON "time_entry" USING btree ("source","external_id") WHERE "time_entry"."external_id" IS NOT NULL;
--> statement-breakpoint
-- ============================================================
-- DB-level CHECK constraints
-- ============================================================

ALTER TABLE "subject_tenant_employee" ADD CONSTRAINT employee_email_format
  CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');

ALTER TABLE "magic_link_token" ADD CONSTRAINT magic_link_token_hash_format
  CHECK (token_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE "mobile_session" ADD CONSTRAINT mobile_session_refresh_hash_format
  CHECK (refresh_token_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE "media_artefact" ADD CONSTRAINT media_content_hash_format
  CHECK (content_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE "time_entry" ADD CONSTRAINT time_entry_apportionment_range
  CHECK (apportionment_pct IS NULL OR (apportionment_pct >= 0 AND apportionment_pct <= 100));

ALTER TABLE "time_entry" ADD CONSTRAINT time_entry_duration_positive
  CHECK (duration_minutes > 0 AND ended_at > started_at);

ALTER TABLE "brand_config" ADD CONSTRAINT brand_config_color_format
  CHECK (primary_color ~ '^#[0-9a-fA-F]{6}$' AND accent_color ~ '^#[0-9a-fA-F]{6}$');

--> statement-breakpoint
-- ============================================================
-- RLS — same FORCE + USING + WITH CHECK pattern as 0002 / 0006
-- magic_link_token NOT RLS (lookup by hash before tenant context)
-- mobile_session NOT directly RLS (accessed via employee_id which IS RLS)
-- ============================================================

ALTER TABLE "subject_tenant_employee" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "subject_tenant_employee" FORCE ROW LEVEL SECURITY;
CREATE POLICY "employee_tenant_isolation" ON "subject_tenant_employee"
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE "media_artefact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "media_artefact" FORCE ROW LEVEL SECURITY;
CREATE POLICY "media_artefact_tenant_isolation" ON "media_artefact"
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE "time_entry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "time_entry" FORCE ROW LEVEL SECURITY;
CREATE POLICY "time_entry_tenant_isolation" ON "time_entry"
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE "signing_request" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "signing_request" FORCE ROW LEVEL SECURITY;
CREATE POLICY "signing_request_tenant_isolation" ON "signing_request"
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE "brand_config" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "brand_config" FORCE ROW LEVEL SECURITY;
CREATE POLICY "brand_config_tenant_isolation" ON "brand_config"
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "subject_tenant_employee" TO cpa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "magic_link_token" TO cpa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "mobile_session" TO cpa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "media_artefact" TO cpa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "time_entry" TO cpa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "signing_request" TO cpa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "brand_config" TO cpa_app;