'use client';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, NotFoundError } from '@/lib/api';
import {
  MultiCycleTimeline,
  type CitationGraphEntry,
  type NarrativeSegmentLite,
} from './multi-cycle-timeline';

/**
 * P7 Theme A Task A.5 — route-side wrapper that loads the multi-cycle
 * citation graph + cited segment text and embeds the timeline component.
 *
 * **Wire contract (subject to A.6 / A.7).** The component pulls from
 * `GET /v1/activities/:activity_id/multi-cycle-timeline`, which is
 * expected to return the citation graph (output of
 * `multi-cycle-summarize@1.0.0`) plus a pre-projected segment-text map
 * keyed by `narrative_draft_id`. The endpoint is NOT implemented in the
 * API server as of A.5; until it lands, this hook will 404 and the
 * section will render nothing — by design, the timeline is gated behind
 * the chain having 2+ FYs anyway, so a missing endpoint is
 * indistinguishable from "no prior FY chain" from the consultant's
 * perspective.
 *
 * Catches NotFoundError specifically (HTTP 404 from `apiFetch`); other
 * errors propagate to the query state and result in `query.data ===
 * undefined`, which the section then renders as null. This silent-
 * fallthrough on non-404 errors is by design until the API endpoint
 * lands; document any explicit telemetry hooks in a follow-up.
 *
 * **Gating rules (per Task A.5 spec):**
 *   - chain length < 2 FYs           → render nothing
 *   - endpoint 404 / network error   → render nothing
 *   - endpoint returns empty graph   → render nothing
 *   - otherwise                      → render the timeline
 */

interface MultiCycleTimelineApiResponse {
  proposed_id: string | null;
  fy_labels: string[];
  citation_graph: CitationGraphEntry[];
  /** Keyed by narrative_draft_id. Empty `{}` when no chain exists. */
  segments_by_draft_id: Record<string, NarrativeSegmentLite[]>;
}

async function fetchMultiCycleTimeline(
  activityId: string,
): Promise<MultiCycleTimelineApiResponse | null> {
  try {
    return await apiFetch<MultiCycleTimelineApiResponse>(
      `/v1/activities/${activityId}/multi-cycle-timeline`,
    );
  } catch (err) {
    // Endpoint may not exist yet (A.6+ work). Treat any failure as
    // "no timeline" so the activity page doesn't break — the section
    // is purely additive context.
    if (err instanceof NotFoundError) {
      return null;
    }
    throw err;
  }
}

export function MultiCycleTimelineSection({ activityId }: { activityId: string }) {
  const query = useQuery({
    queryKey: ['multi-cycle-timeline', activityId],
    queryFn: () => fetchMultiCycleTimeline(activityId),
    // Don't refetch on focus — the chain is append-only across FYs and
    // doesn't change while the consultant is editing.
    refetchOnWindowFocus: false,
    // Tolerate the endpoint not existing yet without spamming retries.
    retry: false,
  });

  if (query.isPending || !query.data) return null;
  const data = query.data;

  // Per Task A.5 spec: "embed component when proposed_id chain has 2+
  // FYs". Single-FY (or no chain) → render nothing.
  if (!data.proposed_id || data.fy_labels.length < 2) return null;
  if (data.citation_graph.length === 0) return null;

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Multi-cycle continuity</h2>
      <MultiCycleTimeline
        proposedId={data.proposed_id}
        citationGraph={data.citation_graph}
        narrativeSegmentsByDraftId={data.segments_by_draft_id}
      />
    </section>
  );
}
