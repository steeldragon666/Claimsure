import type { NarrativeSegment } from '@cpa/schemas';
import { EventCitation, type EventCitationEvent } from './EventCitation.js';

/**
 * Web-side renderer for the narrative drafts produced by Agent C
 * (Task 5.x). Implements the §5 UI rendering contract from the
 * design doc: superscript footnote markers per claim segment, an
 * "Evidence" ledger at the foot of each section listing the cited
 * events.
 *
 * Two layers, deliberately separated so the pure logic is testable
 * under apps/web's `tsx --test` Node-only runner (no jsdom, no
 * @testing-library/react — see `pipeline-kanban.test.tsx` for the
 * established pattern):
 *
 *   1. **Pure helpers** (`buildFootnoteMap`, `markersForSegment`)
 *      compute the citation → footnote-number mapping and produce
 *      a renderable description of which markers go on which
 *      segment. Exported and unit-tested directly.
 *   2. **React component** (`RenderNarrative`) consumes the helpers
 *      and emits the JSX tree. Exercised end-to-end via Playwright
 *      in a later swimlane.
 *
 * SECTION_KINDS is duplicated locally rather than imported from
 * `@cpa/agents/narrative-drafter/types` because apps/web does not
 * depend on the agents package (and shouldn't — agents runs in the
 * worker process, not in the Next.js server). The literal tuple is
 * the same one declared in `narrative_draft_section_kind_valid` and
 * `NarrativeDraftedPayload.section_kind`; if either drifts, the
 * narrative-section-kind grep + the `SectionKind` discriminator on
 * `NarrativeSections` will surface the mismatch at typecheck time.
 */

/** AusIndustry submission narrative section kinds, in canonical render order. */
export const SECTION_KINDS = [
  'new_knowledge',
  'hypothesis',
  'uncertainty',
  'experiments_and_results',
] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

/**
 * Human-readable section headings. Kept on the web side rather than
 * in the agents package because the agent emits machine-readable
 * `section_kind` values; the publication wording is a UI concern.
 */
export const SECTION_DISPLAY_NAMES: Record<SectionKind, string> = {
  new_knowledge: 'New Knowledge Sought',
  hypothesis: 'Hypothesis',
  uncertainty: 'Sources of Uncertainty',
  experiments_and_results: 'Experiments and Results',
};

/**
 * Map from `event_id` → minimal event metadata. The parent route
 * loads all unique citing_events for the activity in a single bulk
 * query (Task 5.9 will wire this up) and passes the result here so
 * we don't re-fetch per `EventCitation`.
 */
export type EventBundle = Record<string, EventCitationEvent>;

/** Per-section segments keyed by section kind. */
export type NarrativeSections = Record<SectionKind, NarrativeSegment[]>;

/**
 * Footnote numbering scheme. `'per-section'` (default) restarts the
 * counter at [1] for each section; `'global'` uses one monotonic
 * counter shared across all four sections, so the same event cited
 * in §1 and §3 retains the same footnote number.
 *
 * Per-section is the auditor-friendly default: each section is a
 * self-contained AusIndustry submission field, and forcing the
 * reader to scroll back two sections to look up [12] is hostile.
 * `'global'` is the opt-in for stitched-together "full draft" PDFs.
 */
export type FootnoteNumbering = 'per-section' | 'global';

export interface RenderNarrativeProps {
  sections: NarrativeSections;
  events: EventBundle;
  numbering?: FootnoteNumbering;
}

/**
 * Sentinel-string sentinel in `markersForSegment`'s output. Returned
 * for citing_events references that are NOT in the EventBundle (the
 * parent failed to load the cited event, the event was redacted
 * post-citation, etc.). Renders as "[?]" in the marker and SHOULD
 * NOT crash the page — narrative drafts are user-facing, an audit
 * artefact missing one event is recoverable, a 500 is not.
 */
export const MISSING_EVENT_MARKER = '?' as const;

/**
 * Per-section result of `buildFootnoteMap`: an ordered list of
 * (eventId, footnoteNumber) pairs in first-appearance order, plus
 * a reverse map for O(1) marker lookup. Only events present in the
 * `EventBundle` are entered into either map; missing events render
 * as "[?]" without consuming a footnote number.
 */
export interface FootnoteMap {
  /** Event IDs in first-appearance order, paired with their 1-based number. */
  ledger: Array<{ eventId: string; footnoteNumber: number }>;
  /** O(1) lookup from eventId → footnoteNumber. */
  numberFor: Map<string, number>;
}

/**
 * Walk the segments of a single section in order; for each `claim`
 * segment, append previously-unseen `citing_events` to the ledger,
 * skipping any event id not present in `events`. The numbering
 * argument lets the caller seed an existing global counter for
 * `numbering: 'global'`.
 *
 * Pure: no side effects on inputs; safe to call repeatedly.
 *
 * Returns the populated map plus the next available footnote number,
 * which the caller threads through subsequent sections under global
 * numbering.
 */
export function buildFootnoteMap(
  segments: NarrativeSegment[],
  events: EventBundle,
  startAt = 1,
): { map: FootnoteMap; nextNumber: number } {
  const ledger: FootnoteMap['ledger'] = [];
  const numberFor = new Map<string, number>();
  let next = startAt;
  for (const seg of segments) {
    if (seg.type !== 'claim') continue;
    for (const eventId of seg.citing_events) {
      if (numberFor.has(eventId)) continue;
      // Missing events get a marker in markersForSegment but are NOT
      // entered into the ledger — there's nothing to render in the
      // Evidence list for an event we don't have metadata for, and
      // entering them with a number would let "[?]" claim a slot
      // ("[3]") that no ledger row backs up.
      if (!Object.prototype.hasOwnProperty.call(events, eventId)) continue;
      numberFor.set(eventId, next);
      ledger.push({ eventId, footnoteNumber: next });
      next += 1;
    }
  }
  return { map: { ledger, numberFor }, nextNumber: next };
}

/**
 * Resolve a claim segment's `citing_events` to an array of footnote
 * markers. Each entry is either a positive integer (resolved) or
 * the `MISSING_EVENT_MARKER` literal `'?'` (event id not in the
 * bundle).
 *
 * Order preserves the segment's authored citation order — the model
 * is prompted to cite evidence in narrative-relevant order, so the
 * marker sequence reads "[2, 5]" rather than sorted numerically.
 */
export function markersForSegment(
  segment: NarrativeSegment,
  map: FootnoteMap,
  events: EventBundle,
): Array<number | typeof MISSING_EVENT_MARKER> {
  if (segment.type !== 'claim') return [];
  const out: Array<number | typeof MISSING_EVENT_MARKER> = [];
  for (const eventId of segment.citing_events) {
    if (Object.prototype.hasOwnProperty.call(events, eventId)) {
      const n = map.numberFor.get(eventId);
      // Defensive: with `numbering: 'per-section'` the map is built
      // from the same segments we're rendering, so every present
      // event should have a number. With `'global'` we accept event
      // ids only matched in a later section as missing locally.
      out.push(n ?? MISSING_EVENT_MARKER);
    } else {
      out.push(MISSING_EVENT_MARKER);
    }
  }
  return out;
}

/**
 * Format the marker array as the visible "[1, 2]" string used in the
 * superscript. Single-element arrays render as "[1]"; missing-event
 * markers render as "[?]". Pure helper so the test suite can assert
 * on the exact string without poking at JSX.
 */
export function formatMarkers(markers: Array<number | typeof MISSING_EVENT_MARKER>): string {
  if (markers.length === 0) return '';
  return `[${markers.map((m) => (m === MISSING_EVENT_MARKER ? '?' : String(m))).join(', ')}]`;
}

/**
 * The renderer.
 *
 * For each section in `SECTION_KINDS` order:
 *   1. Render the heading (always, even for empty sections).
 *   2. Walk segments in order; emit `<p>` per prose segment, and
 *      `<p>...<sup>[1, 2]</sup></p>` per claim segment.
 *   3. If the section has at least one resolved citation, render
 *      the "Evidence" subheading and the ledger as `<ol>` of
 *      `<EventCitation>` cards.
 *
 * Server component — no `'use client'`. The native `title`-attribute
 * tooltip on each `EventCitation` covers the v1 hover-preview
 * requirement without dragging React Aria / Radix Popover into the
 * narrative-page payload.
 */
export function RenderNarrative({
  sections,
  events,
  numbering = 'per-section',
}: RenderNarrativeProps) {
  // Build all four section maps up front. Under 'global', we thread
  // the running counter through each section in canonical order.
  // Under 'per-section', each section gets its own startAt = 1.
  const sectionMaps: Record<SectionKind, FootnoteMap> = {
    new_knowledge: { ledger: [], numberFor: new Map() },
    hypothesis: { ledger: [], numberFor: new Map() },
    uncertainty: { ledger: [], numberFor: new Map() },
    experiments_and_results: { ledger: [], numberFor: new Map() },
  };
  if (numbering === 'global') {
    // Global numbering shares the counter AND the seen-event set
    // across sections, so an event cited in §1 and §3 keeps its
    // number AND its ledger entry stays in §1 (where it first
    // appeared) — repeating the entry under §3 would imply two
    // distinct pieces of evidence.
    let next = 1;
    const globalSeen = new Map<string, number>();
    for (const kind of SECTION_KINDS) {
      const segments = sections[kind] ?? [];
      const ledger: FootnoteMap['ledger'] = [];
      for (const seg of segments) {
        if (seg.type !== 'claim') continue;
        for (const eventId of seg.citing_events) {
          if (globalSeen.has(eventId)) continue;
          if (!Object.prototype.hasOwnProperty.call(events, eventId)) continue;
          globalSeen.set(eventId, next);
          ledger.push({ eventId, footnoteNumber: next });
          next += 1;
        }
      }
      // numberFor holds ALL globally-seen ids so claims that
      // re-cite an earlier event still resolve to a number; ledger
      // only carries entries that FIRST appeared in this section.
      sectionMaps[kind] = { ledger, numberFor: new Map(globalSeen) };
    }
  } else {
    for (const kind of SECTION_KINDS) {
      const segments = sections[kind] ?? [];
      sectionMaps[kind] = buildFootnoteMap(segments, events).map;
    }
  }

  return (
    <article className="flex flex-col gap-10">
      {SECTION_KINDS.map((kind) => {
        const segments = sections[kind] ?? [];
        const map = sectionMaps[kind];
        return (
          <section
            key={kind}
            data-section-kind={kind}
            className="flex flex-col gap-3 border-b border-border pb-8 last:border-b-0 last:pb-0"
          >
            <h2 className="text-xl font-semibold tracking-tight">{SECTION_DISPLAY_NAMES[kind]}</h2>

            {segments.length === 0 ? null : (
              <div className="flex flex-col gap-3 text-base leading-relaxed">
                {segments.map((seg, segIdx) => {
                  if (seg.type === 'prose') {
                    return (
                      <p key={`${kind}-${segIdx}`} className="whitespace-pre-wrap">
                        {seg.text}
                      </p>
                    );
                  }
                  const markers = markersForSegment(seg, map, events);
                  const formatted = formatMarkers(markers);
                  return (
                    <p key={`${kind}-${segIdx}`} className="whitespace-pre-wrap">
                      {seg.text}
                      {formatted.length > 0 ? (
                        <sup
                          className="ml-0.5 text-xs font-medium text-primary"
                          aria-label={`Citations: ${formatted.replace(/[[\]]/g, '')}`}
                        >
                          {formatted}
                        </sup>
                      ) : null}
                    </p>
                  );
                })}
              </div>
            )}

            {map.ledger.length > 0 ? (
              <div className="mt-2 flex flex-col gap-2">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  Evidence
                </h3>
                <ol className="flex flex-col gap-2">
                  {map.ledger.map(({ eventId, footnoteNumber }) => {
                    const event = events[eventId];
                    if (!event) return null; // belt-and-braces; ledger is filtered upstream
                    return (
                      <EventCitation
                        key={eventId}
                        eventId={eventId}
                        event={event}
                        footnoteNumber={footnoteNumber}
                      />
                    );
                  })}
                </ol>
              </div>
            ) : null}
          </section>
        );
      })}
    </article>
  );
}
