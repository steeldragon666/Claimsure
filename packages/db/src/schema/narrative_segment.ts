import {
  foreignKey,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { narrativeDraft } from './narrative_draft.js';

/**
 * P7 Theme A Task A.1 — narrative_segment table.
 *
 * Per-segment relational projection of `narrative_draft.segments` jsonb.
 * Each row corresponds to one element of the parent draft's NarrativeSegment
 * list (prose | claim shapes from `@cpa/schemas/event.ts`). The parent
 * `narrative_draft.segments` jsonb column is preserved for backward-compat
 * read paths (Q-Fix1=A locked decision) — this table is the canonical
 * relational surface for Theme A's multi-cycle audit timeline queries.
 *
 * **Field naming (Q-Extra1=A locked decision)**: column names match the
 * canonical `NarrativeSegment` shape in `packages/schemas/src/event.ts`:
 *   `type` (not `segment_kind`) — discriminator: 'prose' | 'claim'
 *   `text` (not `body`) — segment text content
 *   `citing_events` — uuid[] of cited event IDs (always populated; empty
 *     array for prose segments)
 *
 * **section_kind** is denormalised from the parent `narrative_draft` row
 * (the parent has the section, segments inherit it). Stored here as plain
 * text — the CHECK constraint lives on `narrative_draft.section_kind`,
 * not on this table (the parent FK enforces the lineage).
 *
 * **content_hash** is per-segment (md5 of `text` at backfill time). Distinct
 * from `narrative_draft.content_hash` which spans the whole segment list.
 *
 * **first_recorded_at** preserves the original first-seen timestamp; the
 * audit timeline view orders by this (NOT by row creation time, which
 * would be the same for all rows in a single backfill batch).
 *
 * **Composite FK**: `(narrative_draft_tenant_id, narrative_draft_id)`
 * references `narrative_draft(tenant_id, id)`. The parent's PK is
 * composite (tenant_id + id), so the FK MUST match both columns —
 * single-column FK to `narrative_draft.id` would fail (no unique key
 * on `id` alone). Same pattern as `narrative_draft_version`. ON DELETE
 * CASCADE drops segment rows when the parent draft is deleted.
 *
 * **Tenant filter via JOIN**: this table is NOT directly RLS-protected;
 * it inherits tenant scope from the parent narrative_draft row through
 * the CASCADE FK. Queries that need tenant filtering should JOIN to
 * narrative_draft and filter on its tenant_id (P7 Theme A application
 * code does this).
 *
 * Naming convention: camelCase TS / snake_case SQL.
 */

export const NARRATIVE_SEGMENT_TYPES = ['prose', 'claim'] as const;
export type NarrativeSegmentType = (typeof NARRATIVE_SEGMENT_TYPES)[number];

export const narrativeSegment = pgTable(
  'narrative_segment',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    // Half of the composite FK to narrative_draft(tenant_id, id). The
    // parent's PK is composite, so the FK MUST reference both columns.
    // Same pattern as narrative_draft_version. The FK itself is
    // declared at the table level via foreignKey() below.
    narrativeDraftTenantId: uuid('narrative_draft_tenant_id').notNull(),
    narrativeDraftId: uuid('narrative_draft_id').notNull(),
    segmentIndex: integer('segment_index').notNull(),
    sectionKind: text('section_kind').notNull(),
    type: text('type', { enum: NARRATIVE_SEGMENT_TYPES }).notNull(),
    text: text('text').notNull(),
    citingEvents: uuid('citing_events')
      .array()
      .notNull()
      .default(sql`ARRAY[]::uuid[]`),
    contentHash: text('content_hash').notNull(),
    firstRecordedAt: timestamp('first_recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // The UNIQUE (narrative_draft_id, segment_index) constraint already
    // creates a backing B-tree index over those columns, so a separate
    // non-unique index would be redundant. Lookups by narrative_draft_id
    // alone (or with segment_index) use the unique index.
    draftIndexUnique: uniqueIndex('narrative_segment_narrative_draft_id_segment_index_key').on(
      t.narrativeDraftId,
      t.segmentIndex,
    ),
    // Composite FK to narrative_draft(tenant_id, id) — drizzle's
    // single-column `.references()` cannot express the composite shape.
    // ON DELETE CASCADE: dropping a draft drops its segment rows.
    draftFk: foreignKey({
      columns: [t.narrativeDraftTenantId, t.narrativeDraftId],
      foreignColumns: [narrativeDraft.tenantId, narrativeDraft.id],
      name: 'narrative_segment_draft_fk',
    }).onDelete('cascade'),
  }),
);

/**
 * Inferred row type for SELECT statements via drizzle.
 *
 * NOTE: named `NarrativeSegmentRow` (not `NarrativeSegment`) to avoid a
 * collision with the canonical `NarrativeSegment` Zod type exported from
 * `@cpa/schemas/event.ts` (the wire-format SOT for the prose|claim
 * discriminated union). The Drizzle row type is a derived narrowing
 * helper for ORM consumers; the Zod type is the source of truth for
 * shape validation.
 */
export type NarrativeSegmentRow = InferSelectModel<typeof narrativeSegment>;

/** Inferred row type for INSERT statements via drizzle. */
export type NewNarrativeSegmentRow = InferInsertModel<typeof narrativeSegment>;
