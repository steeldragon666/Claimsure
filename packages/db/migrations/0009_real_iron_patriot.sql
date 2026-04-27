-- DO NOT REGENERATE THIS MIGRATION VIA `pnpm --filter @cpa/db generate`.
-- The block at the bottom is hand-authored: RLS policy + GRANT to cpa_app.
-- drizzle-kit will silently regenerate this file and clobber them.
-- (No CHECK on encrypted token fields — they're opaque ciphertext.)

CREATE TABLE "integration_connection" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"access_token_encrypted" text NOT NULL,
	"refresh_token_encrypted" text,
	"expires_at" timestamp with time zone NOT NULL,
	"scopes" text[],
	"external_account_id" text,
	"last_synced_at" timestamp with time zone,
	"sync_state" text DEFAULT 'idle' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration_connection" ADD CONSTRAINT "integration_connection_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "integration_connection_tenant_provider_unique" ON "integration_connection" USING btree ("tenant_id","provider");
--> statement-breakpoint
-- ============================================================
-- RLS — same FORCE + USING + WITH CHECK pattern as 0002 / 0006 / 0008
-- (No CHECK on access_token_encrypted / refresh_token_encrypted — opaque.)
-- ============================================================

ALTER TABLE "integration_connection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integration_connection" FORCE ROW LEVEL SECURITY;
CREATE POLICY "integration_connection_tenant_isolation" ON "integration_connection"
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "integration_connection" TO cpa_app;