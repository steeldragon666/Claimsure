/**
 * Pure-function gating logic for the claim wizard. Computes "can the
 * consultant advance from step N to N+1?" from a snapshot of underlying
 * data — no DB access here; the caller (the route handler) loads the
 * snapshot once and asks per step.
 *
 * Per Q5.b (revision flow), this is always computed live from current
 * data, so editing a prior step's data (e.g. adding new evidence) can
 * cause `canAdvance` on a later step to flip from ok=true back to
 * ok=false with a reason — the wizard surfaces this as a "data changed
 * since you last agreed" banner.
 */
import type { WorkflowState } from '@cpa/schemas';

/**
 * Structural type for a `postgres`-js query client (either the top-level
 * `sql` or a `TransactionSql` from inside `sql.begin`). Declared inline
 * to avoid adding `postgres` as a direct dep of `@cpa/api` — it lives
 * under `@cpa/db` and the wider codebase only imports the runtime `sql`
 * binding, not the type.
 *
 * The shape covers exactly what `loadWorkflowSnapshot` needs: tagged-
 * template invocation returning a `Promise` of a typed row array.
 *
 * Note: postgres-js's real `Sql` / `TransactionSql` interface carries a
 * second overload (the "helper" form `sql(value, ...)` for IN-lists and
 * row builders) that returns a non-thenable `Helper<any, any>`. TS picks
 * that overload when checking assignability against this narrow structural
 * type and fails on the `then` member being private on `Helper`. Callers
 * that pass a real `TransactionSql` must therefore use a cast at the call
 * site (`loadWorkflowSnapshot(tx as unknown as SqlClient, ...)`); the
 * runtime contract — tagged-template tx returns a thenable row array — is
 * exactly what this helper relies on.
 */
export type SqlClient = <T>(
  strings: TemplateStringsArray,
  ...args: unknown[]
) => Promise<T> & PromiseLike<T>;

/**
 * Lookup table from the numeric step type used by the wizard to the
 * literal string keys used in `WorkflowState.steps`. Keeps the literal-
 * key precision intact — if the step union ever drifts (e.g. someone
 * widens to `number`), this conversion fails at compile time rather
 * than producing a `WorkflowState` with an unexpected key that fails
 * the strict zod validator at the persistence boundary.
 */
const STEP_KEY: Record<1 | 2 | 3 | 4 | 5, '1' | '2' | '3' | '4' | '5'> = {
  1: '1',
  2: '2',
  3: '3',
  4: '4',
  5: '5',
};

/**
 * Narrative drafter produces four sections (Hypothesis / Experiment /
 * Evaluation / Outcome) per draft-narrative@1.1.0. Step 4 requires every
 * section to be approved before advance.
 */
const REQUIRED_NARRATIVE_SECTIONS = 4;

export type WorkflowSnapshot = {
  eventsClassified: number;
  proposedActivitiesPending: number;
  proposedActivitiesTotal: number;
  agreedActivitiesTotal: number;
  agreedActivitiesWithoutBinding: number;
  narrativeSectionsApproved: number;
};

export type CanAdvanceResult = { ok: true } | { ok: false; reason: string };

export function canAdvance(step: 1 | 2 | 3 | 4 | 5, snap: WorkflowSnapshot): CanAdvanceResult {
  switch (step) {
    case 1:
      return snap.eventsClassified > 0
        ? { ok: true }
        : { ok: false, reason: 'Upload at least one piece of evidence to advance.' };
    case 2:
      return snap.proposedActivitiesPending === 0
        ? { ok: true }
        : {
            ok: false,
            reason: `${snap.proposedActivitiesPending} proposed activit${snap.proposedActivitiesPending === 1 ? 'y' : 'ies'} still pending — Agree or Reject each one.`,
          };
    case 3:
      return snap.agreedActivitiesWithoutBinding === 0
        ? { ok: true }
        : {
            ok: false,
            reason: `${snap.agreedActivitiesWithoutBinding} agreed activit${snap.agreedActivitiesWithoutBinding === 1 ? 'y has' : 'ies have'} no bound evidence yet.`,
          };
    case 4:
      return snap.narrativeSectionsApproved >= REQUIRED_NARRATIVE_SECTIONS
        ? { ok: true }
        : {
            ok: false,
            reason: `${snap.narrativeSectionsApproved} of ${REQUIRED_NARRATIVE_SECTIONS} narrative sections approved — approve the remaining ${REQUIRED_NARRATIVE_SECTIONS - snap.narrativeSectionsApproved} to advance.`,
          };
    case 5:
      return { ok: false, reason: 'Step 5 is terminal — no further advance.' };
    default: {
      const _exhaustive: never = step;
      throw new Error(`canAdvance: unhandled step ${_exhaustive as number}`);
    }
  }
}

export function initialWorkflowState(initializedAt: string): WorkflowState {
  return {
    initialized_at: initializedAt,
    steps: { '1': null, '2': null, '3': null, '4': null, '5': null },
  };
}

/**
 * Pure reducer. Returns a new state with the named step recorded as
 * agreed at `now` by `userId`. Input `state` is not mutated.
 *
 * Re-agreeing an already-agreed step overwrites the prior entry.
 * This is intentional: per Q5.b, the wizard surfaces a "data changed
 * since last agreed" banner and the consultant clicks Agree again to
 * refresh the timestamp. Historical agree-events are recorded in the
 * append-only audit-log chain — not here.
 */
export function applyAgree(
  state: WorkflowState,
  step: 1 | 2 | 3 | 4 | 5,
  userId: string,
  now: string,
): WorkflowState {
  return {
    ...state,
    steps: {
      ...state.steps,
      [STEP_KEY[step]]: { agreed_at: now, agreed_by: userId },
    },
  };
}

export function applyReopen(state: WorkflowState, step: 1 | 2 | 3 | 4 | 5): WorkflowState {
  // No cascade per Q5.b — downstream steps keep their agreed_at; UI shows
  // a soft "data changed since" warning instead.
  return {
    ...state,
    steps: { ...state.steps, [STEP_KEY[step]]: null },
  };
}

/**
 * Load the data points {@link canAdvance} needs for a given claim. Runs
 * inside RLS scope — the caller MUST have set `app.current_tenant_id`
 * before invoking this (the wizard route's `sql.begin` wrapper does so).
 *
 * Belt-and-suspenders tenant scoping: every event-table scan AND every
 * narrative_draft scan carries an explicit `tenant_id = ${tenantId}`
 * predicate IN ADDITION to the `app.current_tenant_id` GUC that drives
 * RLS. This mirrors the convention in `routes/activity-register.ts:
 * loadLatestDraft` and `routes/pending-narrative.ts`: RLS is the primary
 * defence, but if a future migration silently drops the policy (or a
 * caller forgets the GUC), the explicit predicate prevents cross-tenant
 * leakage. Cheap insurance — every scan is already filtered on a more
 * selective column, so the extra predicate adds no measurable cost.
 *
 * Four SQL round-trips producing six counters:
 *
 *   (1) classified events — one COUNT(*) on `event` for the claim's
 *       subject_tenant where `kind IS NOT NULL`. The wizard's step-1
 *       gate fires once any classified event exists at all.
 *
 *       TODO(workflow-step1-semantic): the current `kind IS NOT NULL`
 *       predicate is intentionally permissive. The `event_kind` enum
 *       (see `packages/schemas/src/event.ts`) interleaves raw-evidence
 *       kinds (HYPOTHESIS, EXPERIMENT, EVIDENCE_UPLOADED, …) with
 *       state-transition kinds (ACTIVITY_CREATED, NARRATIVE_APPROVED,
 *       CLAIM_STAGE_ADVANCED, …) in one flat union. Until that enum
 *       grows a clean evidence-vs-system split (or we add a
 *       `classification IS NOT NULL` filter — currently inadvisable
 *       because not every evidence path writes a classification row
 *       yet), step 1's gate counts ANY event row for the subject
 *       tenant. In practice this still gates correctly: a claim with
 *       zero rows has no captured anything, and the false positives
 *       (system events firing before any evidence) don't happen in the
 *       current wizard flow — state-transition events are always
 *       preceded by an evidence event.
 *
 *   (2 + 3) proposed activities total + pending — one CTE pipeline.
 *       Take the LATEST `ACTIVITY_REGISTER_DRAFTED` event per project
 *       under the claim, unnest `proposed_activities[]`, and LEFT JOIN
 *       against `ACTIVITY_CREATED` events carrying matching
 *       `payload.proposed_id`. Row count = total; rows with NULL
 *       right-hand side = pending. Same dedup-to-latest-draft rule
 *       `routes/activity-register.ts:loadLatestDraft` uses for the
 *       single-project view.
 *
 *   (4 + 5) agreed activities total + without binding — one CTE
 *       pipeline. Count `activity` rows for the claim, then fold
 *       `ARTEFACT_LINKED`/`ARTEFACT_UNLINKED` into the most-recent
 *       event per `(activity_id, artefact_kind, artefact_id)` triple
 *       (live iff the last event is `ARTEFACT_LINKED`), and count
 *       activities with zero live triples. Same algorithm as
 *       `lib/activity-artefacts.ts:getActivityArtefacts` but applied
 *       across every activity in one shot — one SQL aggregate beats
 *       N per-activity round trips.
 *
 *   (6) narrative sections approved — one COUNT(DISTINCT section_kind)
 *       on `narrative_draft` joined to `activity` by `activity_id`
 *       where `status = 'accepted'`. `narrative_draft` has no
 *       `claim_id` of its own — the join is the only path.
 *
 * Why four small round-trips instead of one mega-CTE: each is
 * independently debuggable, the endpoint only fires on page-load +
 * after mutations (not a hot path), and the SQL stays legible. If
 * perf ever matters, collapsing them is a localised refactor.
 */
export async function loadWorkflowSnapshot(
  sql: SqlClient,
  tenantId: string,
  claimId: string,
): Promise<WorkflowSnapshot> {
  // ---------------------------------------------------------------------
  // 1. Classified events for the claim's subject_tenant.
  // ---------------------------------------------------------------------
  const eventsRows = await sql<{ n: string }[]>`
    SELECT COUNT(*)::text AS n
      FROM event
     WHERE tenant_id = ${tenantId}
       AND subject_tenant_id IN (
             SELECT subject_tenant_id FROM claim WHERE id = ${claimId}
           )
       AND kind IS NOT NULL
  `;
  const eventsClassified = Number(eventsRows[0]?.n ?? 0);

  // ---------------------------------------------------------------------
  // 2 + 3. Proposed activities: total + pending.
  //
  // For each project under the claim, find the LATEST
  // `ACTIVITY_REGISTER_DRAFTED` event, unnest its `proposed_activities[]`,
  // and LEFT JOIN against ACTIVITY_CREATED events that carry a matching
  // `payload.proposed_id`. A NULL right-hand side = pending.
  //
  // Project-set derivation: a claim's activities all share `claim_id` and
  // also carry `project_id` — but a claim with zero accepted activities
  // yet has no rows there. Fall back to `claim.project_id` (the direct
  // FK added in migration 0019) so we still see proposals before the
  // first acceptance.
  // ---------------------------------------------------------------------
  const proposedRows = await sql<{ proposed_id: string; accepted_activity_id: string | null }[]>`
    WITH claim_projects AS (
      SELECT DISTINCT project_id FROM (
        SELECT project_id FROM claim    WHERE id = ${claimId} AND project_id IS NOT NULL
        UNION
        SELECT project_id FROM activity WHERE claim_id = ${claimId}
      ) p
      WHERE project_id IS NOT NULL
    ),
    latest_draft AS (
      SELECT DISTINCT ON (e.project_id)
             e.id,
             e.project_id,
             e.tenant_id,
             e.payload
        FROM event e
        JOIN claim_projects cp ON cp.project_id = e.project_id
       WHERE e.tenant_id = ${tenantId}
         AND e.kind = 'ACTIVITY_REGISTER_DRAFTED'
       ORDER BY e.project_id, e.captured_at DESC, e.received_at DESC, e.id DESC
    ),
    proposed AS (
      SELECT ld.tenant_id,
             ld.project_id,
             (pa ->> 'proposed_id') AS proposed_id
        FROM latest_draft ld,
             LATERAL jsonb_array_elements(ld.payload -> 'proposed_activities') AS pa
    )
    SELECT p.proposed_id,
           (ac.payload ->> 'activity_id') AS accepted_activity_id
      FROM proposed p
      LEFT JOIN event ac
             ON ac.tenant_id = ${tenantId}
            AND ac.kind = 'ACTIVITY_CREATED'
            AND ac.tenant_id = p.tenant_id
            AND ac.project_id = p.project_id
            AND (ac.payload ->> 'proposed_id') = p.proposed_id
  `;
  const proposedActivitiesTotal = proposedRows.length;
  const proposedActivitiesPending = proposedRows.filter(
    (r) => r.accepted_activity_id === null,
  ).length;

  // ---------------------------------------------------------------------
  // 4 + 5. Agreed activities: total + without binding.
  //
  // "Live link" = the most-recent ARTEFACT_LINKED / ARTEFACT_UNLINKED
  // event for a given (activity_id, artefact_kind, artefact_id) triple
  // is ARTEFACT_LINKED. We DISTINCT ON to take the last event per triple
  // and keep only the LINKED ones, then check existence per activity.
  // ---------------------------------------------------------------------
  const activityRows = await sql<{ id: string; live_link_count: string }[]>`
    WITH activities AS (
      SELECT id, tenant_id FROM activity WHERE claim_id = ${claimId}
    ),
    link_events AS (
      SELECT (payload ->> 'activity_id')   AS activity_id,
             (payload ->> 'artefact_kind') AS artefact_kind,
             (payload ->> 'artefact_id')   AS artefact_id,
             kind,
             captured_at,
             received_at,
             id
        FROM event
       WHERE tenant_id = ${tenantId}
         AND kind IN ('ARTEFACT_LINKED', 'ARTEFACT_UNLINKED')
         AND (payload ->> 'activity_id') IN (SELECT id::text FROM activities)
    ),
    latest_per_triple AS (
      SELECT DISTINCT ON (activity_id, artefact_kind, artefact_id)
             activity_id, artefact_kind, artefact_id, kind
        FROM link_events
       ORDER BY activity_id, artefact_kind, artefact_id,
                captured_at DESC, received_at DESC, id DESC
    ),
    live_links AS (
      SELECT activity_id, COUNT(*)::text AS live_link_count
        FROM latest_per_triple
       WHERE kind = 'ARTEFACT_LINKED'
       GROUP BY activity_id
    )
    SELECT a.id::text AS id,
           COALESCE(ll.live_link_count, '0') AS live_link_count
      FROM activities a
      LEFT JOIN live_links ll ON ll.activity_id = a.id::text
  `;
  const agreedActivitiesTotal = activityRows.length;
  const agreedActivitiesWithoutBinding = activityRows.filter(
    (r) => Number(r.live_link_count) === 0,
  ).length;

  // ---------------------------------------------------------------------
  // 6. Narrative sections accepted (= "approved" in wizard parlance).
  //
  // narrative_draft has no claim_id — join through activity. DISTINCT on
  // section_kind so multiple activities each contributing the same
  // section don't double-count: the wizard's step-4 gate expects four
  // sections done, period, across the claim.
  // ---------------------------------------------------------------------
  const narrRows = await sql<{ accepted: string }[]>`
    SELECT COUNT(DISTINCT nd.section_kind)::text AS accepted
      FROM narrative_draft nd
      JOIN activity a ON a.id = nd.activity_id
     WHERE nd.tenant_id = ${tenantId}
       AND a.claim_id   = ${claimId}
       AND nd.status    = 'accepted'
  `;
  const narrativeSectionsApproved = Number(narrRows[0]?.accepted ?? 0);

  return {
    eventsClassified,
    proposedActivitiesTotal,
    proposedActivitiesPending,
    agreedActivitiesTotal,
    agreedActivitiesWithoutBinding,
    narrativeSectionsApproved,
  };
}
