import type { FastifyInstance } from 'fastify';
import { requireSession } from '@cpa/auth';
import { sql } from '@cpa/db/client';
import { insertEventWithChain } from '@cpa/db';
import {
  ArtefactLinkedPayload,
  ArtefactUnlinkedPayload,
  CreateArtefactLinkBody,
  UnlinkArtefactBody,
} from '@cpa/schemas';
import { findLinkedEventForActivity, getActivityArtefacts } from '../lib/activity-artefacts.js';

// TODO(p4-a-cleanup): post-A1 review-flagged refactors deferred to a separate
// cross-cutting task after the swimlanes merge — same items affect this file:
//
//   1. Event-write (`insertEventWithChain`) runs AFTER the row-mutation
//      transaction commits. Here that means the activity-existence check
//      inside `sql.begin` lands first, and a chain-write failure between
//      the two awaits leaves no event but a successful precondition pass.
//      Fix: extend `insertEventWithChain` to accept an optional `tx`
//      parameter so callers compose precondition+event in one tx.
//      Affects all routes that emit chain events.
//      See: A1 quality review 2026-04-28, Important #3.
//
//   2. The artefact-existence switch (per artefact_kind) lives inside the
//      `sql.begin` callback in POST. A future refactor could replace this
//      with a SQL function that takes (kind, id, tenant_id) and returns
//      bool, hiding the table list at the DB layer; for now we keep the
//      switch inline because postgres-js's `TransactionSql` type isn't
//      reachable from apps/api without pulling postgres in as a direct
//      dep, and a structurally-typed wrapper drifts from the actual
//      callback shape (helper-thenable vs Promise). Worth doing once the
//      uncertainty register (A6) needs the same lookup.
//
// TODO(p4-a-cleanup): A4 quality review (2026-04-28) flagged additional
// items beyond the Critical fix landed in this commit:
//   - Important #2: Consolidate disambiguation into a single CTE-based
//     query (`WITH self AS (...), later_events AS (...)`) so DELETE on a
//     stale link does one trip instead of two helper folds + a SELECT.
//     Beneficial when A5/A6 add more callers to activity-artefacts.ts.
//   - Important #4: Add expression index on
//     `(payload->>'activity_id') WHERE kind IN ('ARTEFACT_LINKED','ARTEFACT_UNLINKED', /* register kinds */)`
//     — still deferred, now also blocking events.ts:330 (the A6 register
//     feed's activity-scoped filter performs the same payload->>'activity_id'
//     comparison). The companion TODO at events.ts:330 sketches the index DDL
//     and the volume threshold (>5k events / tenant). Both callsites
//     full-scan the event table today; pick this up together.
//   - Minor #8: Add Zod Uuid.safeParse on URL params (event_id, activity_id)
//     to surface 400 instead of relying on postgres cast errors for malformed
//     UUIDs. Same gap exists across A1-A4 routes.

/**
 * Register the activity artefact-link routes (T-A4 of the P4 plan).
 *
 * The link/unlink pair drives the consultant-facing "Linked evidence"
 * panel on the activity detail view. Both routes are append-only: a
 * link writes ARTEFACT_LINKED, an unlink writes ARTEFACT_UNLINKED with
 * the same artefact_id; the original LINKED event is NEVER deleted.
 * The materialised "currently linked artefacts" list is computed by
 * {@link getActivityArtefacts} (folding LINKED minus UNLINKED in
 * captured_at order).
 *
 * Auth: requireSession + admin-or-consultant gating on both routes.
 *   - Viewers can list/detail but cannot link or unlink.
 *
 * RLS: every read/write inside `sql.begin` sets `app.current_tenant_id`.
 * Cross-firm 404 is enforced two ways:
 *   - Activity lookup uses RLS + `AND tenant_id = ${tenantId}`
 *     (defense-in-depth, same pattern as A3 PATCH).
 *   - Artefact existence check (one of `media_artefact` / `event` /
 *     `expenditure` / `time_entry`) is RLS-scoped AND has an explicit
 *     `AND tenant_id = ${tenantId}` clause — so a mis-set GUC can't
 *     leak cross-firm artefact_ids.
 *
 * Stage gating: a 'submitted' or 'audit_defence' parent claim freezes
 * artefact links — neither POST nor DELETE may write. Consultants must
 * edit before the claim hits a terminal stage (same gate as A3 PATCH).
 *
 * Event chain: each mutation extends the per-claimant hash chain via
 * `insertEventWithChain`. The helper holds a per-subject_tenant
 * advisory lock so concurrent mutations on the same chain serialise.
 */
export function registerArtefactLinks(app: FastifyInstance): void {
  // ---------------------------------------------------------------------
  // POST /v1/activities/:activity_id/artefact-links
  // body: { artefact_kind, artefact_id, link_reason? }
  // ---------------------------------------------------------------------
  app.post<{ Params: { activity_id: string } }>(
    '/v1/activities/:activity_id/artefact-links',
    { preHandler: requireSession },
    async (req, reply) => {
      const role = req.user!.role;
      if (role !== 'admin' && role !== 'consultant') {
        return reply.status(403).send({
          error: 'forbidden',
          message: 'Admin or consultant role required',
          requestId: req.id,
        });
      }

      const parsed = CreateArtefactLinkBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'invalid_body',
          message:
            'Body must be { artefact_kind: "media" | "event" | "expenditure" | "time_entry", artefact_id, link_reason? }',
          requestId: req.id,
        });
      }
      const { artefact_kind, artefact_id, link_reason } = parsed.data;
      const { activity_id } = req.params;
      const tenantId = req.user!.tenantId!;
      const userId = req.user!.id;

      // Resolve the activity + parent claim stage + subject_tenant in
      // one tx. Same pattern as A3 PATCH — defends against a racing
      // submit/audit-defence transition between activity-lookup and
      // event-write.
      const guard = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const activityRows = await tx<
          {
            id: string;
            project_id: string;
            subject_tenant_id: string;
            claim_stage: string;
          }[]
        >`
          SELECT a.id, a.project_id,
                 c.stage AS claim_stage,
                 c.subject_tenant_id AS subject_tenant_id
            FROM activity a
            JOIN claim c ON c.id = a.claim_id
           WHERE a.id = ${activity_id}
             AND a.tenant_id = ${tenantId}
        `;
        const activity = activityRows[0];
        if (!activity) return { kind: 'activity_not_found' as const };
        if (activity.claim_stage === 'submitted' || activity.claim_stage === 'audit_defence') {
          return { kind: 'claim_locked' as const, stage: activity.claim_stage };
        }
        // Cross-tenant artefact existence check. RLS already filters
        // cross-firm rows; the explicit `AND tenant_id` is
        // defense-in-depth (matches A3's pattern). Inlined per-kind
        // because postgres-js's `TransactionSql` type isn't reachable
        // from apps/api as a callable shape — see the file-top TODO
        // for the planned refactor.
        let artefactExists = false;
        if (artefact_kind === 'media') {
          const rows = await tx<{ id: string }[]>`
            SELECT id FROM media_artefact
             WHERE id = ${artefact_id}
               AND tenant_id = ${tenantId}
          `;
          artefactExists = rows.length > 0;
        } else if (artefact_kind === 'event') {
          const rows = await tx<{ id: string }[]>`
            SELECT id FROM event
             WHERE id = ${artefact_id}
               AND tenant_id = ${tenantId}
          `;
          artefactExists = rows.length > 0;
        } else if (artefact_kind === 'expenditure') {
          const rows = await tx<{ id: string }[]>`
            SELECT id FROM expenditure
             WHERE id = ${artefact_id}
               AND tenant_id = ${tenantId}
          `;
          artefactExists = rows.length > 0;
        } else if (artefact_kind === 'time_entry') {
          const rows = await tx<{ id: string }[]>`
            SELECT id FROM time_entry
             WHERE id = ${artefact_id}
               AND tenant_id = ${tenantId}
          `;
          artefactExists = rows.length > 0;
        } else {
          // Exhaustiveness — TS errors at this assignment if the
          // ArtefactKind enum ever grows without a matching branch above.
          const _exhaustive: never = artefact_kind;
          void _exhaustive;
        }
        if (!artefactExists) return { kind: 'artefact_not_found' as const };

        return {
          kind: 'ok' as const,
          project_id: activity.project_id,
          subject_tenant_id: activity.subject_tenant_id,
        };
      });

      if (guard.kind === 'activity_not_found') {
        return reply.status(404).send({
          error: 'activity_not_found',
          message: 'No activity with that id in this firm',
          requestId: req.id,
        });
      }
      if (guard.kind === 'claim_locked') {
        return reply.status(409).send({
          error: 'claim_locked',
          message: `Cannot link artefacts to an activity on a claim in stage "${guard.stage}"`,
          requestId: req.id,
        });
      }
      if (guard.kind === 'artefact_not_found') {
        return reply.status(404).send({
          error: 'artefact_not_found',
          message: `No ${artefact_kind} artefact with that id in this firm`,
          kind: artefact_kind,
          artefact_id,
          requestId: req.id,
        });
      }

      // Zod-parse the payload at the boundary — same rationale as the
      // other A-swimlane routes: a future refactor that drifts the
      // payload shape blows up here (programming error) rather than
      // landing a malformed event on the chain.
      const linkedPayload = ArtefactLinkedPayload.parse({
        activity_id,
        artefact_kind,
        artefact_id,
        ...(link_reason !== undefined ? { link_reason } : {}),
      });
      const inserted = await insertEventWithChain({
        tenant_id: tenantId,
        subject_tenant_id: guard.subject_tenant_id,
        project_id: guard.project_id,
        kind: 'ARTEFACT_LINKED',
        payload: linkedPayload,
        classification: null,
        captured_at: new Date(),
        captured_by_user_id: userId,
        override_of_event_id: null,
        override_new_kind: null,
        override_reason: null,
      });

      return reply.status(201).send({
        event_id: inserted.id,
        activity_id,
        artefact_kind,
        artefact_id,
        link_reason: link_reason ?? null,
      });
    },
  );

  // ---------------------------------------------------------------------
  // DELETE /v1/activities/:activity_id/artefact-links/:event_id
  // optional body: { reason? }
  // ---------------------------------------------------------------------
  app.delete<{ Params: { activity_id: string; event_id: string } }>(
    '/v1/activities/:activity_id/artefact-links/:event_id',
    { preHandler: requireSession },
    async (req, reply) => {
      const role = req.user!.role;
      if (role !== 'admin' && role !== 'consultant') {
        return reply.status(403).send({
          error: 'forbidden',
          message: 'Admin or consultant role required',
          requestId: req.id,
        });
      }

      // Optional body — same pattern as DELETE /v1/projects/:id (A1).
      // Empty body / no body is fine.
      let reason: string | undefined;
      if (req.body !== undefined && req.body !== null) {
        const parsed = UnlinkArtefactBody.safeParse(req.body);
        if (!parsed.success) {
          return reply.status(400).send({
            error: 'invalid_body',
            message: 'Body, when present, must be { reason?: string } with no extra keys',
            requestId: req.id,
          });
        }
        reason = parsed.data.reason;
      }

      const { activity_id, event_id } = req.params;
      const tenantId = req.user!.tenantId!;
      const userId = req.user!.id;

      // Activity existence + claim-stage gate + linked-event lookup in
      // one tx. Same pattern as POST.
      const guard = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const activityRows = await tx<
          {
            id: string;
            project_id: string;
            subject_tenant_id: string;
            claim_stage: string;
          }[]
        >`
          SELECT a.id, a.project_id,
                 c.stage AS claim_stage,
                 c.subject_tenant_id AS subject_tenant_id
            FROM activity a
            JOIN claim c ON c.id = a.claim_id
           WHERE a.id = ${activity_id}
             AND a.tenant_id = ${tenantId}
        `;
        const activity = activityRows[0];
        if (!activity) return { kind: 'activity_not_found' as const };
        if (activity.claim_stage === 'submitted' || activity.claim_stage === 'audit_defence') {
          return { kind: 'claim_locked' as const, stage: activity.claim_stage };
        }
        return {
          kind: 'ok' as const,
          project_id: activity.project_id,
          subject_tenant_id: activity.subject_tenant_id,
        };
      });

      if (guard.kind === 'activity_not_found') {
        return reply.status(404).send({
          error: 'activity_not_found',
          message: 'No activity with that id in this firm',
          requestId: req.id,
        });
      }
      if (guard.kind === 'claim_locked') {
        return reply.status(409).send({
          error: 'claim_locked',
          message: `Cannot unlink artefacts on a claim in stage "${guard.stage}"`,
          requestId: req.id,
        });
      }

      // Look up the original LINKED event (must be for this activity AND
      // not already unlinked). The helper folds LINKED/UNLINKED for the
      // activity and returns null if `event_id` isn't currently live.
      const linked = await findLinkedEventForActivity(event_id, activity_id, { tenantId });
      if (!linked) {
        // Disambiguate: not found vs. already unlinked. We do a second
        // existence check with kind='ARTEFACT_LINKED' but no liveness
        // requirement — distinguishing 404 from 409 in the error gives
        // the consultant portal a clearer signal (already-unlinked is a
        // recoverable race; truly-missing is a stale URL).
        //
        // Disambiguation read goes through `sql.begin` + `set_config`
        // because the `event_tenant_isolation` policy in
        // `migrations/0006_fair_network.sql` does NOT `NULLIF(..., '')`
        // the GUC (unlike `subject_tenant`'s policy which was fixed in
        // 0003). A bare `sql<>` template here would inherit whatever
        // `app.current_tenant_id` the pool connection happens to have —
        // and if that's unset/empty, the policy's `tenant_id = current_setting(...)::uuid`
        // throws `invalid input syntax for type uuid: ""`, surfacing as
        // a 500 instead of the intended 404/409. The session-level
        // `set_config(..., false)` from auth middleware is connection-
        // specific and doesn't always propagate across pool checkouts.
        // No cross-tenant leak is possible (the explicit
        // `AND tenant_id = ${tenantId}` filters anyway), but the wrong
        // status code breaks optimistic-UI retry logic on the portal.
        const existsRows = await sql.begin(async (tx) => {
          await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
          return tx<{ id: string }[]>`
            SELECT id FROM event
             WHERE id = ${event_id}
               AND kind = 'ARTEFACT_LINKED'
               AND payload ->> 'activity_id' = ${activity_id}
               AND tenant_id = ${tenantId}
          `;
        });
        if (existsRows.length === 0) {
          return reply.status(404).send({
            error: 'linked_event_not_found',
            message: 'No ARTEFACT_LINKED event with that id for this activity in this firm',
            requestId: req.id,
          });
        }
        return reply.status(409).send({
          error: 'already_unlinked',
          message: 'Artefact has already been unlinked from this activity',
          requestId: req.id,
        });
      }

      // Write ARTEFACT_UNLINKED carrying the same (activity, artefact)
      // tuple as the original LINKED event. Append-only — the LINKED
      // event itself is preserved.
      const unlinkedPayload = ArtefactUnlinkedPayload.parse({
        activity_id,
        artefact_kind: linked.artefact_kind,
        artefact_id: linked.artefact_id,
        ...(reason !== undefined ? { reason } : {}),
      });
      const inserted = await insertEventWithChain({
        tenant_id: tenantId,
        subject_tenant_id: guard.subject_tenant_id,
        project_id: guard.project_id,
        kind: 'ARTEFACT_UNLINKED',
        payload: unlinkedPayload,
        classification: null,
        captured_at: new Date(),
        captured_by_user_id: userId,
        override_of_event_id: null,
        override_new_kind: null,
        override_reason: null,
      });

      return reply.status(200).send({
        unlinked_event_id: inserted.id,
        prior_event_id: linked.id,
        activity_id,
        artefact_kind: linked.artefact_kind,
        artefact_id: linked.artefact_id,
      });
    },
  );

  // ---------------------------------------------------------------------
  // GET /v1/activities/:activity_id/artefacts (T-A6 follow-up)
  // Returns the currently-linked artefacts for an activity, materialised
  // from ARTEFACT_LINKED / ARTEFACT_UNLINKED chain events via the
  // `getActivityArtefacts` helper (A4). All authenticated roles can read
  // (admin / consultant / viewer) — same gate as the activity detail
  // route. The A5 activity detail page reads this for its "Linked
  // artefacts" panel; the A6 uncertainty register links to it.
  // ---------------------------------------------------------------------
  app.get<{ Params: { activity_id: string } }>(
    '/v1/activities/:activity_id/artefacts',
    { preHandler: requireSession },
    async (req, reply) => {
      const { activity_id } = req.params;
      const tenantId = req.user!.tenantId!;

      // Verify the activity exists in this firm — same pattern as A4
      // POST/DELETE: RLS + explicit `AND tenant_id = ${tenantId}` for
      // defense-in-depth. Cross-firm activity returns 404 (mirroring
      // A3's GET /v1/activities/:id behaviour).
      const exists = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<{ id: string }[]>`
          SELECT id FROM activity
           WHERE id = ${activity_id}
             AND tenant_id = ${tenantId}
        `;
        return rows[0] != null;
      });
      if (!exists) {
        return reply.status(404).send({
          error: 'activity_not_found',
          message: 'No activity with that id in this firm',
          requestId: req.id,
        });
      }

      // Materialise the live link set. The helper's signature returns
      // ActivityArtefact rows ordered by linked_at ascending (oldest
      // first) — the consultant portal renders the panel in that order.
      const artefacts = await getActivityArtefacts(activity_id, { tenantId });
      return reply.status(200).send({ artefacts });
    },
  );
}
