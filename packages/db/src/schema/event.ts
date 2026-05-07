import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { subjectTenant } from './subject_tenant.js';
import { subjectTenantEmployee } from './subject_tenant_employee.js';
import { tenant } from './tenant.js';
import { user } from './user.js';

/**
 * Append-only, hash-chained evidence event per `subject_tenant`.
 *
 * The 13 kinds split 12 classifiable evidence categories + a special
 * `OVERRIDE` kind that supersedes a prior event's classification. Override
 * events carry `override_of_event_id` (self-reference, enforced in code —
 * Drizzle self-FKs are awkward) plus optional `override_new_kind` /
 * `override_reason` describing the reclassification.
 *
 * Hash chain: each event's `prev_hash` links to the previous event's `hash`
 * within the same subject_tenant_id (ordered by captured_at). The first
 * event has `prev_hash = NULL`. The chain is verified during the Assurance
 * Report (P5) build.
 *
 * Idempotency: `idempotency_key` is a hex SHA-256 fingerprint of the paste
 * payload; identical paste requests dedupe to the same row. Nullable for
 * OVERRIDE events (which carry no idempotency-relevant payload), so the
 * uniqueness constraint is a partial index `WHERE idempotency_key IS NOT
 * NULL`.
 *
 * Forward compatibility: `project_id` and `milestone_id` are nullable
 * uuid columns without FKs — the target tables arrive in P4 (project) and
 * P7 (milestone). FKs will be added then.
 *
 * RLS-protected (Task 3 hand-authors the policy in this same migration):
 *   tenant_id = current_setting('app.current_tenant_id', true)::uuid
 *
 * APPEND-ONLY: no deletedAt column. Errors are corrected via OVERRIDE
 * events, never deletes — preserving the audit chain.
 *
 * Naming convention: camelCase TS / snake_case SQL (per T5/T6 chain
 * 2aa8e18 → 1149b17). Imports alphabetical (per T6 precedent).
 */

/**
 * Single source of truth for event evidence kinds.
 *
 * Keep in sync with the `event_kind_valid` CHECK constraint in
 * `migrations/0006_fair_network.sql` (initial 13 kinds),
 * `migrations/0014_p4_evidence_kinds.sql` (14 P4 state-transition kinds),
 * and `migrations/0015_project_updated_kind.sql` (PROJECT_UPDATED, added
 * in T-A1). The Drizzle column type uses `text({ enum: EVIDENCE_KINDS })`
 * to narrow the TS type to this union, so any divergence between this
 * array and the SQL CHECK would surface as a runtime constraint
 * violation on insert/update.
 *
 * The first 13 entries (HYPOTHESIS through OVERRIDE) are R&D evidence
 * classifications and can be re-classified via OVERRIDE events. The 15
 * P4 entries below are state-transition events (entity created, claim
 * advanced, etc.) and cannot be re-classified — see the
 * `event_override_new_kind_valid` CHECK in 0006 for the override-eligible
 * subset (which is unchanged from 0006).
 *
 * Consumers across the workspace (API routes, web components, agents)
 * should import from this file rather than redeclare the list — duplicated
 * literal arrays drift silently and cannot be caught by the type checker.
 */
export const EVIDENCE_KINDS = [
  'HYPOTHESIS',
  'DESIGN',
  'EXPERIMENT',
  'OBSERVATION',
  'ITERATION',
  'NEW_KNOWLEDGE',
  'UNCERTAINTY',
  'TIME_LOG',
  'ASSOCIATE_FLAG',
  'EXPENDITURE_NOTE',
  'SUPPORTING',
  'INELIGIBLE',
  'OVERRIDE',
  // P4 state-transition events (must match 0014_p4_evidence_kinds.sql)
  'ACTIVITY_CREATED',
  'ACTIVITY_UPDATED',
  'ACTIVITY_LOCKED',
  'ARTEFACT_LINKED',
  'ARTEFACT_UNLINKED',
  'EXPENDITURE_INGESTED',
  'EXPENDITURE_LINE_MAPPED',
  'EXPENDITURE_LINE_UNMAPPED',
  'EXPENDITURE_VOIDED',
  'CLAIM_STAGE_ADVANCED',
  'CLAIM_SUBMITTED',
  'PROJECT_CREATED',
  'PROJECT_ARCHIVED',
  'DOCUMENT_GENERATED',
  // Added in T-A1 (0015_project_updated_kind.sql) — emitted by
  // PATCH /v1/projects/:id. Mirrors the ACTIVITY_UPDATED pattern so we
  // don't reuse the misleading PROJECT_CREATED kind for partial updates.
  'PROJECT_UPDATED',
  // P5 Theme 2 Task 2.2 — the three MAPPING_RULE_* kinds were briefly
  // listed here (B9 added them in 0018_mapping_rule.sql for a future
  // audit surface) but have moved to AUDIT_KINDS in
  // `@cpa/db/schema/audit_log.ts` and the new `audit_log` table.
  // 0023_remove_mapping_rule_from_event_kinds.sql rebuilds
  // `event_kind_valid` to EXCLUDE the three values; this list tracks
  // the CHECK byte-for-byte.
  // P5 Theme 5 Task 5.1 — emitted by
  // POST /v1/expenditures/:id/apply-rules (and the batch
  // /v1/claims/:id/apply-rules) when a mapping rule's action type
  // resolves to `map_to_activity`. The `event_kind_valid` CHECK is
  // rebuilt to admit it by 0024_expenditure_mapped_kind.sql; this
  // list tracks the CHECK byte-for-byte.
  'EXPENDITURE_MAPPED',
  // P5 Theme 5 Task 5.2 — emitted by the apply-rules endpoint when a
  // mapping rule's action type resolves to `apportion`. The
  // `event_kind_valid` CHECK is rebuilt to admit it by
  // 0025_expenditure_apportioned_kind.sql; this list tracks the
  // CHECK byte-for-byte.
  'EXPENDITURE_APPORTIONED',
  // P6 Task 1.1 — emitted by the future Agent A eligibility
  // classifier; binds an expenditure to an
  // `eligible | ineligible | needs_review` decision plus statutory
  // anchor (Division 355 §355-25 / §355-30). The
  // `event_kind_valid` CHECK is rebuilt to admit it by
  // 0026_expenditure_classified_kind.sql; this list tracks the
  // CHECK byte-for-byte.
  'EXPENDITURE_CLASSIFIED',
  // P6 Task 1.2 — emitted by the future Agent B activity-register
  // synthesizer; once per draft pass, proposes a clustered set of
  // candidate activities (each with a statutory anchor under
  // Division 355 §355-25 core / §355-30 supporting) drawn from the
  // raw evidence stream and the unclustered tail of event ids that
  // didn't fit any cluster. The `event_kind_valid` CHECK is rebuilt
  // to admit it by 0027_activity_register_drafted_kind.sql; this
  // list tracks the CHECK byte-for-byte.
  'ACTIVITY_REGISTER_DRAFTED',
  // P6 Task 1.3 — emitted by the future Agent C streaming narrative
  // drafter; one event per persisted narrative-section draft (one
  // (activity_id, section_kind, version) tuple per emit). Carries
  // metadata only — `narrative_draft_id` + `content_hash` (lowercase
  // hex sha256 of the canonicalised segments) + segment counts;
  // the actual segments live in the `narrative_draft` table created
  // by migration 0029 (and the append-only `narrative_draft_version`
  // history in 0030). Auditor verifies storage integrity by
  // recomputing the hash from persisted segments and comparing
  // against this chain event. The `event_kind_valid` CHECK is
  // rebuilt to admit it by 0028_narrative_drafted_kind.sql; this
  // list tracks the CHECK byte-for-byte.
  'NARRATIVE_DRAFTED',
  // P9 Phase 3 Task 3.4 — emitted by the federation audit hook when a
  // financier partner reads data via a federation_share. One event per
  // federated read response. The `event_kind_valid` CHECK is rebuilt
  // to admit it by 0072_federation_read_event_kind.sql; this list
  // tracks the CHECK byte-for-byte.
  'FEDERATION_READ',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const event = pgTable(
  'event',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    subjectTenantId: uuid('subject_tenant_id')
      .notNull()
      .references(() => subjectTenant.id),
    // Nullable; FK target arrives in P4 (project table).
    projectId: uuid('project_id'),
    // Nullable; FK target arrives in P7 (milestone table).
    milestoneId: uuid('milestone_id'),
    kind: text('kind', { enum: EVIDENCE_KINDS }).notNull(),
    payload: jsonb('payload').notNull(),
    classification: jsonb('classification'),
    // Self-FK omitted intentionally — Drizzle self-references are awkward;
    // enforce in code (event chain helper, lands in T-chain).
    overrideOfEventId: uuid('override_of_event_id'),
    overrideNewKind: text('override_new_kind', { enum: EVIDENCE_KINDS }),
    overrideReason: text('override_reason'),
    // hex SHA-256; null for the first event in a subject_tenant chain.
    prevHash: text('prev_hash'),
    // hex SHA-256; globally unique (chain integrity guarantee).
    hash: text('hash').notNull().unique(),
    // hex SHA-256 fingerprint; null for OVERRIDE events. Partial unique
    // index below enforces dedupe WHERE NOT NULL.
    idempotencyKey: text('idempotency_key'),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    // Captured by EITHER a consultant `user` (firm-side) OR a claimant-side
    // `subject_tenant_employee` (mobile flow) — never both. Migration 0011
    // adds a CHECK constraint enforcing exactly one is set. The chain hash
    // canonicaliser conditionally includes captured_by_employee_id only
    // when non-null so existing P2 events (employee_id always null) keep
    // their original hashes and pass verifyChain.
    capturedByUserId: uuid('captured_by_user_id').references(() => user.id),
    capturedByEmployeeId: uuid('captured_by_employee_id').references(
      () => subjectTenantEmployee.id,
    ),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    feedIdx: index('event_feed_idx').on(t.subjectTenantId, t.capturedAt.desc()),
    kindIdx: index('event_kind_idx').on(t.subjectTenantId, t.kind),
    overrideIdx: index('event_override_idx').on(t.overrideOfEventId),
    idempotencyUnique: uniqueIndex('event_idempotency_unique')
      .on(t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
  }),
);
