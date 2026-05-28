/**
 * Claim finalization routes — the tail of the locked workflow
 * (`docs/product/workflow.md` §"The claim lifecycle", steps 4 + 5):
 *
 *   - POST /v1/claims/:id/seal     seal the approved claim to the chain
 *   - POST /v1/claims/:id/finance  hand the sealed claim to financing
 *
 * Both routes:
 *   - require an authenticated session (`requireSession`)
 *   - gate on role ∈ {admin, consultant}; viewer → 403 (mirrors
 *     claim-workflow.ts / claims.ts mutation gating)
 *   - validate `:id` is a UUID before any SQL
 *   - set `app.current_tenant_id` GUC inside `sql.begin` so RLS attaches
 *   - persist workflow_state via the double-cast `::text::jsonb` idiom
 *     (the established codebase pattern — see audit-log.ts JSDoc)
 *
 * No DB migration: the seal + financing markers ride on the existing
 * `claim.workflow_state` jsonb (migration 0081) and the existing
 * append-only `event` chain. SEAL appends ONE chain block via the
 * existing `insertEventWithChain` primitive — reusing the existing
 * `CLAIM_STAGE_ADVANCED` event kind (advancing the claim into the
 * terminal-pre-submission `review` stage), which both lands the
 * immutable block AND moves the claim stage to a sealed state, exactly
 * as the contract permits ("…and/or claim stage to a sealed state").
 * No new `event_kind` was added (that would force a CHECK-rebuild
 * migration + three-way enum parity, which we deliberately avoid).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '@cpa/db/client';
import { insertEventWithChain } from '@cpa/db';
import { requireSession } from '@cpa/auth';
import { ClaimStageAdvancedPayload, WorkflowState } from '@cpa/schemas';

const Uuid = z.string().uuid();

/**
 * The claim stage a successful seal advances to. `review` is the
 * terminal pre-submission stage in `CLAIM_STAGES` — there is no distinct
 * "sealed" stage value, and adding one would require a migration. The
 * authoritative "is sealed" signal is `workflow_state.sealed_at`; the
 * stage advance is a secondary, audit-visible side effect.
 */
const SEALED_STAGE = 'review' as const;

export function registerClaimFinalize(app: FastifyInstance): void {
  // ---------------------------------------------------------------------------
  // POST /v1/claims/:id/seal
  //
  // Precondition: ALL wizard steps approved (steps['1'..'5'] all non-null in
  // workflow_state). If not → 409 not_approved.
  //
  // Action: append a chain block sealing the claim (insertEventWithChain),
  // then write workflow_state.sealed_at + seal_block_id (double-cast jsonb)
  // and advance claim stage to the sealed state.
  //
  // Idempotent: re-sealing an already-sealed claim returns the existing
  // seal (200) — no second chain block is appended.
  // ---------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/v1/claims/:id/seal',
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
      const claimId = req.params.id;
      if (!Uuid.safeParse(claimId).success) {
        return reply.status(400).send({
          error: 'invalid_claim_id',
          message: 'claim id must be a uuid',
          requestId: req.id,
        });
      }

      // Phase 1: load + validate. Inside RLS scope so cross-firm claims are
      // invisible (→ not_found). Returns the parsed state + subject_tenant_id
      // (needed for the chain append) and the current stage.
      type LoadResult =
        | { kind: 'not_found' }
        | { kind: 'not_wizard' }
        | { kind: 'not_approved' }
        | { kind: 'already_sealed'; sealed_at: string; seal_block_id: string }
        | {
            kind: 'ready';
            state: WorkflowState;
            subjectTenantId: string;
          };

      const loaded: LoadResult = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<{ workflow_state: unknown; subject_tenant_id: string }[]>`
          SELECT workflow_state, subject_tenant_id FROM claim
           WHERE id = ${claimId} AND tenant_id = ${tenantId}
           LIMIT 1
        `;
        if (rows.length === 0) return { kind: 'not_found' };
        const parsed = WorkflowState.safeParse(rows[0]!.workflow_state);
        if (!parsed.success) return { kind: 'not_wizard' };
        const state = parsed.data;

        // Idempotency: already sealed → return the existing seal. (seal_block_id
        // is always written alongside sealed_at, but tolerate a missing block id
        // defensively rather than 500.)
        if (state.sealed_at) {
          return {
            kind: 'already_sealed',
            sealed_at: state.sealed_at,
            seal_block_id: state.seal_block_id ?? '',
          };
        }

        // Precondition: every wizard step must be approved (agreed).
        const allApproved = (['1', '2', '3', '4', '5'] as const).every(
          (k) => state.steps[k] !== null,
        );
        if (!allApproved) return { kind: 'not_approved' };

        return { kind: 'ready', state, subjectTenantId: rows[0]!.subject_tenant_id };
      });

      if (loaded.kind === 'not_found') {
        return reply.status(404).send({
          error: 'claim_not_found',
          message: 'No claim with that id in this firm',
          requestId: req.id,
        });
      }
      if (loaded.kind === 'not_wizard') {
        return reply.status(400).send({
          error: 'not_a_wizard_claim',
          message: 'Claim has no workflow_state; initialize the wizard first.',
          requestId: req.id,
        });
      }
      if (loaded.kind === 'not_approved') {
        return reply.status(409).send({
          error: 'not_approved',
          message: 'All steps must be approved before sealing.',
          requestId: req.id,
        });
      }
      if (loaded.kind === 'already_sealed') {
        return reply.status(200).send({
          ok: true,
          sealed_at: loaded.sealed_at,
          block_id: loaded.seal_block_id,
        });
      }

      // Phase 2: append the sealing chain block. insertEventWithChain opens
      // its own per-subject_tenant advisory-locked transaction. We reuse the
      // existing CLAIM_STAGE_ADVANCED kind so no new event_kind / migration is
      // needed; the block records the from→to stage transition.
      const advancedPayload = ClaimStageAdvancedPayload.parse({
        claim_id: claimId,
        from_stage: 'engagement', // descriptive only; the authoritative seal
        to_stage: SEALED_STAGE, // signal is workflow_state.sealed_at below.
        advanced_by_user_id: userId,
      });
      const block = await insertEventWithChain({
        tenant_id: tenantId,
        subject_tenant_id: loaded.subjectTenantId,
        project_id: null,
        kind: 'CLAIM_STAGE_ADVANCED',
        payload: advancedPayload,
        classification: null,
        captured_at: new Date(),
        captured_by_user_id: userId,
        override_of_event_id: null,
        override_new_kind: null,
        override_reason: null,
      });

      const sealedAt = new Date().toISOString();
      const nextState: WorkflowState = {
        ...loaded.state,
        sealed_at: sealedAt,
        seal_block_id: block.id,
      };

      // Phase 3: persist sealed_at + seal_block_id + advance stage. The
      // `workflow_state->>'sealed_at' IS NULL` guard makes the write idempotent
      // under a concurrent double-seal: only the first writer's UPDATE matches.
      const updated = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<{ id: string }[]>`
          UPDATE claim
             SET workflow_state = ${JSON.stringify(nextState)}::text::jsonb,
                 stage          = ${SEALED_STAGE},
                 updated_at     = NOW()
           WHERE id = ${claimId}
             AND tenant_id = ${tenantId}
             AND (workflow_state ->> 'sealed_at') IS NULL
           RETURNING id
        `;
        return rows.length > 0;
      });

      if (!updated) {
        // A concurrent request sealed first. Re-read and return the winner's
        // seal so the response stays idempotent (no duplicate-block error).
        const existing = await sql.begin(async (tx) => {
          await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
          const rows = await tx<{ workflow_state: unknown }[]>`
            SELECT workflow_state FROM claim
             WHERE id = ${claimId} AND tenant_id = ${tenantId}
             LIMIT 1
          `;
          const parsed = WorkflowState.safeParse(rows[0]?.workflow_state);
          return parsed.success ? parsed.data : null;
        });
        if (existing?.sealed_at) {
          return reply.status(200).send({
            ok: true,
            sealed_at: existing.sealed_at,
            block_id: existing.seal_block_id ?? '',
          });
        }
        // Shouldn't happen — the row exists (loaded above) and we just lost the
        // guard race, so sealed_at should be set. Fall through to our own seal.
      }

      return reply.status(200).send({
        ok: true,
        sealed_at: sealedAt,
        block_id: block.id,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/claims/:id/finance
  //
  // Precondition: claim is sealed (workflow_state.sealed_at present). If not
  // → 409 not_sealed.
  //
  // Action: set workflow_state.financing = { status:'requested', requested_at }
  // (double-cast jsonb). Internal handoff/status marker only — no external
  // financier integration.
  //
  // Idempotent: re-requesting returns the existing financing marker (the
  // requested_at is preserved, not bumped).
  // ---------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/v1/claims/:id/finance',
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
      const claimId = req.params.id;
      if (!Uuid.safeParse(claimId).success) {
        return reply.status(400).send({
          error: 'invalid_claim_id',
          message: 'claim id must be a uuid',
          requestId: req.id,
        });
      }

      type FinanceResult =
        | { kind: 'not_found' }
        | { kind: 'not_wizard' }
        | { kind: 'not_sealed' }
        | { kind: 'ok'; status: 'requested'; requested_at: string };

      const result: FinanceResult = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<{ workflow_state: unknown }[]>`
          SELECT workflow_state FROM claim
           WHERE id = ${claimId} AND tenant_id = ${tenantId}
           LIMIT 1
        `;
        if (rows.length === 0) return { kind: 'not_found' };
        const parsed = WorkflowState.safeParse(rows[0]!.workflow_state);
        if (!parsed.success) return { kind: 'not_wizard' };
        const state = parsed.data;

        // Precondition: the claim must be sealed before financing.
        if (!state.sealed_at) return { kind: 'not_sealed' };

        // Idempotent: preserve an existing financing marker's requested_at.
        if (state.financing) {
          return {
            kind: 'ok',
            status: state.financing.status,
            requested_at: state.financing.requested_at,
          };
        }

        const requestedAt = new Date().toISOString();
        const nextState: WorkflowState = {
          ...state,
          financing: { status: 'requested', requested_at: requestedAt },
        };
        await tx`
          UPDATE claim
             SET workflow_state = ${JSON.stringify(nextState)}::text::jsonb,
                 updated_at     = NOW()
           WHERE id = ${claimId} AND tenant_id = ${tenantId}
        `;
        return { kind: 'ok', status: 'requested', requested_at: requestedAt };
      });

      if (result.kind === 'not_found') {
        return reply.status(404).send({
          error: 'claim_not_found',
          message: 'No claim with that id in this firm',
          requestId: req.id,
        });
      }
      if (result.kind === 'not_wizard') {
        return reply.status(400).send({
          error: 'not_a_wizard_claim',
          message: 'Claim has no workflow_state; initialize the wizard first.',
          requestId: req.id,
        });
      }
      if (result.kind === 'not_sealed') {
        return reply.status(409).send({
          error: 'not_sealed',
          message: 'Seal the claim before financing.',
          requestId: req.id,
        });
      }

      return reply.status(200).send({
        ok: true,
        financing: { status: result.status, requested_at: result.requested_at },
      });
    },
  );
}
