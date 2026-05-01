import {
  foreignKey,
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
import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import type { NarrativeSegment } from '@cpa/schemas';
import { narrativeDraft } from './narrative_draft.js';
import { tenant } from './tenant.js';
import { user } from './user.js';

/**
 * P6 Task 1.5 — narrative_draft_version (append-only history for Agent C).
 *
 * Per-version snapshot of one section of an activity's R&DTI narrative.
 * Every regeneration or consultant edit of a live `narrative_draft`
 * (Task 1.4) INSERTs one new row here, then bumps the parent's
 * `current_version`. THIS table is the immutable record; the live
 * mutable surface is `narrative_draft`.
 *
 * **Append-only**: enforced at the GRANT level — the migration grants
 * only `SELECT, INSERT` to `cpa_app` (NO UPDATE / DELETE). Mirrors
 * `audit_log` from migration 0022 (P5 keystone). Postgres has no
 * built-in "append-only table" mode; the GRANT discipline is the
 * structural enforcement.
 *
 * **Composite primary key**: `(tenant_id, id)`. Tenant-scoped tables
 * use a composite PK so RLS isolation is structural — even if a
 * privileged caller accidentally bypassed the policy, two firms
 * can't collide on the `id` half.
 *
 * **Per-version uniqueness**: `(tenant_id, draft_id, version)` is
 * unique. Version monotonicity is enforced at the application layer
 * (Task 5.5 bumps `narrative_draft.current_version` and INSERTs a
 * new row here with `version = current_version + 1`). The UNIQUE
 * constraint prevents duplicates structurally — a worker that
 * crashes mid-INSERT and retries with the same version will fail
 * loudly on the second attempt.
 *
 * **Composite FK to narrative_draft**: the parent's PK is
 * `(tenant_id, id)`, so the FK MUST reference both columns. A
 * single-column FK to `narrative_draft.id` alone would fail because
 * `id` is not unique on the parent without the `tenant_id` half. The
 * FK is hand-authored in `0030_narrative_draft_version.sql` because
 * drizzle's `.references()` only models single-column FKs; this
 * schema uses `foreignKey({ columns, foreignColumns })` to express
 * the composite reference for type-narrowing purposes (drizzle-kit
 * may serialize this differently than the migration; the migration
 * is the source of truth for the database state).
 *
 * **Lineage**: `parent_version` is nullable.
 *   - NULL on `generation_kind = 'initial'` rows (the first version
 *     has no parent).
 *   - Populated on `section_regen` and `edit` rows so the regen tree
 *     can be reconstructed.
 *
 * **`generation_kind`** is typed against a literal-union enum via
 * `text({ enum: ... })`. The matching CHECK constraint
 * (`narrative_draft_version_generation_kind_valid`) is hand-authored
 * in the migration because drizzle-kit can't reliably round-trip
 * CHECK constraints across regenerations.
 *
 * **`segments` is jsonb**, typed against the canonical
 * `NarrativeSegment` shape from `@cpa/schemas/event.ts` via
 * `$type<readonly NarrativeSegment[]>()`. Drizzle's column type is
 * `unknown` at runtime (jsonb is opaque to Postgres), but the
 * `$type` annotation gives TS narrowing on reads/writes through the
 * ORM. STRUCTURAL validation at write time is the API layer's job
 * (parse via the `NarrativeSegment` Zod schema before persisting);
 * SEMANTIC validation lives in Task 5.2's validate-and-correct loop.
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
 * **Composite FK with `ON DELETE CASCADE`** — when a parent draft is
 * deleted (e.g., via the activity ON DELETE CASCADE chain from
 * migration 0029), its version history goes too. Orphan version
 * rows have no audit value once the parent draft is gone.
 *
 * **Index rationale**: `narrative_draft_version_draft_idx` on
 * `(tenant_id, draft_id, version DESC)` powers "give me the latest
 * N versions of this draft" queries from the consultant review UI
 * without a sort step.
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
 * tenant / event / mapping_rule / narrative_draft precedent).
 */

/**
 * Single source of truth for narrative draft version generation_kind
 * classification.
 *
 * Mirrors the `narrative_draft_version_generation_kind_valid` CHECK
 * constraint in `0030_narrative_draft_version.sql`. Lifecycle:
 *   - `initial` — the first version of a draft. `parent_version` is
 *     NULL on these rows.
 *   - `section_regen` — Agent C regenerated this section
 *     (`parent_version` = the previous version's `version`).
 *   - `edit` — consultant edited the segments
 *     (`parent_version` = the previous version's `version`).
 *
 * Drift between this array and the SQL CHECK surfaces as a runtime
 * constraint violation on insert.
 */
export const NARRATIVE_DRAFT_VERSION_GENERATION_KINDS = [
  'initial',
  'section_regen',
  'edit',
] as const;
export type NarrativeDraftVersionGenerationKind =
  (typeof NARRATIVE_DRAFT_VERSION_GENERATION_KINDS)[number];

export const narrativeDraftVersion = pgTable(
  'narrative_draft_version',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    id: uuid('id')
      .notNull()
      .$defaultFn(() => crypto.randomUUID()),
    // Half of the composite FK to narrative_draft(tenant_id, id) —
    // the FK itself is declared at the table level via foreignKey()
    // below, since drizzle's `.references()` only models single-
    // column FKs. The migration hand-authors the matching ALTER TABLE
    // ADD CONSTRAINT for the composite reference + ON DELETE CASCADE.
    draftId: uuid('draft_id').notNull(),
    version: integer('version').notNull(),
    // jsonb list of NarrativeSegment shapes (prose | claim) for this
    // section snapshot; canonical Zod schema in @cpa/schemas/event.ts.
    segments: jsonb('segments').$type<readonly NarrativeSegment[]>().notNull(),
    contentHash: text('content_hash').notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    // Nullable: NULL on generation_kind='initial' rows (first version
    // has no parent); populated on section_regen / edit rows for
    // lineage reconstruction.
    parentVersion: integer('parent_version'),
    generationKind: text('generation_kind', {
      enum: NARRATIVE_DRAFT_VERSION_GENERATION_KINDS,
    }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => user.id),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.id] }),
    // Per-(draft, version) uniqueness: structural duplicate guard.
    // Worker retries that re-attempt the same version land here.
    draftVersionUnique: uniqueIndex('narrative_draft_version_draft_version_unique').on(
      t.tenantId,
      t.draftId,
      t.version,
    ),
    // "Latest N versions of draft X" scan index — supports the
    // consultant review UI without a sort step.
    draftIdx: index('narrative_draft_version_draft_idx').on(
      t.tenantId,
      t.draftId,
      t.version.desc(),
    ),
    // Composite FK to narrative_draft(tenant_id, id) — drizzle's
    // single-column `.references()` cannot express the composite
    // shape required by the parent's composite PK. ON DELETE CASCADE
    // is hand-authored in the migration.
    draftFk: foreignKey({
      columns: [t.tenantId, t.draftId],
      foreignColumns: [narrativeDraft.tenantId, narrativeDraft.id],
      name: 'narrative_draft_version_draft_fk',
    }).onDelete('cascade'),
  }),
);

/** Inferred row type for SELECT statements via drizzle. */
export type NarrativeDraftVersion = InferSelectModel<typeof narrativeDraftVersion>;

/** Inferred row type for INSERT statements via drizzle. */
export type NewNarrativeDraftVersion = InferInsertModel<typeof narrativeDraftVersion>;
