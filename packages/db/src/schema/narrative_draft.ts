import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import type { NarrativeSegment } from '@cpa/schemas';
import { activity } from './activity.js';
import { tenant } from './tenant.js';
import { user } from './user.js';

/**
 * P6 Task 1.4 — narrative_draft (Agent C storage).
 *
 * Live working copy of one section of an activity's R&DTI narrative.
 * Each activity has exactly four rows here (one per AusIndustry
 * submission narrative field per design doc Section 5):
 *   - new_knowledge
 *   - hypothesis
 *   - uncertainty
 *   - experiments_and_results
 *
 * The future Agent C streams `emit_segment` tool calls during draft
 * generation; the SDK persists each (activity_id, section_kind) pair
 * as one row here, with `segments` accumulating the validated
 * NarrativeSegment list (prose | claim shapes from
 * `@cpa/schemas/event.ts`). The append-only per-version snapshot
 * history lives in `narrative_draft_version` (Task 1.5, migration
 * 0030); THIS table is the live mutable surface and bumps
 * `current_version` on every regen / consultant edit.
 *
 * **Hash-chain anchor**: the `NARRATIVE_DRAFTED` chain event
 * (admitted by 0028) carries METADATA ONLY — `narrative_draft_id`
 * pointing here plus `content_hash` (lowercase hex sha256 of the
 * canonicalised segments). The auditor verifies storage integrity by
 * recomputing the hash from `segments` and comparing byte-for-byte
 * against the chain event; tampering with the live working copy
 * fails the comparison.
 *
 * **Composite primary key**: `(tenant_id, id)`. Tenant-scoped tables
 * use a composite PK so RLS isolation is structural — even if a
 * privileged caller accidentally bypassed the policy, two firms
 * can't collide on the `id` half (each `id` is a v4 UUID, but the
 * PK shape pins the "draft belongs to a tenant" invariant in the
 * schema).
 *
 * **Per-section uniqueness**: the `(tenant_id, activity_id, section_kind)`
 * unique constraint enforces "exactly one live draft per
 * (activity, section)". Regen mutates the existing row in place
 * (bumping `current_version` and overwriting `segments` /
 * `content_hash`); only the `narrative_draft_version` history
 * (Task 1.5) is append-only.
 *
 * **`segments` is jsonb**, typed against the canonical
 * `NarrativeSegment` shape from `@cpa/schemas/event.ts` via
 * `$type<readonly NarrativeSegment[]>()`. Drizzle's column type is
 * `unknown` at runtime (jsonb is opaque to Postgres), but the
 * `$type` annotation gives TS narrowing on reads/writes through the
 * ORM. STRUCTURAL validation at write time is the API layer's job
 * (parse via the `NarrativeSegment` Zod schema before persisting);
 * SEMANTIC validation (claim segments cite events inside the
 * activity's clustered_events set) lives in Task 5.2's
 * validate-and-correct loop.
 *
 * **`section_kind` and `status`** are typed against literal-union
 * enums via `text({ enum: ... })`. The matching CHECK constraints
 * (`narrative_draft_section_kind_valid`,
 * `narrative_draft_status_valid`) are hand-authored in
 * `0029_narrative_draft.sql` because drizzle-kit can't reliably
 * round-trip CHECK constraints across regenerations.
 *
 * **`current_version`** is monotonically increasing (1, 2, 3, …);
 * bumps on every regeneration (Task 5.6's per-section regen flow)
 * and on every consultant edit. The `narrative_draft_version` table
 * (Task 1.5) holds the full history indexed by
 * `(narrative_draft_id, version)`.
 *
 * **`status` lifecycle**: `streaming` (agent emitting segments) →
 * `complete` (all segments validated + persisted) → `accepted`
 * (consultant signed off) | `archived` (replaced by a regen). The
 * partial index `narrative_draft_status_idx WHERE status = 'streaming'`
 * speeds Task 5.7's stale-streaming-cleanup job (scans only
 * streaming rows, which is a transient state — most drafts move to
 * `complete` within seconds).
 *
 * **`idempotency_key`** is nullable. Populated on AI-emit paths so
 * retries across worker crashes are deduped at the persistence
 * layer; NULL on consultant-edit paths (no retry surface to dedupe).
 *
 * RLS-protected (migration hand-authors the policy):
 *   tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
 *
 * The NULLIF wrapper makes an unset GUC fail-safe to "deny
 * everything" rather than relying on the unsafe `''::uuid` coercion
 * (see 0003 commentary + 0022 audit_log keystone). FORCE ROW LEVEL
 * SECURITY is set even on owner-controlled tables, otherwise the
 * cpa role bypasses RLS.
 *
 * **Activity FK with `ON DELETE CASCADE`** — deleting an activity
 * cascade-deletes its narrative drafts. The activity_id FK is the
 * natural lifecycle anchor; orphan drafts have no audit value.
 *
 * **Layering note (mirrors mapping_rule.ts §"Layering"):** `@cpa/db`
 * imports the canonical `NarrativeSegment` type from `@cpa/schemas`
 * for the `segments` jsonb annotation. The Zod schema is the wire-
 * format SOT (used by the agent + API); the db column annotation
 * here is a derived narrowing helper. Drift between the two would
 * surface at the API boundary (Zod parse failure on a structurally
 * malformed segment), not as a CHECK violation here.
 *
 * Naming convention: camelCase TS / snake_case SQL (per existing
 * tenant / event / mapping_rule precedent).
 */

/**
 * Single source of truth for narrative section_kind classification.
 *
 * Mirrors the `narrative_draft_section_kind_valid` CHECK constraint
 * in `0029_narrative_draft.sql` and the `section_kind` enum in
 * `NarrativeDraftedPayload` (`@cpa/schemas/event.ts`). The Drizzle
 * column type uses `text({ enum: NARRATIVE_SECTION_KINDS })` to
 * narrow the TS type to this union, so any divergence between this
 * array and the SQL CHECK would surface as a runtime constraint
 * violation on insert/update.
 */
export const NARRATIVE_SECTION_KINDS = [
  'new_knowledge',
  'hypothesis',
  'uncertainty',
  'experiments_and_results',
] as const;
export type NarrativeSectionKind = (typeof NARRATIVE_SECTION_KINDS)[number];

/**
 * Single source of truth for narrative draft status lifecycle.
 *
 * Mirrors the `narrative_draft_status_valid` CHECK constraint in
 * `0029_narrative_draft.sql`. Lifecycle:
 *   - `streaming` — agent is mid-stream, segments still arriving.
 *   - `complete` — all segments validated + persisted; ready for
 *     consultant review.
 *   - `accepted` — consultant signed off on this section's draft.
 *   - `archived` — superseded by a regen or claim-level archive.
 *
 * Drift between this array and the SQL CHECK surfaces as a runtime
 * constraint violation on insert/update.
 */
export const NARRATIVE_DRAFT_STATUSES = ['streaming', 'complete', 'accepted', 'archived'] as const;
export type NarrativeDraftStatus = (typeof NARRATIVE_DRAFT_STATUSES)[number];

export const narrativeDraft = pgTable(
  'narrative_draft',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    id: uuid('id')
      .notNull()
      .$defaultFn(() => crypto.randomUUID()),
    // FK with ON DELETE CASCADE is hand-authored in the migration
    // (drizzle's `.references({ onDelete: 'cascade' })` on its own
    // doesn't emit the FORCE / RLS scaffolding the migration carries).
    activityId: uuid('activity_id')
      .notNull()
      .references(() => activity.id, { onDelete: 'cascade' }),
    sectionKind: text('section_kind', { enum: NARRATIVE_SECTION_KINDS }).notNull(),
    currentVersion: integer('current_version').notNull(),
    status: text('status', { enum: NARRATIVE_DRAFT_STATUSES }).notNull(),
    // jsonb list of NarrativeSegment shapes (prose | claim) for this
    // section; canonical Zod schema lives in @cpa/schemas/event.ts.
    segments: jsonb('segments').$type<readonly NarrativeSegment[]>().notNull(),
    contentHash: text('content_hash').notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    // Nullable: populated on AI-emit paths (retry dedup) only.
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => user.id),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.id] }),
    // Per-(activity, section) uniqueness: exactly one live draft per
    // (activity, section). Regen mutates in place; history lives in
    // narrative_draft_version (Task 1.5).
    activitySectionUnique: uniqueIndex('narrative_draft_activity_section_unique').on(
      t.tenantId,
      t.activityId,
      t.sectionKind,
    ),
    // Per-activity scan — powers "list all drafts for activity X" in
    // the consultant review UI.
    activityIdx: index('narrative_draft_activity_idx').on(t.tenantId, t.activityId),
    // Partial index for Task 5.7's stale-streaming-cleanup job —
    // declared with `.where()` so drizzle-kit serializes it as a
    // partial index. The matching SQL in the migration also uses
    // WHERE status = 'streaming'.
    statusIdx: index('narrative_draft_status_idx')
      .on(t.tenantId, t.status)
      .where(sql`${t.status} = 'streaming'`),
  }),
);

/** Inferred row type for SELECT statements via drizzle. */
export type NarrativeDraft = InferSelectModel<typeof narrativeDraft>;

/** Inferred row type for INSERT statements via drizzle. */
export type NewNarrativeDraft = InferInsertModel<typeof narrativeDraft>;
