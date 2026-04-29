import { sql } from '@cpa/db/client';
import type { ArtefactKind } from '@cpa/schemas';

/**
 * One currently-linked artefact for an activity. Returned from
 * {@link getActivityArtefacts}; the route layer (A5 activity detail,
 * A6 uncertainty register) uses this shape verbatim to render the
 * "Linked evidence" panel.
 *
 * `linked_event_id` is the ARTEFACT_LINKED event that introduced the
 * link — readers can hyperlink straight to the chain row, and the
 * subsequent UNLINKED (if it ever lands) inherits the ordering via
 * `captured_at`.
 */
export interface ActivityArtefact {
  artefact_kind: ArtefactKind;
  artefact_id: string;
  link_reason: string | null;
  linked_event_id: string;
  linked_at: string;
}

/**
 * Currently-linked artefacts for an activity, materialised from the
 * append-only event chain.
 *
 * Algorithm (per the test brief: "filter events of kind LINKED minus
 * subsequent UNLINKED"):
 *
 *   1. Read every ARTEFACT_LINKED + ARTEFACT_UNLINKED event whose
 *      payload.activity_id matches, in `captured_at` order.
 *   2. Walk forward, toggling each `(artefact_kind, artefact_id)` pair
 *      on (LINKED) / off (UNLINKED). The latest event wins, so a
 *      re-link sequence (LINKED → UNLINKED → LINKED) leaves the
 *      artefact visible — second LINKED's event_id replaces the first.
 *   3. Emit the surviving LINKED rows ordered by `linked_at` ascending.
 *
 * The walk is in-memory because a single activity's link history is
 * bounded by reasonable consultant workflows (dozens, not thousands).
 * If/when that ceases to hold we move to a windowed SQL query.
 *
 * Tenant isolation: the caller MUST set `app.current_tenant_id` before
 * invoking this helper. We accept the responsibility on the caller so
 * this helper composes inside an existing `sql.begin` block (route
 * layer already sets the GUC for the activity-existence check). For
 * consultant-portal use the route layer always wraps the call; for
 * direct callers (assurance report jobs) the wrapper is responsible
 * for the GUC.
 *
 * @returns currently-linked artefacts ordered by `linked_at` ascending
 */
export async function getActivityArtefacts(
  activityId: string,
  options?: { tenantId?: string },
): Promise<ActivityArtefact[]> {
  const rows = await sql.begin(async (tx) => {
    if (options?.tenantId) {
      await tx`SELECT set_config('app.current_tenant_id', ${options.tenantId}, true)`;
    }
    const result = await tx<
      {
        id: string;
        kind: 'ARTEFACT_LINKED' | 'ARTEFACT_UNLINKED';
        payload: {
          activity_id: string;
          artefact_kind: ArtefactKind;
          artefact_id: string;
          link_reason?: string;
          reason?: string;
        };
        captured_at: Date | string;
      }[]
    >`
      SELECT id, kind, payload, captured_at
        FROM event
       WHERE kind IN ('ARTEFACT_LINKED', 'ARTEFACT_UNLINKED')
         AND payload ->> 'activity_id' = ${activityId}
       ORDER BY captured_at ASC, received_at ASC, id ASC
    `;
    // Temporary diagnostic for PR #4 test #153 — when zero rows match,
    // also count via privilegedSql (RLS bypassed) to disambiguate "no rows
    // exist" from "RLS filtered them out". Expanded to also dump nearby
    // events for the same activity OR any LINKED/UNLINKED events for the
    // same tenant — narrows whether the seed landed at all vs landed with
    // a different shape than expected.
    if (result.length === 0) {
      const { privilegedSql } = await import('@cpa/db/client');
      const bypass = await privilegedSql<
        {
          id: string;
          kind: string;
          tenant_id: string;
          subject_tenant_id: string;
          payload_text: string;
          captured_at: string;
        }[]
      >`
        SELECT id::text, kind, tenant_id::text, subject_tenant_id::text,
               payload::text AS payload_text, captured_at::text
          FROM event
         WHERE kind IN ('ARTEFACT_LINKED', 'ARTEFACT_UNLINKED')
            OR payload ->> 'activity_id' = ${activityId}
         ORDER BY captured_at DESC
         LIMIT 10
      `;
      console.error('[getActivityArtefacts ZERO_ROWS]', {
        activityId,
        appliedTenantId: options?.tenantId ?? '(none)',
        nearby_event_count: bypass.length,
        nearby_events: bypass.map((r) => ({
          id: r.id,
          kind: r.kind,
          tenant_id: r.tenant_id,
          subject_tenant_id: r.subject_tenant_id,
          payload: r.payload_text,
          captured_at: r.captured_at,
        })),
      });
    }
    return result;
  });

  // Fold: latest event for each (artefact_kind, artefact_id) wins.
  // Map key is `${kind}|${id}` because the same UUID could hypothetically
  // appear under two artefact_kinds (different tables); we treat them as
  // distinct artefact references.
  const live = new Map<string, ActivityArtefact>();
  for (const row of rows) {
    const key = `${row.payload.artefact_kind}|${row.payload.artefact_id}`;
    if (row.kind === 'ARTEFACT_LINKED') {
      live.set(key, {
        artefact_kind: row.payload.artefact_kind,
        artefact_id: row.payload.artefact_id,
        link_reason: row.payload.link_reason ?? null,
        linked_event_id: row.id,
        linked_at:
          typeof row.captured_at === 'string' ? row.captured_at : row.captured_at.toISOString(),
      });
    } else {
      // ARTEFACT_UNLINKED — clear the live entry. A subsequent LINKED
      // will re-add it (re-link case).
      live.delete(key);
    }
  }

  // Stable order: by `linked_at` ascending so the UI renders the oldest
  // links first (matches the consultant's mental model — earliest
  // evidence first).
  return Array.from(live.values()).sort((a, b) => a.linked_at.localeCompare(b.linked_at));
}

/**
 * Look up a single ARTEFACT_LINKED event by id, scoped to a specific
 * activity. Used by the DELETE route to verify the event the caller
 * named (a) exists, (b) is for the activity in the URL, and (c) hasn't
 * already been unlinked. Caller MUST set `app.current_tenant_id` before
 * calling — RLS isolates cross-firm rows. Returns `null` if the event
 * doesn't exist OR is for a different activity OR is already unlinked.
 */
export async function findLinkedEventForActivity(
  eventId: string,
  activityId: string,
  options?: { tenantId?: string },
): Promise<{
  id: string;
  artefact_kind: ArtefactKind;
  artefact_id: string;
  captured_at: Date | string;
} | null> {
  return await sql.begin(async (tx) => {
    if (options?.tenantId) {
      await tx`SELECT set_config('app.current_tenant_id', ${options.tenantId}, true)`;
    }
    const linkedRows = await tx<
      {
        id: string;
        payload: {
          activity_id: string;
          artefact_kind: ArtefactKind;
          artefact_id: string;
        };
        captured_at: Date | string;
      }[]
    >`
      SELECT id, payload, captured_at
        FROM event
       WHERE id = ${eventId}
         AND kind = 'ARTEFACT_LINKED'
         AND payload ->> 'activity_id' = ${activityId}
    `;
    const linked = linkedRows[0];
    if (!linked) return null;

    // Already unlinked? — there's a subsequent ARTEFACT_UNLINKED event for
    // the same (activity_id, artefact_kind, artefact_id) tuple after this
    // event's captured_at AND no re-LINKED in between. We materialise the
    // chain and check whether this artefact is currently live.
    //
    // Simpler approximation: walk the events for this activity up to
    // captured_at-of-linked + onwards, fold, see if `linked.id` is still
    // the live linked_event_id for that artefact. If a subsequent LINKED
    // for the same artefact replaced it, the original is also "no longer
    // live" — that's correct: the DELETE refers to a stale link and the
    // route should reject as 409 (the new LINKED has its own event_id).
    const live = await getActivityArtefacts(activityId, options);
    const stillLive = live.some((a) => a.linked_event_id === linked.id);
    if (!stillLive) return null;

    return {
      id: linked.id,
      artefact_kind: linked.payload.artefact_kind,
      artefact_id: linked.payload.artefact_id,
      captured_at: linked.captured_at,
    };
  });
}
