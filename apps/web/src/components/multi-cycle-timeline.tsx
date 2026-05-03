'use client';
import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

/**
 * P7 Theme A Task A.5 — multi-cycle citation-graph timeline.
 *
 * Presentational React component that renders the prior-FY citation graph
 * (output of `multi-cycle-summarize@1.0.0`) as a horizontal timeline — one
 * column per FY — and lets the user click into a cited segment to read its
 * verbatim text in a drawer-style modal.
 *
 * **Body-by-Michael compliance constraint (architectural intent).** The
 * verbatim narrative text rendered in the drawer comes DIRECTLY from
 * `narrativeSegmentsByDraftId[draft_id][segment_index].text` with NO
 * transformation:
 *   - No truncation in the drawer (only in the card preview).
 *   - No LLM-mediated summarisation, paraphrase, or rewording.
 *   - No locale-aware reformatting.
 *
 * The component is a "render existing data" surface; it is structurally
 * incapable of inserting an LLM between the stored `narrative_segment.text`
 * row and the rendered <pre>. The `transition_rationale` strings shown on
 * the card and in the drawer are scoped to "why this transition kind" —
 * they are NOT prior-year prose (the multi-cycle-summarize@1.0.0 schema
 * guarantees this; see `packages/agents/src/multi-cycle/types.ts`).
 *
 * **Testing.** apps/web's runner is `tsx --test` (Node, no jsdom — see
 * `apps/web/src/lib/narrative/render.test.tsx` for the established
 * pattern). The component therefore exposes its pure helpers
 * (`lookupSegment`, `truncatePreview`, `transitionBadgeClasses`,
 * `groupCitationsByFy`) for direct unit testing, and the full JSX tree is
 * exercised end-to-end via Playwright in a follow-up swimlane.
 *
 * **Local type re-declaration.** apps/web does NOT depend on `@cpa/agents`
 * (the agents package runs in the worker, not in Next.js — same constraint
 * documented in `apps/web/src/lib/narrative/render.tsx`). The
 * `CitationGraphEntry` and `NarrativeSegmentLite` shapes below mirror the
 * canonical types in `packages/agents/src/multi-cycle/types.ts` and
 * `packages/db/src/schema/narrative_segment.ts` respectively. If either
 * drifts, the contract test in Task A.7 will catch the mismatch.
 */

// -----------------------------------------------------------------------------
// Types — mirrored from @cpa/agents (CitationGraphEntry) and
// @cpa/db/schema/narrative_segment (NarrativeSegmentRow), with only the
// fields the timeline UI actually reads. Keeping these local prevents the
// web bundle from pulling in the agents/db packages.
// -----------------------------------------------------------------------------

export const TRANSITION_KINDS = ['continuation', 'pivot', 'completion', 'abandoned'] as const;
export type TransitionKind = (typeof TRANSITION_KINDS)[number];

/**
 * One row of the citation graph emitted by `multi-cycle-summarize@1.0.0`.
 * Mirrors `MultiCycleSummarizerOutput.citation_graph[number]` from
 * `packages/agents/src/multi-cycle/types.ts`.
 */
export interface CitationGraphEntry {
  fy_label: string;
  narrative_draft_id: string;
  section_kind: string;
  content_hash: string;
  cited_segment_indices: number[];
  transition_kind: TransitionKind;
  /** ≤ 500 chars; scoped to "why this transition", not prior-year prose. */
  transition_rationale: string;
}

/**
 * Minimal segment shape the timeline reads. Mirrors
 * {@link import('@cpa/db/schema').NarrativeSegmentRow} but typed locally
 * with only the fields used for rendering. The `text` field is the
 * verbatim segment content as stored in `narrative_segment.text` — see
 * the Body-by-Michael compliance note in the file header.
 */
export interface NarrativeSegmentLite {
  segment_index: number;
  type: 'prose' | 'claim';
  text: string;
  content_hash: string;
  section_kind: string;
}

export interface MultiCycleTimelineProps {
  proposedId: string;
  citationGraph: CitationGraphEntry[];
  /** Pre-loaded segment text keyed by `narrative_draft_id`. */
  narrativeSegmentsByDraftId: Record<string, NarrativeSegmentLite[]>;
  /** Optional — overrides the default empty-state copy. */
  emptyMessage?: string;
}

// -----------------------------------------------------------------------------
// Pure helpers — exported for unit testing under tsx --test.
// -----------------------------------------------------------------------------

/**
 * Length, in characters, of the truncated preview shown on a citation
 * card. The drawer shows the full verbatim text (no truncation) — this
 * cap only applies to the card preview.
 */
export const PREVIEW_CHAR_LIMIT = 150;

/**
 * Length of the truncated content_hash badge (sha256 hex prefix).
 */
export const CONTENT_HASH_BADGE_LENGTH = 8;

/**
 * Truncate a segment's text for display on the citation card. The full
 * verbatim text is preserved in the drawer (Body-by-Michael compliance:
 * the drawer renders the text as stored, byte-for-byte).
 *
 * Returns the input unchanged when it's already at or below the limit.
 * When truncated, appends a single ellipsis character (U+2026).
 */
export function truncatePreview(text: string, limit = PREVIEW_CHAR_LIMIT): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + '…';
}

/**
 * Look up a `NarrativeSegmentLite` by `(narrative_draft_id, segment_index)`.
 * Returns `undefined` when the draft id is not in the map or the index is
 * out of range — the caller decides how to render a missing citation
 * (typically as a "[?]" sentinel, mirroring the events ledger pattern in
 * `lib/narrative/render.tsx`).
 *
 * **No mutation, no transformation.** Returns the segment object as-is.
 */
export function lookupSegment(
  draftId: string,
  segmentIndex: number,
  segmentsByDraftId: Record<string, readonly NarrativeSegmentLite[]>,
): NarrativeSegmentLite | undefined {
  const draftSegments = segmentsByDraftId[draftId];
  if (!draftSegments) return undefined;
  return draftSegments.find((s) => s.segment_index === segmentIndex);
}

/**
 * Group a citation-graph list into one bucket per `fy_label`, preserving
 * the input order both across FYs and within a single FY's bucket.
 *
 * The agent emits `citation_graph` already sorted by FY ascending (oldest
 * first); we don't re-sort here — preserving authored order keeps the
 * rendered timeline aligned with what the agent decided to cite.
 */
export function groupCitationsByFy(
  citationGraph: readonly CitationGraphEntry[],
): Array<{ fy_label: string; entries: CitationGraphEntry[] }> {
  const buckets = new Map<string, CitationGraphEntry[]>();
  const order: string[] = [];
  for (const entry of citationGraph) {
    let bucket = buckets.get(entry.fy_label);
    if (!bucket) {
      bucket = [];
      buckets.set(entry.fy_label, bucket);
      order.push(entry.fy_label);
    }
    bucket.push(entry);
  }
  return order.map((fy) => ({ fy_label: fy, entries: buckets.get(fy) ?? [] }));
}

/**
 * Tailwind class string for a transition badge. The color mapping is
 * pinned by the Task A.5 spec:
 *   continuation → emerald (green)
 *   pivot        → amber
 *   completion   → blue
 *   abandoned    → slate (gray)
 *
 * Matches the chip palette used elsewhere in apps/web (see
 * `chain-status-badge.tsx`).
 */
export function transitionBadgeClasses(kind: TransitionKind): string {
  switch (kind) {
    case 'continuation':
      return 'bg-emerald-100 text-emerald-800 ring-1 ring-inset ring-emerald-200';
    case 'pivot':
      return 'bg-amber-100 text-amber-800 ring-1 ring-inset ring-amber-200';
    case 'completion':
      return 'bg-blue-100 text-blue-800 ring-1 ring-inset ring-blue-200';
    case 'abandoned':
      return 'bg-slate-100 text-slate-700 ring-1 ring-inset ring-slate-200';
    default: {
      // Exhaustiveness: if a new transition kind is added to the agent
      // schema without a matching color, TS will flag this branch.
      const _exhaustive: never = kind;
      void _exhaustive;
      return 'bg-slate-100 text-slate-700 ring-1 ring-inset ring-slate-200';
    }
  }
}

/** Human-readable label for a transition kind (UI copy). */
export function transitionLabel(kind: TransitionKind): string {
  switch (kind) {
    case 'continuation':
      return 'Continuation';
    case 'pivot':
      return 'Pivot';
    case 'completion':
      return 'Completion';
    case 'abandoned':
      return 'Abandoned';
    default: {
      const _exhaustive: never = kind;
      void _exhaustive;
      return String(kind);
    }
  }
}

/** Truncate a content_hash for the card badge (full hash shown in drawer). */
export function truncateContentHash(hash: string): string {
  return hash.slice(0, CONTENT_HASH_BADGE_LENGTH);
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

/**
 * Identifier for the currently-open drawer citation. `null` when closed.
 * The composite key uniquely identifies a (citation_graph_entry,
 * cited_segment_index) pair — needed because a single graph entry can
 * cite multiple segments of the same draft.
 */
interface OpenCitation {
  fy_label: string;
  narrative_draft_id: string;
  segment_index: number;
  transition_kind: TransitionKind;
  transition_rationale: string;
  content_hash: string;
  section_kind: string;
}

export function MultiCycleTimeline({
  proposedId,
  citationGraph,
  narrativeSegmentsByDraftId,
  emptyMessage,
}: MultiCycleTimelineProps): React.ReactElement | null {
  const [openCitation, setOpenCitation] = React.useState<OpenCitation | null>(null);

  const grouped = React.useMemo(() => groupCitationsByFy(citationGraph), [citationGraph]);

  // Empty state. Returning `null` would also work, but a one-line hint
  // helps debug "why is the timeline missing?" during integration —
  // matches the muted-text empty-state convention used in
  // `app/claims/[claim_id]/activities/[activity_id]/page.tsx`.
  if (grouped.length === 0) {
    return (
      <div
        className="text-sm text-muted-foreground"
        data-testid="multi-cycle-timeline-empty"
        data-proposed-id={proposedId}
      >
        {emptyMessage ?? 'No prior-FY citations for this proposed_id chain.'}
      </div>
    );
  }

  const openSegment = openCitation
    ? lookupSegment(
        openCitation.narrative_draft_id,
        openCitation.segment_index,
        narrativeSegmentsByDraftId,
      )
    : undefined;

  return (
    <div className="space-y-3" data-testid="multi-cycle-timeline" data-proposed-id={proposedId}>
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-foreground">Prior-FY continuity</h3>
        <span className="text-xs text-muted-foreground">
          {grouped.length} {grouped.length === 1 ? 'cycle' : 'cycles'}
        </span>
      </div>

      {/* Horizontal scroller — each FY is a fixed-width column so the
          timeline stays readable when the chain is 4+ FYs deep. */}
      <div className="flex gap-4 overflow-x-auto pb-2" data-testid="multi-cycle-timeline-scroller">
        {grouped.map((bucket, columnIndex) => {
          const isLast = columnIndex === grouped.length - 1;
          // The "transition to next FY" badge sits at the head of the
          // CURRENT column and describes the transition emitted by the
          // first citation in the next bucket. This matches the
          // semantic that `transition_kind` describes "how this cited
          // segment is being treated by the next FY". For the last
          // column there is no next FY, so we omit the next-transition
          // badge and only show the FY header.
          const nextBucket = isLast ? undefined : grouped[columnIndex + 1];
          const nextTransition = nextBucket?.entries[0]?.transition_kind;
          const nextFyLabel = nextBucket?.fy_label;

          return (
            <div
              key={bucket.fy_label}
              className="flex-shrink-0 w-72 rounded-lg border bg-card"
              data-testid="multi-cycle-timeline-column"
              data-fy-label={bucket.fy_label}
            >
              <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
                <span
                  id={`fy-${bucket.fy_label}-heading`}
                  className="font-mono text-sm font-semibold"
                >
                  {bucket.fy_label}
                </span>
                {nextTransition ? (
                  <span
                    className={cn(
                      'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                      transitionBadgeClasses(nextTransition),
                    )}
                    data-testid="multi-cycle-transition-badge"
                    data-transition-kind={nextTransition}
                    title={`→ ${nextFyLabel ?? ''}: ${transitionLabel(nextTransition)}`}
                  >
                    → {transitionLabel(nextTransition)}
                  </span>
                ) : null}
              </div>

              <ul className="space-y-2 p-3" aria-labelledby={`fy-${bucket.fy_label}-heading`}>
                {bucket.entries.flatMap((entry) =>
                  entry.cited_segment_indices.map((segIdx) => {
                    const segment = lookupSegment(
                      entry.narrative_draft_id,
                      segIdx,
                      narrativeSegmentsByDraftId,
                    );
                    const previewText = segment ? truncatePreview(segment.text) : '[?]';
                    const cardKey = `${entry.narrative_draft_id}:${segIdx}`;
                    return (
                      <li key={cardKey}>
                        <button
                          type="button"
                          className="w-full text-left rounded-md border bg-background px-3 py-2 hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors"
                          data-testid="multi-cycle-citation-card"
                          data-narrative-draft-id={entry.narrative_draft_id}
                          data-segment-index={segIdx}
                          onClick={() =>
                            setOpenCitation({
                              fy_label: entry.fy_label,
                              narrative_draft_id: entry.narrative_draft_id,
                              segment_index: segIdx,
                              transition_kind: entry.transition_kind,
                              transition_rationale: entry.transition_rationale,
                              content_hash: entry.content_hash,
                              section_kind: entry.section_kind,
                            })
                          }
                        >
                          <div className="flex items-center justify-between gap-2 mb-1">
                            <span className="text-xs uppercase tracking-wide text-muted-foreground">
                              {entry.section_kind}
                            </span>
                            <span
                              className="font-mono text-[10px] text-muted-foreground"
                              title={entry.content_hash}
                            >
                              {truncateContentHash(entry.content_hash)}
                            </span>
                          </div>
                          <p className="text-sm text-foreground whitespace-pre-wrap break-words">
                            {previewText}
                          </p>
                          <div className="mt-2">
                            <span
                              className={cn(
                                'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium',
                                transitionBadgeClasses(entry.transition_kind),
                              )}
                              data-testid="multi-cycle-card-transition-badge"
                              data-transition-kind={entry.transition_kind}
                            >
                              {transitionLabel(entry.transition_kind)}
                            </span>
                          </div>
                        </button>
                      </li>
                    );
                  }),
                )}
              </ul>
            </div>
          );
        })}
      </div>

      {/* Drawer/modal: full verbatim segment text. The text below comes
          UNCHANGED from `narrative_segment.text` — see the file header
          for the Body-by-Michael compliance constraint. */}
      <Dialog
        open={openCitation !== null}
        onOpenChange={(open) => {
          if (!open) setOpenCitation(null);
        }}
      >
        <DialogContent className="max-w-2xl" data-testid="multi-cycle-segment-drawer">
          {openCitation ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <span className="font-mono text-sm">{openCitation.fy_label}</span>
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">
                    {openCitation.section_kind}
                  </span>
                </DialogTitle>
                <DialogDescription>
                  Verbatim cited segment from prior-FY narrative draft.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={cn(
                      'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                      transitionBadgeClasses(openCitation.transition_kind),
                    )}
                    data-testid="multi-cycle-drawer-transition-badge"
                    data-transition-kind={openCitation.transition_kind}
                  >
                    {transitionLabel(openCitation.transition_kind)}
                  </span>
                  <span
                    className="font-mono text-xs text-muted-foreground"
                    data-testid="multi-cycle-drawer-content-hash"
                  >
                    {openCitation.content_hash}
                  </span>
                </div>

                {openCitation.transition_rationale ? (
                  <div className="rounded-md border bg-muted/30 p-3">
                    <div className="text-xs font-medium text-muted-foreground mb-1">
                      Transition rationale
                    </div>
                    <p className="text-sm text-foreground whitespace-pre-wrap break-words">
                      {openCitation.transition_rationale}
                    </p>
                  </div>
                ) : null}

                <div>
                  <div className="text-xs font-medium text-muted-foreground mb-1">
                    Verbatim segment text
                  </div>
                  {openSegment ? (
                    // <pre> with whitespace-pre-wrap preserves the
                    // exact stored bytes. NO truncation, NO transform.
                    <pre
                      className="rounded-md border bg-background p-3 text-sm text-foreground whitespace-pre-wrap break-words font-sans"
                      data-testid="multi-cycle-drawer-verbatim-text"
                    >
                      {openSegment.text}
                    </pre>
                  ) : (
                    <p
                      className="text-sm text-muted-foreground italic"
                      data-testid="multi-cycle-drawer-segment-missing"
                    >
                      Segment text not loaded for narrative_draft_id{' '}
                      <span className="font-mono">{openCitation.narrative_draft_id}</span> /
                      segment_index {openCitation.segment_index}.
                    </p>
                  )}
                </div>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
