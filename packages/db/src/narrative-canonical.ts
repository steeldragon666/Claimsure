import crypto from 'node:crypto';
import type { NarrativeSegment } from '@cpa/schemas';
import { canonicalJsonStringify } from './chain.js';
import { NARRATIVE_SECTION_KINDS, type NarrativeSectionKind } from './schema/narrative_draft.js';

/**
 * P6 Task 5.3 — content-hash canonicalisation for narrative drafts.
 *
 * The four-section narrative record (the full set of segments for an
 * activity, keyed by section_kind) is hashed into the `content_hash`
 * column on `narrative_draft` / `narrative_draft_version` and into
 * the `NARRATIVE_DRAFTED` chain event payload. The hash is the
 * audit-grade anchor that lets the verifier detect any tampering
 * with the persisted segments, so byte-stability across postgres
 * jsonb roundtrips and across the model's emit-order quirks is a
 * hard requirement.
 *
 * Canonicalisation rules (mirrors chain.ts's contract):
 *   1. Top-level keys (section_kind names) are sorted lex-ascending.
 *      `canonicalJsonStringify` handles this generically; the
 *      caller MAY pass keys in any order.
 *   2. Within each section, segments preserve their array-position
 *      order. The array index IS the segment_index by construction
 *      of the orchestrator (Task 5.1's prompt enforces dense, 0-based
 *      `segment_index` in emit order), so re-sorting would corrupt
 *      the audit drill-through. The canonicaliser is INTENTIONALLY
 *      not defensive against shuffled segments — that's a producer
 *      bug, not a hashing concern.
 *   3. Each `claim` segment's `citing_events` array is sorted
 *      lex-ascending before serialisation. `citing_events` is a SET
 *      (the auditor cares which events back the claim, not the
 *      order); sorting eliminates the false "draft changed" signal
 *      a citation reorder would otherwise produce.
 *   4. Per-segment object keys are sorted lex-ascending (handled by
 *      `canonicalJsonStringify`), matching the chain canonical-JSON
 *      contract.
 *   5. Non-finite numbers reject (inherited from
 *      `canonicalJsonStringify`).
 *
 * The helper does NOT mutate the caller's input — `citing_events`
 * arrays are sorted on a fresh copy.
 */

/** Full narrative-draft payload: one ordered segment list per section. */
export type NarrativeSections = Record<NarrativeSectionKind, readonly NarrativeSegment[]>;

/**
 * Returns the canonical JSON serialisation of a 4-section narrative
 * record. Byte-stable across postgres jsonb reorder, top-level key
 * reorder, and `citing_events` reorder. Used as the input to
 * `hashSections` and indirectly to the `narrative_draft.content_hash`
 * column / `NARRATIVE_DRAFTED` chain event.
 *
 * Does not mutate the caller's `sections`.
 */
export function canonicaliseSections(sections: NarrativeSections): string {
  // Build a fresh canonical record. We intentionally enumerate via
  // NARRATIVE_SECTION_KINDS rather than Object.keys(sections) so the
  // helper's behaviour is decoupled from the caller's enumeration
  // order AND so missing sections surface as `undefined` -> a clear
  // canonicaliseSections failure rather than a silent partial-record
  // hash. Callers must populate all four section_kinds (use [] for
  // empty sections).
  const canonical: Record<string, ReadonlyArray<NarrativeSegment>> = {};
  for (const sectionKind of NARRATIVE_SECTION_KINDS) {
    const segments = sections[sectionKind];
    if (segments === undefined) {
      throw new Error(
        `canonicaliseSections: missing section_kind "${sectionKind}" — ` +
          `caller must populate all four section_kinds (pass [] for empty sections)`,
      );
    }
    // Defensive: re-shape each segment so we copy citing_events into
    // a freshly-sorted array. We do NOT mutate the input arrays.
    canonical[sectionKind] = segments.map((segment) => {
      if (segment.type === 'claim') {
        return {
          type: segment.type,
          text: segment.text,
          // [...].sort() returns a new array; the original
          // `segment.citing_events` reference is untouched.
          citing_events: [...segment.citing_events].sort(),
        };
      }
      return { type: segment.type, text: segment.text };
    });
  }
  return canonicalJsonStringify(canonical);
}

/**
 * SHA-256 (lowercase hex, 64 chars) of `canonicaliseSections(sections)`.
 * Matches the `^[a-f0-9]{64}$` constraint on
 * `narrative_draft.content_hash` and the expected shape of the
 * `content_hash` field on `NARRATIVE_DRAFTED` payloads.
 */
export function hashSections(sections: NarrativeSections): string {
  return crypto.createHash('sha256').update(canonicaliseSections(sections), 'utf8').digest('hex');
}
