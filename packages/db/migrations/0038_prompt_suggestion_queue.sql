-- DO NOT REGENERATE THIS MIGRATION VIA `pnpm --filter @cpa/db generate`.
-- Hand-authored migration: prompt_suggestion + prompt_suggestion_review +
-- prompt_suggestion_pr tables with composite primary keys, jsonb columns,
-- RLS policies, four CHECK constraints, FK relationships, and per-table
-- btree indexes. drizzle-kit cannot fully express:
--   1. CHECK constraints (prompt_suggestion_source_kind_valid,
--      prompt_suggestion_status_valid, prompt_suggestion_triage_classification_valid,
--      prompt_suggestion_review_disposition_valid) — drizzle's check() helper
--      round-trips poorly and is omitted from the schema model on this
--      branch (existing pattern in 0006/0008/0010/0012/0013/0016/0018/0022/0029/0030).
--   2. The RLS / FORCE / policy block (same hand-authored pattern as
--      0016 / 0018 / 0022 / 0029 / 0030).
--   3. The COMPOSITE FKs from prompt_suggestion_review and prompt_suggestion_pr
--      to prompt_suggestion(tenant_id, id) — drizzle's `.references()` only
--      models single-column FKs.
--
-- ============================================================
-- P7 Theme B Task B.1 — prompt suggestion queue tables
-- ============================================================
-- The prompt-suggestion queue is the workflow surface where consultant flags,
-- RIF events, contract test failures, and reviewer dispositions accumulate as
-- candidates for prompt revisions. Each suggestion progresses through a
-- triage workflow (open → triaged → pr_drafted → pr_merged | dismissed) and
-- may produce one or more PRs against the prompt repository.
--
-- THREE TABLES:
--   1. prompt_suggestion         — the queue row itself (one per flag)
--   2. prompt_suggestion_review  — reviewer disposition events (1:N)
--   3. prompt_suggestion_pr      — GitHub PR records (1:N — re-PR after
--                                  rejected first attempt is supported)
--
-- FK ORDERING DECISION: the parent's `pr_id` column was DROPPED from the
-- design. The plan's design doc had bidirectional FKs (prompt_suggestion.pr_id
-- ↔ prompt_suggestion_pr.suggestion_id) but the bidirectional shape adds
-- forward-reference ordering pain (the SQL CREATE TABLE for prompt_suggestion
-- would reference prompt_suggestion_pr which doesn't exist yet) and offers no
-- expressiveness over a single FK from prompt_suggestion_pr.suggestion_id →
-- prompt_suggestion.id. The "many PRs per suggestion" semantic is more
-- flexible (a suggestion that gets re-PR'd after the first attempt is
-- rejected can have multiple prompt_suggestion_pr rows). Future code that
-- wants the "current PR for this suggestion" can do a `MAX(created_at)` /
-- `WHERE merged_at IS NOT NULL LIMIT 1` lookup.
--
-- TENANT ISOLATION: composite PK (tenant_id, id) on all three tables pins
-- isolation structurally — even if RLS were bypassed, the `id` half is a v4
-- UUID but the PK shape pins the "row belongs to a tenant" invariant in the
-- schema. RLS policy on each table uses the NULLIF-wrapped current_setting
-- pattern (see 0003 commentary + 0022 audit_log keystone) so an unset GUC
-- fails-safe to "deny everything". FORCE is required even on owner-controlled
-- tables, otherwise the cpa role bypasses RLS.
--
-- DENORMALIZED tenant_id ON CHILDREN: prompt_suggestion_review.tenant_id and
-- prompt_suggestion_pr.tenant_id are populated from the parent at insert
-- time. RLS policies on children filter by the child's own tenant_id,
-- avoiding subquery RLS (slower + more complex). The application layer
-- (Task B.2 / B.4 / B.6) is responsible for setting the child's tenant_id
-- to the parent's value; the composite FK to prompt_suggestion(tenant_id, id)
-- structurally enforces consistency (a child row whose tenant_id doesn't
-- match its parent's would fail the FK lookup).
--
-- CASCADE BEHAVIOUR: child tables use ON DELETE NO ACTION (the default).
-- Suggestions are intended to outlive their reviews / PRs as audit metadata;
-- if a suggestion is ever deleted, the children become orphans of metadata
-- records (the design intent — see retention policy in the P7 design doc).
-- In practice we expect suggestions to be `dismissed` rather than deleted.
--
-- IDEMPOTENCY: prompt_suggestion has no idempotency_key column — the
-- design doesn't model worker-retry dedup at this layer; the application
-- (Task B.2 ingest endpoint) is responsible for idempotency at the API
-- boundary.
--
-- INDEXES:
--   - prompt_suggestion (tenant_id, status)            — queue list query
--   - prompt_suggestion (tenant_id, source_kind)       — filter by source
--   - prompt_suggestion_pr (tenant_id, suggestion_id)  — child join
--   - prompt_suggestion_pr (github_pr_number)          — webhook lookup
-- ============================================================

-- ============================================================
-- 1. prompt_suggestion — the queue row itself.
-- ============================================================

CREATE TABLE "prompt_suggestion" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"flagged_by_user_id" uuid NOT NULL,
	"flagged_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- 'consultant_flag' | 'rif_event' | 'contract_test_failure' | 'reviewer_disposition'
	"source_kind" text NOT NULL,
	-- shape varies per source_kind; structural validation lives at the API layer (Task B.2)
	"source_payload" jsonb NOT NULL,
	"affected_prompt_module" text,
	"affected_section_kind" text,
	"issue_summary" text NOT NULL,
	-- 'open' | 'triaged' | 'pr_drafted' | 'pr_merged' | 'dismissed'
	"status" text DEFAULT 'open' NOT NULL,
	-- 'prompt_change' | 'schema_change' | 'code_change' | 'no_action_needed' (NULL until triaged)
	"triage_classification" text,
	"resolved_at" timestamp with time zone,
	"first_recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompt_suggestion_tenant_id_id_pk" PRIMARY KEY ("tenant_id","id"),
	CONSTRAINT "prompt_suggestion_source_kind_valid" CHECK (
		"source_kind" IN ('consultant_flag','rif_event','contract_test_failure','reviewer_disposition')
	),
	CONSTRAINT "prompt_suggestion_status_valid" CHECK (
		"status" IN ('open','triaged','pr_drafted','pr_merged','dismissed')
	),
	CONSTRAINT "prompt_suggestion_triage_classification_valid" CHECK (
		"triage_classification" IS NULL OR "triage_classification" IN (
			'prompt_change','schema_change','code_change','no_action_needed'
		)
	)
);
--> statement-breakpoint

ALTER TABLE "prompt_suggestion" ADD CONSTRAINT "prompt_suggestion_tenant_fk"
	FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "prompt_suggestion" ADD CONSTRAINT "prompt_suggestion_flagged_by_user_fk"
	FOREIGN KEY ("flagged_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "prompt_suggestion" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "prompt_suggestion" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "prompt_suggestion_tenant_isolation" ON "prompt_suggestion"
	USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON "prompt_suggestion" TO cpa_app;
-- DELETE intentionally not granted: suggestions are dismissed (status flip)
-- not removed; the row is the audit record of "we considered this".
REVOKE DELETE ON "prompt_suggestion" FROM cpa_app;
--> statement-breakpoint

-- Queue-list scan: "all open suggestions for tenant X" / "all
-- pr_drafted suggestions for tenant X". (tenant_id, status) lets the
-- planner satisfy the WHERE through an index scan.
CREATE INDEX "prompt_suggestion_status_idx" ON "prompt_suggestion" USING btree ("tenant_id","status");
--> statement-breakpoint

-- Source-filter scan: "show me all rif_event suggestions for tenant X"
-- in the triage UI.
CREATE INDEX "prompt_suggestion_source_kind_idx" ON "prompt_suggestion" USING btree ("tenant_id","source_kind");
--> statement-breakpoint

-- ============================================================
-- 2. prompt_suggestion_review — reviewer disposition events (1:N).
-- ============================================================

CREATE TABLE "prompt_suggestion_review" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"suggestion_id" uuid NOT NULL,
	"reviewer_user_id" uuid NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- 'approve_for_pr' | 'request_more_info' | 'dismiss' | 'escalate_to_code_change'
	"disposition" text NOT NULL,
	"notes" text,
	CONSTRAINT "prompt_suggestion_review_tenant_id_id_pk" PRIMARY KEY ("tenant_id","id"),
	CONSTRAINT "prompt_suggestion_review_disposition_valid" CHECK (
		"disposition" IN ('approve_for_pr','request_more_info','dismiss','escalate_to_code_change')
	)
);
--> statement-breakpoint

-- Composite FK to prompt_suggestion(tenant_id, id). The parent's PK is
-- composite, so a single-column FK to prompt_suggestion.id alone would
-- fail (id is not unique on the parent without the tenant_id half).
-- ON DELETE NO ACTION — reviews outlive their parent suggestions as
-- audit metadata; deleting a suggestion is not expected (dismissal flips
-- status instead).
ALTER TABLE "prompt_suggestion_review" ADD CONSTRAINT "prompt_suggestion_review_suggestion_fk"
	FOREIGN KEY ("tenant_id","suggestion_id") REFERENCES "public"."prompt_suggestion"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "prompt_suggestion_review" ADD CONSTRAINT "prompt_suggestion_review_reviewer_user_fk"
	FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "prompt_suggestion_review" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "prompt_suggestion_review" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "prompt_suggestion_review_tenant_isolation" ON "prompt_suggestion_review"
	USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
--> statement-breakpoint

GRANT SELECT, INSERT ON "prompt_suggestion_review" TO cpa_app;
-- Append-only: review events are an audit trail. Reviewers cannot edit
-- prior dispositions; a "change of mind" is a NEW review row.
REVOKE UPDATE, DELETE ON "prompt_suggestion_review" FROM cpa_app;
--> statement-breakpoint

-- Per-suggestion scan — "give me all reviews for suggestion X" in the
-- triage UI's review history panel.
CREATE INDEX "prompt_suggestion_review_suggestion_idx" ON "prompt_suggestion_review" USING btree ("tenant_id","suggestion_id");
--> statement-breakpoint

-- ============================================================
-- 3. prompt_suggestion_pr — GitHub PR records (1:N).
-- ============================================================

CREATE TABLE "prompt_suggestion_pr" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"suggestion_id" uuid NOT NULL,
	"github_pr_number" integer NOT NULL,
	"github_pr_url" text NOT NULL,
	"branch_name" text NOT NULL,
	-- list of file paths changed in the PR; canonical Zod schema lives
	-- with Task B.6's PR-drafter implementation.
	"changed_files" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"merged_at" timestamp with time zone,
	"merge_commit_sha" text,
	CONSTRAINT "prompt_suggestion_pr_tenant_id_id_pk" PRIMARY KEY ("tenant_id","id")
);
--> statement-breakpoint

-- Composite FK to prompt_suggestion(tenant_id, id). Same composite-PK
-- constraint discipline as prompt_suggestion_review above.
-- ON DELETE NO ACTION — PR records outlive their parent suggestions as
-- audit metadata.
ALTER TABLE "prompt_suggestion_pr" ADD CONSTRAINT "prompt_suggestion_pr_suggestion_fk"
	FOREIGN KEY ("tenant_id","suggestion_id") REFERENCES "public"."prompt_suggestion"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "prompt_suggestion_pr" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "prompt_suggestion_pr" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "prompt_suggestion_pr_tenant_isolation" ON "prompt_suggestion_pr"
	USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
--> statement-breakpoint

-- UPDATE is granted because merge bookkeeping (merged_at, merge_commit_sha)
-- happens after the PR row is first inserted (Task B.6 webhook handler).
GRANT SELECT, INSERT, UPDATE ON "prompt_suggestion_pr" TO cpa_app;
REVOKE DELETE ON "prompt_suggestion_pr" FROM cpa_app;
--> statement-breakpoint

-- Per-suggestion scan — "give me all PRs (current + retried) for
-- suggestion X" in the triage UI.
CREATE INDEX "prompt_suggestion_pr_suggestion_idx" ON "prompt_suggestion_pr" USING btree ("tenant_id","suggestion_id");
--> statement-breakpoint

-- Webhook lookup — "find the row for incoming PR number N" when the
-- GitHub merge webhook fires. PR numbers are globally unique on the
-- prompt repo, so the index doesn't need tenant_id leading.
CREATE INDEX "prompt_suggestion_pr_github_pr_number_idx" ON "prompt_suggestion_pr" USING btree ("github_pr_number");
