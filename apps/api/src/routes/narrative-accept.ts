/**
 * Per-section narrative accept (wizard Step 4 "Agree per section"):
 *
 *   POST /v1/claims/:claim_id/narrative/sections/:section_kind/accept
 *
 * The consultant has reviewed an AI-drafted section across the claim and
 * signs off. Marks `narrative_draft.status = 'accepted'` for ALL drafts of
 * the named `section_kind` under any activity in the claim. Claim-scoped
 * (not activity-scoped) so the semantics match the workflow snapshot
 * counter in `../lib/workflow.ts` — that counter does:
 *
 *   SELECT COUNT(DISTINCT nd.section_kind)::text AS accepted
 *     FROM narrative_draft nd JOIN activity a ON a.id = nd.activity_id
 *    WHERE nd.tenant_id = $tenantId
 *      AND a.claim_id   = $claimId
 *      AND nd.status    = 'accepted'
 *
 * so the gate counts distinct section_kind across the claim. Accepting
 * one section here flips every contributing activity's row for that
 * section_kind to 'accepted'; the next `GET /workflow` re-derives
 * `canAdvance(4)` from the snapshot.
 *
 * Status transitions are narrow on purpose:
 *   - 'complete' → 'accepted'           ← happy path
 *   - 'accepted' → 'accepted' (no-op)   ← idempotent re-accept, count=0
 *   - 'streaming' → untouched           ← never flip a draft mid-stream
 *   - 'archived' → untouched            ← respect the supersede flag
 *
 * Idempotency: the route is safe to call twice. Second call returns 200
 * with `accepted_count: 0`, `accepted_at: null`, `activity_ids: []`.
 *
 * **No chain event** is emitted on this branch — the audit_log decision
 * for narrative-section-acceptance is deferred per the I-4 follow-up.
 * The status flip in the live `narrative_draft` row is the durable
 * record; `workflow.ts:loadWorkflowSnapshot` reads it directly.
 *
 * Auth + role gate mirror `claim-workflow.ts`:
 *   - `requireSession` preHandler (401 if missing)
 *   - admin or consultant only; viewer → 403
 *
 * RLS: `sql.begin` opens a transaction and sets the
 * `app.current_tenant_id` GUC; the existence probe + UPDATE both run
 * under that policy.
 */

import type { FastifyInstance } from 'fastify';
import { sql } from '@cpa/db/client';
import { requireSession } from '@cpa/auth';
import { Uuid } from '@cpa/schemas';
import { NARRATIVE_SECTION_KINDS, type NarrativeSectionKind } from '@cpa/db/schema';

const isValidSectionKind = (s: string): s is NarrativeSectionKind =>
  (NARRATIVE_SECTION_KINDS as readonly string[]).includes(s);

export function registerNarrativeAccept(app: FastifyInstance): void {
  app.post<{
    Params: { claim_id: string; section_kind: string };
  }>(
    '/v1/claims/:claim_id/narrative/sections/:section_kind/accept',
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

      const tenantId = req.user!.tenantId!;
      const userId = req.user!.id;
      const claimId = req.params.claim_id;
      const sectionKindParam = req.params.section_kind;

      if (!Uuid.safeParse(claimId).success) {
        return reply.status(400).send({
          error: 'invalid_claim_id',
          message: 'claim id must be a uuid',
          requestId: req.id,
        });
      }

      if (!isValidSectionKind(sectionKindParam)) {
        return reply.status(400).send({
          error: 'invalid_section_kind',
          message: `section_kind must be one of: ${NARRATIVE_SECTION_KINDS.join(', ')}`,
          requestId: req.id,
        });
      }
      const sectionKind: NarrativeSectionKind = sectionKindParam;

      type AcceptResult =
        | { kind: 'not_found' }
        | { kind: 'ok'; updated: Array<{ id: string; activity_id: string }> };

      const result: AcceptResult = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;

        // Verify the claim exists in this tenant. RLS additionally
        // protects the row from cross-firm visibility, so a cross-firm
        // caller sees this as "not found" — never 403.
        const claimRows = await tx<{ id: string }[]>`
          SELECT id FROM claim
           WHERE id = ${claimId}
             AND tenant_id = ${tenantId}
           LIMIT 1
        `;
        if (claimRows.length === 0) return { kind: 'not_found' };

        // Only flip rows currently 'complete'. Idempotent re-call: rows
        // already 'accepted' aren't re-updated (count=0 on the second
        // call). Excluding 'streaming' protects a draft that's mid-emit;
        // excluding 'archived' respects the supersede flag — a regen
        // that archived an older draft shouldn't be silently
        // un-archived. The `RETURNING` set drives the response body.
        const updated = await tx<{ id: string; activity_id: string }[]>`
          UPDATE narrative_draft
             SET status = 'accepted',
                 updated_at = NOW()
           WHERE tenant_id = ${tenantId}
             AND section_kind = ${sectionKind}
             AND activity_id IN (
               SELECT id FROM activity
                WHERE claim_id = ${claimId}
                  AND tenant_id = ${tenantId}
             )
             AND status = 'complete'
          RETURNING id, activity_id
        `;
        return { kind: 'ok', updated };
      });

      if (result.kind === 'not_found') {
        return reply.status(404).send({
          error: 'claim_not_found',
          message: 'No claim with that id in this firm',
          requestId: req.id,
        });
      }

      const acceptedCount = result.updated.length;
      const acceptedAt = acceptedCount > 0 ? new Date().toISOString() : null;
      const activityIds =
        acceptedCount > 0 ? Array.from(new Set(result.updated.map((r) => r.activity_id))) : [];

      return reply.status(200).send({
        accepted_count: acceptedCount,
        accepted_at: acceptedAt,
        accepted_by: userId,
        activity_ids: activityIds,
      });
    },
  );
}
