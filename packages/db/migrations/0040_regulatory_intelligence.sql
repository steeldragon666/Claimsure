-- P7 Theme D Task D.8 — Regulatory Intelligence Feed (RIF) tables.
--
-- Two tables:
--   1. regulatory_source — the feeds/sites we poll
--   2. regulatory_event — individual fetched items with optional classification
--
-- Design reference: docs/plans/2026-05-03-p7-design.md Section 4.5.3

--> statement-breakpoint

CREATE TABLE "regulatory_source" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"source_name" text NOT NULL UNIQUE,
	"source_url" text NOT NULL,
	"parser_kind" text NOT NULL,
	"fetch_interval_hours" integer NOT NULL DEFAULT 24,
	"last_polled_at" timestamptz,
	"last_polled_status" text,
	"enabled" boolean NOT NULL DEFAULT true,
	"first_recorded_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "regulatory_source_parser_kind_valid" CHECK (
		"parser_kind" IN ('rss','austlii_html','business_gov_au_html','isa_html','industry_rss')
	),
	CONSTRAINT "regulatory_source_last_polled_status_valid" CHECK (
		"last_polled_status" IS NULL OR "last_polled_status" IN ('success','rate_limited','parse_error','network_error')
	)
);

--> statement-breakpoint

CREATE TABLE "regulatory_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"source_id" uuid NOT NULL REFERENCES "regulatory_source"("id"),
	"external_id" text NOT NULL,
	"published_at" timestamptz NOT NULL,
	"fetched_at" timestamptz NOT NULL DEFAULT now(),
	"raw_url" text NOT NULL,
	"raw_title" text NOT NULL,
	"raw_content" text,
	"classification_kind" text,
	"classification_severity" text,
	"classification_payload" jsonb,
	"classified_at" timestamptz,
	"webhook_dispatched_at" timestamptz,
	"read_by_user_ids" uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
	"first_recorded_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "regulatory_event_source_external_uniq" UNIQUE ("source_id", "external_id"),
	CONSTRAINT "regulatory_event_classification_kind_valid" CHECK (
		"classification_kind" IS NULL OR "classification_kind" IN (
			'tax_alert','pcg','public_ruling','disr_program_change','form_change',
			'aat_decision','art_decision','isa_finding','industry_guidance',
			'asx_disclosure','other'
		)
	),
	CONSTRAINT "regulatory_event_classification_severity_valid" CHECK (
		"classification_severity" IS NULL OR "classification_severity" IN ('high','medium','low','informational')
	)
);

--> statement-breakpoint

-- Indexes for regulatory_event
CREATE INDEX "regulatory_event_source_published_idx" ON "regulatory_event" ("source_id", "published_at" DESC);
CREATE INDEX "regulatory_event_classification_kind_idx" ON "regulatory_event" ("classification_kind") WHERE "classification_kind" IS NOT NULL;
CREATE INDEX "regulatory_event_severity_idx" ON "regulatory_event" ("classification_severity") WHERE "classification_severity" IS NOT NULL;

--> statement-breakpoint

-- Seed regulatory_source rows (design Section 4.5.3)
INSERT INTO "regulatory_source" ("source_name", "source_url", "parser_kind") VALUES
	('ATO Legal Database', 'https://www.ato.gov.au/law/view/rss/pendingcontent.htm', 'rss'),
	('AustLII AAT R&DTI', 'https://www.austlii.edu.au/au/cases/cth/AATA/', 'austlii_html'),
	('AustLII ART R&DTI', 'https://www.austlii.edu.au/au/cases/cth/ART/', 'austlii_html'),
	('business.gov.au R&DTI', 'https://business.gov.au/grants-and-programs/research-and-development-tax-incentive', 'business_gov_au_html'),
	('ISA Findings', 'https://www.industry.gov.au/science-technology-and-innovation/research-and-development-tax-incentive', 'isa_html'),
	('RSM AU R&DTI', 'https://www.rsm.global/australia/insights/tax-insights/feed', 'industry_rss');

--> statement-breakpoint

-- Note: regulatory_source and regulatory_event are NOT RLS-protected.
-- They are shared across all tenants (global reference data).
-- Access control is at the application layer (consultant role only).
-- GRANT read to the app role.
GRANT SELECT, INSERT, UPDATE ON "regulatory_source" TO "cpa_app";
GRANT SELECT, INSERT, UPDATE ON "regulatory_event" TO "cpa_app";
REVOKE DELETE ON "regulatory_source" FROM "cpa_app";
REVOKE DELETE ON "regulatory_event" FROM "cpa_app";
