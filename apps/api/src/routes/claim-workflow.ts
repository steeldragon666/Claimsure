/**
 * Claim-wizard workflow routes (Tasks 2.2–2.5 of the claim-wizard plan):
 *
 *   - POST /v1/claims/:id/workflow/initialize    set workflow_state.initialized_at
 *   - POST /v1/claims/:id/workflow/step/:n/agree write {agreed_at, agreed_by}
 *                                                 (gated by canAdvance)
 *   - POST /v1/claims/:id/workflow/step/:n/reopen clear a step's agreed_at
 *                                                  (no cascade — Q5.b)
 *   - GET  /v1/claims/:id/workflow                state + derived.canAdvance
 *
 * All routes:
 *   - require an authenticated session (`requireSession`)
 *   - gate on role ∈ {admin, consultant}; viewer → 403
 *   - validate `:id` is a UUID before any SQL
 *   - set `app.current_tenant_id` GUC inside `sql.begin` so RLS attaches
 *   - persist workflow_state via the double-cast `::text::jsonb` idiom
 *     (single-cast was a P5 chain.ts bug; this is the established fix)
 *
 * Concurrent edits: there is no If-Match / etag gate yet. Two simultaneous
 * agree calls on the same step will both succeed; the later writer wins
 * and overwrites the agreed_at with its own timestamp. Optimistic locking
 * is a future task — TODO is parked at the foot of this file.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '@cpa/db/client';
import { requireSession } from '@cpa/auth';
import { WorkflowState, WorkflowStepNumber } from '@cpa/schemas';
import {
  applyAgree,
  applyReopen,
  canAdvance,
  initialWorkflowState,
  loadWorkflowSnapshot,
  type NarrativeSectionMap,
  type SqlClient,
} from '../lib/workflow.js';
import { getBoss } from '../lib/pg-boss-client.js';
import { CLAIM_ACTIVITY_PROPOSAL_QUEUE } from '../jobs/claim-activity-proposal.js';
import { CLAIM_EVIDENCE_BINDING_QUEUE } from '../jobs/claim-evidence-binding.js';

const Uuid = z.string().uuid();
// `:n` arrives as a string from the URL; coerce → number → 1..5 union.
// z.coerce.number() rejects 'abc' (NaN), and the chained int().min(1).max(5)
// rejects values outside the wizard's step range.
const StepParam = z.coerce.number().pipe(WorkflowStepNumber);

type Step = 1 | 2 | 3 | 4 | 5;

export function registerClaimWorkflow(app: FastifyInstance): void {
  // ---------------------------------------------------------------------------
  // POST /v1/claims/:id/workflow/initialize
  //
  // First-time wizard activation. Sets `workflow_state.initialized_at` (now)
  // and `steps['1'..'5']` to null. Idempotent at the "fresh claim" boundary:
  // a second call against a claim that already has workflow_state set returns
  // 409 (the wizard never overwrites an existing run).
  //
  // The same 409 surface conflates "claim does not exist in this firm" with
  // "claim already initialized" — both are blocked by the same UPDATE
  // predicate (`workflow_state IS NULL AND tenant_id = ${tenantId}`). RLS
  // additionally protects the row from cross-firm visibility. Distinguishing
  // the two cases would require a separate SELECT, which leaks claim
  // existence across firms — leave them merged.
  // ---------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/v1/claims/:id/workflow/initialize',
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

      const next = initialWorkflowState(new Date().toISOString());
      const rows = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        return await tx<{ id: string }[]>`
          UPDATE claim
             SET workflow_state = ${JSON.stringify(next)}::text::jsonb,
                 updated_at     = NOW()
           WHERE id = ${claimId}
             AND tenant_id = ${tenantId}
             AND workflow_state IS NULL
           RETURNING id
        `;
      });
      if (rows.length === 0) {
        return reply.status(409).send({
          error: 'already_initialized_or_not_found',
          message: 'Claim already has workflow_state or does not exist in this firm.',
          requestId: req.id,
        });
      }
      // "Prepare claim" kicks off the AI authoring pipeline (workflow.md):
      // the proposal job classifies the claim's evidence and drafts the
      // Core / Supporting activity register, whose output the consultant
      // then judges in step 2. Runs OUTSIDE the sql.begin transaction (the
      // workflow_state write has committed); pg-boss picks it up async.
      // singletonKey=claimId dedupes a double-trigger; the 30-min expiry
      // matches the step-1-agree enqueue below (Sonnet latency headroom).
      // Non-fatal on failure: the route still returns 200 so the consultant
      // sees the claim prepared; the job re-triggers on a step-1 agree.
      try {
        const boss = await getBoss();
        await boss.send(
          CLAIM_ACTIVITY_PROPOSAL_QUEUE,
          { claim_id: claimId, tenant_id: tenantId },
          { singletonKey: claimId, expireInSeconds: 30 * 60 },
        );
      } catch (err) {
        req.log.error(err, 'claim-activity-proposal enqueue on prepare-claim failed');
      }
      return reply.status(200).send({ workflow_state: next });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/claims/:id/workflow/step/:n/agree
  //
  // Records `{agreed_at, agreed_by}` on step `n` after gate-checking
  // `canAdvance(n, snapshot)`. Re-agreeing an already-agreed step overwrites
  // the timestamp — the reducer keeps this simple, and per Q5.b the wizard
  // uses re-agreement as the consultant's "data changed since last agreed"
  // refresh action.
  //
  // Step 5 NOTE: canAdvance(5, ...) returns `{ ok: false, reason: 'terminal' }`
  // by design (no step 6 to advance to). This route follows the spec literally
  // and gates step-5 agree on canAdvance, which means step 5 currently 409s.
  // That semantics is open — the user flagged it as a question. If we decide
  // step-5 "agree" means "documents generated" and should always succeed,
  // the fix is to special-case `step === 5` here. Leaving as-spec for now.
  //
  // pg-boss enqueue (Phase 3): downstream tasks 3.1 and 3.2 will enqueue
  // claim-activity-proposal / claim-evidence-binding jobs on agree. Those
  // tasks haven't shipped — see TODO below.
  // ---------------------------------------------------------------------------
  app.post<{ Params: { id: string; n: string } }>(
    '/v1/claims/:id/workflow/step/:n/agree',
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
      const stepParsed = StepParam.safeParse(req.params.n);
      if (!stepParsed.success) {
        return reply.status(400).send({
          error: 'invalid_step',
          message: 'step must be an integer 1..5',
          requestId: req.id,
        });
      }
      const step = stepParsed.data as Step;

      type AgreeResult =
        | { kind: 'not_found' }
        | { kind: 'not_wizard' }
        | { kind: 'cannot_advance'; reason: string }
        | { kind: 'ok'; state: WorkflowState };

      const result: AgreeResult = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<{ workflow_state: unknown }[]>`
          SELECT workflow_state FROM claim
           WHERE id = ${claimId} AND tenant_id = ${tenantId}
           LIMIT 1
        `;
        if (rows.length === 0) return { kind: 'not_found' };
        const parsed = WorkflowState.safeParse(rows[0]!.workflow_state);
        if (!parsed.success) return { kind: 'not_wizard' };
        // postgres-js's TransactionSql carries a helper-form overload that
        // structurally clashes with our narrow SqlClient type; cast through
        // unknown — the runtime contract (tagged-template returns thenable)
        // is exactly what loadWorkflowSnapshot exercises. See SqlClient docs.
        const snapshot = await loadWorkflowSnapshot(tx as unknown as SqlClient, tenantId, claimId);
        const advance = canAdvance(step, snapshot);
        if (!advance.ok) return { kind: 'cannot_advance', reason: advance.reason };
        const next = applyAgree(parsed.data, step, userId, new Date().toISOString());
        await tx`
          UPDATE claim
             SET workflow_state = ${JSON.stringify(next)}::text::jsonb,
                 updated_at     = NOW()
           WHERE id = ${claimId} AND tenant_id = ${tenantId}
        `;
        return { kind: 'ok', state: next };
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
          message: 'POST /workflow/initialize first.',
          requestId: req.id,
        });
      }
      if (result.kind === 'cannot_advance') {
        return reply.status(409).send({
          error: 'cannot_advance',
          message: result.reason,
          requestId: req.id,
        });
      }
      // Enqueue the claim-activity-proposal job on step-1 agree (Task 3.1).
      // Runs OUTSIDE the sql.begin transaction — the DB write has already
      // committed at this point; pg-boss picks it up asynchronously.
      // singletonKey prevents duplicate jobs if the consultant clicks Agree twice.
      // expireInSeconds overrides pg-boss's default expiration: Sonnet calls
      // can take 30-60s in normal cases, and a backed-up queue + a slow
      // upstream (Anthropic latency spike, DB contention) can stack up.
      // 30min leaves comfortable headroom without letting a truly stuck job
      // linger forever.
      if (step === 1) {
        try {
          const boss = await getBoss();
          await boss.send(
            CLAIM_ACTIVITY_PROPOSAL_QUEUE,
            { claim_id: claimId, tenant_id: tenantId },
            { singletonKey: claimId, expireInSeconds: 30 * 60 },
          );
        } catch (err) {
          // Non-fatal: log and continue. The route must return 200 so the
          // consultant sees the agree succeed; the job will be retried or
          // re-triggered on the next agree.
          req.log.error(err, 'claim-activity-proposal enqueue failed');
        }
      }
      // Enqueue the claim-evidence-binding job on step-2 agree (Task 3.2).
      // Same pattern as step-1 above: runs OUTSIDE the sql.begin transaction,
      // singletonKey prevents duplicate jobs on double-click.
      // expireInSeconds: 30min — see step-1 comment. The binding job iterates
      // N events through Haiku, so its worst-case wall time scales with the
      // event count; 30min is conservative for typical claim sizes.
      if (step === 2) {
        try {
          const boss = await getBoss();
          await boss.send(
            CLAIM_EVIDENCE_BINDING_QUEUE,
            { claim_id: claimId, tenant_id: tenantId },
            { singletonKey: claimId, expireInSeconds: 30 * 60 },
          );
        } catch (err) {
          // Non-fatal: log and continue. The route must return 200 so the
          // consultant sees the agree succeed; the job will be retried or
          // re-triggered on the next agree.
          req.log.error(err, 'claim-evidence-binding enqueue failed');
        }
      }
      return reply.status(200).send({ workflow_state: result.state });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/claims/:id/workflow/step/:n/reopen
  //
  // Soft un-agree: clears `steps[n]` back to null. No cascade — downstream
  // steps keep their agreed_at; the wizard UI surfaces a "data changed since
  // you last agreed" banner instead (Q5.b in the design doc).
  //
  // Idempotent: reopening an already-null step is a no-op + 200.
  // ---------------------------------------------------------------------------
  app.post<{ Params: { id: string; n: string } }>(
    '/v1/claims/:id/workflow/step/:n/reopen',
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
      const stepParsed = StepParam.safeParse(req.params.n);
      if (!stepParsed.success) {
        return reply.status(400).send({
          error: 'invalid_step',
          message: 'step must be an integer 1..5',
          requestId: req.id,
        });
      }
      const step = stepParsed.data as Step;

      type ReopenResult =
        | { kind: 'not_found' }
        | { kind: 'not_wizard' }
        | { kind: 'ok'; state: WorkflowState };

      const result: ReopenResult = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<{ workflow_state: unknown }[]>`
          SELECT workflow_state FROM claim
           WHERE id = ${claimId} AND tenant_id = ${tenantId}
           LIMIT 1
        `;
        if (rows.length === 0) return { kind: 'not_found' };
        const parsed = WorkflowState.safeParse(rows[0]!.workflow_state);
        if (!parsed.success) return { kind: 'not_wizard' };
        const next = applyReopen(parsed.data, step);
        await tx`
          UPDATE claim
             SET workflow_state = ${JSON.stringify(next)}::text::jsonb,
                 updated_at     = NOW()
           WHERE id = ${claimId} AND tenant_id = ${tenantId}
        `;
        return { kind: 'ok', state: next };
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
          message: 'POST /workflow/initialize first.',
          requestId: req.id,
        });
      }
      return reply.status(200).send({ workflow_state: result.state });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/claims/:id/workflow
  //
  // Returns the stored `workflow_state` plus `derived.canAdvance` computed
  // fresh from current claim data for each step 1..5. Per Q5.b, canAdvance
  // is always live-derived — editing prior-step evidence can flip a later
  // step's gate from ok=true back to ok=false (the wizard renders this as
  // a "data changed since you last agreed" banner).
  // ---------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/v1/claims/:id/workflow',
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

      type CanAdvanceMap = Record<'1' | '2' | '3' | '4' | '5', ReturnType<typeof canAdvance>>;
      type DerivedShape = {
        canAdvance: CanAdvanceMap;
        narrativeSections: NarrativeSectionMap;
      };
      type GetResult =
        | { kind: 'not_found' }
        | { kind: 'not_wizard' }
        | { kind: 'ok'; state: WorkflowState; derived: DerivedShape };

      const result: GetResult = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<{ workflow_state: unknown }[]>`
          SELECT workflow_state FROM claim
           WHERE id = ${claimId} AND tenant_id = ${tenantId}
           LIMIT 1
        `;
        if (rows.length === 0) return { kind: 'not_found' };
        const parsed = WorkflowState.safeParse(rows[0]!.workflow_state);
        if (!parsed.success) return { kind: 'not_wizard' };
        // See cast rationale in the agree route above.
        const snap = await loadWorkflowSnapshot(tx as unknown as SqlClient, tenantId, claimId);
        const advance: CanAdvanceMap = {
          '1': canAdvance(1, snap),
          '2': canAdvance(2, snap),
          '3': canAdvance(3, snap),
          '4': canAdvance(4, snap),
          '5': canAdvance(5, snap),
        };
        return {
          kind: 'ok',
          state: parsed.data,
          derived: {
            canAdvance: advance,
            narrativeSections: snap.narrativeSections,
          },
        };
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
          message: 'Claim has no workflow_state; this is a legacy (tabbed-view) claim.',
          requestId: req.id,
        });
      }
      return reply.status(200).send({
        workflow_state: result.state,
        derived: result.derived,
      });
    },
  );

  // TODO(claim-wizard-concurrency): add If-Match / etag handling so two
  // simultaneous agree calls on the same step can be ordered safely.
  // Today the later writer silently wins. Low-stakes (agree is idempotent
  // wrt the {agreed_at, agreed_by} shape — only the timestamp drifts) but
  // worth tightening once the wizard ships to multiple consultants per claim.
}
