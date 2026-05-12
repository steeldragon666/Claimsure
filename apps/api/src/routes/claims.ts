import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';
import { z } from 'zod';
import { requireSession } from '@cpa/auth';
import { sql } from '@cpa/db/client';
import { insertEventWithChain } from '@cpa/db';
import {
  ClaimStageAdvancedPayload,
  ClaimSubmittedPayload,
  CreateClaimBody,
  DeliveryKindEnum,
  ListClaimsQuery,
  UpdateClaimBody,
  UpdateClaimStageBody,
  type Claim,
  type ClaimStage,
} from '@cpa/schemas';
import { validateStageTransition } from '../lib/claim-stage.js';
import { emitClaimUsageRecord } from '../jobs/emit-claim-usage-record.js';
import { getBoss } from '../lib/pg-boss-client.js';
import {
  CLAIM_FINALISATION_JOB_NAME,
  type ClaimFinalisationJobInput,
} from '../jobs/claim-finalisation.js';
import { initialWorkflowState } from '../lib/workflow.js';

export interface ClaimsRouteDeps {
  stripe?: Stripe;
}

// TODO(p4-a-cleanup): post-A1 review-flagged refactors deferred to a separate
// cross-cutting task after the swimlanes merge — same items affect this file:
//
//   1. PATCH SET-list template fragments use implicit trailing-comma discipline
//      that's fragile to add new fields. Refactor to a `setIfDefined` helper
//      that builds the SET clause from a definition list.
//      See: A1 quality review 2026-04-28, Important #1.
//
//   2. Event-write (`insertEventWithChain`) runs AFTER the row-mutation
//      transaction commits. On a chain-write failure between the two awaits,
//      the row is mutated but no event lands — chain becomes inconsistent
//      with canonical state. Fix: extend `insertEventWithChain` to accept an
//      optional `tx` parameter so callers compose row+event in one tx.
//      Affects all routes that emit chain events.
//      See: A1 quality review 2026-04-28, Important #3.
//
// TODO(p4-a-claim-assignee): GET /v1/claims accepts `assignee` query param
// for forward compat with the eventual claim_assignee table; the filter is
// currently a no-op (the table doesn't exist yet). Remove the no-op when the
// assignee table lands. See: T-A2 plan, "assignee filter".

// TODO(p4-a-cleanup): The A2 quality review (2026-04-28) flagged that
// PATCH /:id sets identical-value branches still bump updated_at and run
// the UPDATE; consider short-circuiting in a future task. Lower priority
// since no event pollution.

/**
 * Raw claim row as stored in postgres. Columns are snake_case to match
 * the SQL surface; conversion to the wire format (still snake_case but
 * with ISO-8601 timestamps in place of Date objects) happens in
 * {@link toApi}.
 */
interface RawClaimRow {
  id: string;
  tenant_id: string;
  subject_tenant_id: string;
  fiscal_year: number;
  stage: ClaimStage;
  delivery_kind: string | null;
  platform_fee_charged_at: Date | string | null;
  ausindustry_reference: string | null;
  submitted_at: Date | string | null;
  submitted_by_user_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  is_wizard_claim: boolean;
}

const isoOf = (v: Date | string): string => (typeof v === 'string' ? v : v.toISOString());
const isoOrNull = (v: Date | string | null): string | null => (v === null ? null : isoOf(v));

const toApi = (r: RawClaimRow): Claim => ({
  id: r.id,
  tenant_id: r.tenant_id,
  subject_tenant_id: r.subject_tenant_id,
  fiscal_year: r.fiscal_year,
  stage: r.stage,
  delivery_kind: (r.delivery_kind as Claim['delivery_kind']) ?? null,
  ausindustry_reference: r.ausindustry_reference,
  submitted_at: isoOrNull(r.submitted_at),
  submitted_by_user_id: r.submitted_by_user_id,
  created_at: isoOf(r.created_at),
  updated_at: isoOf(r.updated_at),
  is_wizard_claim: r.is_wizard_claim,
});

/**
 * Register the claim CRUD + stage-advance + submission routes (T-A2 of
 * the P4 plan).
 *
 * Auth: requireSession + admin-or-consultant gating on mutations.
 *   - Viewers can list/detail but cannot create / advance stage / submit.
 *
 * RLS: every read/write inside `sql.begin` sets `app.current_tenant_id`
 * so the `claim_tenant_isolation` policy filters cross-firm rows
 * automatically (added in F2 alongside the claim table).
 *
 * Event chain: stage-advance and submission mutations extend the
 * per-claimant hash chain via `insertEventWithChain` from `@cpa/db`.
 * The helper holds a pg_advisory_xact_lock per-subject_tenant so
 * concurrent mutations on the same chain serialise; mutations on
 * different claimants do not block each other.
 *
 * Note: POST /v1/claims does NOT emit an event — the chain doesn't have
 * a CLAIM_CREATED kind. The first event for a claim is the
 * CLAIM_STAGE_ADVANCED on the first stage transition (per design doc).
 */
export function registerClaims(app: FastifyInstance, deps?: ClaimsRouteDeps): void {
  const { stripe } = deps ?? {};
  // ---------------------------------------------------------------------
  // POST /v1/claims — create a fiscal-year claim row. No event emitted.
  // ---------------------------------------------------------------------
  app.post('/v1/claims', { preHandler: requireSession }, async (req, reply) => {
    const role = req.user!.role;
    if (role !== 'admin' && role !== 'consultant') {
      return reply.status(403).send({
        error: 'forbidden',
        message: 'Admin or consultant role required',
        requestId: req.id,
      });
    }

    const parsed = CreateClaimBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'invalid_body',
        message: 'Body must be { subject_tenant_id, fiscal_year, stage?, ausindustry_reference? }',
        requestId: req.id,
      });
    }
    const { subject_tenant_id, fiscal_year, stage, ausindustry_reference } = parsed.data;
    const tenantId = req.user!.tenantId!;

    // Confirm the subject_tenant is visible under RLS — guards against
    // cross-firm subject_tenant_id (404) or being asked to create under
    // a soft-deleted claimant.
    const subjectVisible = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
      const rows = await tx<{ id: string }[]>`
        SELECT id FROM subject_tenant
         WHERE id = ${subject_tenant_id} AND deleted_at IS NULL
      `;
      return rows[0] != null;
    });
    if (!subjectVisible) {
      return reply.status(404).send({
        error: 'subject_tenant_not_found',
        message: 'No subject_tenant with that id in this firm',
        requestId: req.id,
      });
    }

    // Insert the claim row. Default stage = 'engagement' if not supplied —
    // the DB column also defaults to 'engagement', but we resolve it
    // server-side so the inserted-row response is deterministic.
    //
    // workflow_state is written transactionally as part of the INSERT so
    // every newly-created claim is a wizard claim from the moment it
    // exists — no race between the row landing and the wizard's
    // GET /workflow finding the row but seeing NULL workflow_state (which
    // would 404). Previously a follow-on POST /workflow/initialize ran
    // client-side; that was non-transactional and failed silently if the
    // network blipped (Phase 7.1 race — see Fix 1 in the wizard review).
    const initialState = initialWorkflowState(new Date().toISOString());
    let inserted: RawClaimRow | null;
    try {
      inserted = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<RawClaimRow[]>`
          INSERT INTO claim (
            id, tenant_id, subject_tenant_id, fiscal_year, stage,
            ausindustry_reference, workflow_state
          )
          VALUES (
            ${crypto.randomUUID()}, ${tenantId}, ${subject_tenant_id}, ${fiscal_year},
            ${stage ?? 'engagement'},
            ${ausindustry_reference ?? null},
            ${JSON.stringify(initialState)}::text::jsonb
          )
          RETURNING id, tenant_id, subject_tenant_id, fiscal_year, stage,
                    delivery_kind, platform_fee_charged_at,
                    ausindustry_reference, submitted_at, submitted_by_user_id,
                    created_at, updated_at,
                    (workflow_state IS NOT NULL) AS is_wizard_claim
        `;
        return rows[0] ?? null;
      });
    } catch (err) {
      // UNIQUE (subject_tenant_id, fiscal_year) violation — exactly one
      // claim per claimant per FY (regulator: AusIndustry only accepts
      // one registration per entity per year).
      if ((err as { code?: string }).code === '23505') {
        return reply.status(409).send({
          error: 'duplicate',
          message: `A claim already exists for this claimant and fiscal year ${fiscal_year}`,
          requestId: req.id,
        });
      }
      throw err;
    }
    if (!inserted) {
      throw new Error('POST /v1/claims: INSERT returned no row');
    }

    return reply.status(201).send({ claim: toApi(inserted) });
  });

  // ---------------------------------------------------------------------
  // GET /v1/claims?subject_tenant_id=...&stage=...&assignee=...&fiscal_year=...
  //   — pipeline filter list (RLS filters cross-firm).
  // ---------------------------------------------------------------------
  app.get('/v1/claims', { preHandler: requireSession }, async (req, reply) => {
    const parsed = ListClaimsQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'invalid_query',
        message:
          'Query must match { subject_tenant_id?: uuid, stage?, assignee?: uuid, fiscal_year?: int, project_id?: uuid }',
        requestId: req.id,
      });
    }
    const { subject_tenant_id, stage, fiscal_year, project_id } = parsed.data;
    // assignee: see TODO(p4-a-claim-assignee) at top of file. Param is
    // validated as a UUID but currently filters nothing — the
    // claim_assignee table doesn't exist yet.
    const tenantId = req.user!.tenantId!;

    return await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
      // Tagged template fragments to compose conditional WHERE clauses
      // while keeping every parameter bound. Same shape as F1 (the
      // expenditures list) — postgres-js v3.4.9 splices empty-fragment
      // results in cleanly with no syntax artefacts.
      const whereSubject = subject_tenant_id
        ? tx`AND subject_tenant_id = ${subject_tenant_id}`
        : tx``;
      const whereStage = stage !== undefined ? tx`AND stage = ${stage}` : tx``;
      const whereFiscalYear =
        fiscal_year !== undefined ? tx`AND fiscal_year = ${fiscal_year}` : tx``;
      // Project narrowing uses the denormalised claim.project_id FK
      // (P5 swimlane A Task 1.1). Indexed via claim_project_id_idx,
      // so this is a fast path for the project-detail rollup view.
      const whereProject = project_id !== undefined ? tx`AND project_id = ${project_id}` : tx``;

      const rows = await tx<RawClaimRow[]>`
        SELECT id, tenant_id, subject_tenant_id, fiscal_year, stage,
               delivery_kind, platform_fee_charged_at,
               ausindustry_reference, submitted_at, submitted_by_user_id,
               created_at, updated_at,
               (workflow_state IS NOT NULL) AS is_wizard_claim
          FROM claim
         WHERE 1 = 1
               ${whereSubject}
               ${whereStage}
               ${whereFiscalYear}
               ${whereProject}
         ORDER BY fiscal_year DESC, created_at DESC
      `;
      return { claims: rows.map(toApi) };
    });
  });

  // ---------------------------------------------------------------------
  // GET /v1/claims/:id — detail + counts (admin/consultant/viewer).
  // ---------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/v1/claims/:id',
    { preHandler: requireSession },
    async (req, reply) => {
      const { id } = req.params;
      const tenantId = req.user!.tenantId!;
      return await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<RawClaimRow[]>`
          SELECT id, tenant_id, subject_tenant_id, fiscal_year, stage,
                 delivery_kind, platform_fee_charged_at,
                 ausindustry_reference, submitted_at, submitted_by_user_id,
                 created_at, updated_at,
                 (workflow_state IS NOT NULL) AS is_wizard_claim
            FROM claim
           WHERE id = ${id}
        `;
        const row = rows[0];
        if (!row) {
          return reply.status(404).send({
            error: 'claim_not_found',
            message: 'No claim with that id in this firm',
            requestId: req.id,
          });
        }
        // Activity count for this claim. RLS filters cross-firm rows
        // (activity has the same tenant_id-isolation policy).
        const activityCountRows = await tx<{ n: number | string }[]>`
          SELECT COUNT(*)::int AS n FROM activity WHERE claim_id = ${id}
        `;
        const activity_count = Number(activityCountRows[0]?.n ?? 0);

        // mapped_line_count + total_expenditure: deferred until Swimlane B
        // (expenditure mapping) lands. The expenditure_line table doesn't
        // join to claim directly — it reaches claim via activity_id, which
        // means the count is COUNT(DISTINCT el.id) FROM expenditure_line el
        // JOIN activity a ON a.id = el.activity_id WHERE a.claim_id = $id.
        // Returning 0 here keeps the wire shape stable so the consultant
        // portal pipeline view doesn't have to feature-flag the field.
        // TODO(p4-b-counts): wire mapped_line_count + total_expenditure
        // once expenditure_line + el.activity_id mapping land.
        const mapped_line_count = 0;
        const total_expenditure = 0;

        return {
          claim: toApi(row),
          counts: {
            activity_count,
            mapped_line_count,
            total_expenditure,
          },
        };
      });
    },
  );

  // ---------------------------------------------------------------------
  // PATCH /v1/claims/:id/stage — advance the pipeline stage + emit
  // CLAIM_STAGE_ADVANCED. Auto-stamps submitted_at if to_stage='submitted'.
  // ---------------------------------------------------------------------
  app.patch<{ Params: { id: string } }>(
    '/v1/claims/:id/stage',
    { preHandler: requireSession },
    async (req, reply) => {
      const role = req.user!.role;
      // Mutations require admin/consultant. Viewers fail with 403 before
      // we touch the validateStageTransition helper.
      if (role !== 'admin' && role !== 'consultant') {
        return reply.status(403).send({
          error: 'forbidden',
          message: 'Admin or consultant role required',
          requestId: req.id,
        });
      }

      const parsed = UpdateClaimStageBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'invalid_body',
          message: 'Body must be { to_stage: ClaimStage }',
          requestId: req.id,
        });
      }
      const { to_stage } = parsed.data;
      const { id } = req.params;
      const tenantId = req.user!.tenantId!;
      const userId = req.user!.id;

      // Load the current row + perform the update in one transaction so
      // the {from, to} diff and the submitted_at auto-stamp are computed
      // against the row that's actually being mutated (no read-modify-
      // write race).
      const result = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const before = await tx<RawClaimRow[]>`
          SELECT id, tenant_id, subject_tenant_id, fiscal_year, stage,
                 delivery_kind, platform_fee_charged_at,
                 ausindustry_reference, submitted_at, submitted_by_user_id,
                 created_at, updated_at,
                 (workflow_state IS NOT NULL) AS is_wizard_claim
            FROM claim
           WHERE id = ${id}
             AND tenant_id = ${tenantId}
        `;
        const prev = before[0];
        if (!prev) return { kind: 'not_found' as const };

        const transition = validateStageTransition({
          from: prev.stage,
          to: to_stage,
          role,
        });
        if (!transition.ok) {
          return { kind: 'invalid_transition' as const, reason: transition.reason, prev };
        }

        // Auto-stamp submitted_at when transitioning to 'submitted'. The
        // client can later override via PATCH /v1/claims/:id { submitted_at }.
        // submitted_by_user_id is set in lock-step so the audit trail
        // ties the submission to the consultant who advanced the stage.
        const setSubmitted =
          to_stage === 'submitted'
            ? tx`submitted_at = NOW(), submitted_by_user_id = ${userId},`
            : tx``;

        const updated = await tx<RawClaimRow[]>`
          UPDATE claim
             SET stage = ${to_stage},
                 ${setSubmitted}
                 updated_at = NOW()
           WHERE id = ${id}
             AND tenant_id = ${tenantId}
           RETURNING id, tenant_id, subject_tenant_id, fiscal_year, stage,
                     delivery_kind, platform_fee_charged_at,
                     ausindustry_reference, submitted_at, submitted_by_user_id,
                     created_at, updated_at,
                     (workflow_state IS NOT NULL) AS is_wizard_claim
        `;
        const row = updated[0];
        if (!row) {
          throw new Error('PATCH /v1/claims/:id/stage: UPDATE returned no row');
        }
        return { kind: 'advanced' as const, prev, row };
      });

      if (result.kind === 'not_found') {
        return reply.status(404).send({
          error: 'claim_not_found',
          message: 'No claim with that id in this firm',
          requestId: req.id,
        });
      }
      if (result.kind === 'invalid_transition') {
        // Map the four validateStageTransition failure reasons to HTTP:
        //   invalid_target              → 400 (unknown stage value)
        //   no_op                       → 200 (idempotent — return row, no event)
        //   role_required               → 403 (consultant tried backward)
        //   cannot_revert_from_submitted→ 409 (terminal-stage rule)
        if (result.reason === 'invalid_target') {
          return reply.status(400).send({
            error: 'invalid_target',
            message: 'Unknown target stage',
            requestId: req.id,
          });
        }
        if (result.reason === 'no_op') {
          return reply.status(200).send({ claim: toApi(result.prev) });
        }
        if (result.reason === 'role_required') {
          return reply.status(403).send({
            error: 'forbidden',
            message: 'Backward stage transitions require admin role',
            requestId: req.id,
          });
        }
        // cannot_revert_from_submitted
        return reply.status(409).send({
          error: 'cannot_revert_from_submitted',
          message: 'Submitted claims are terminal — corrections happen via audit_defence',
          requestId: req.id,
        });
      }

      // Validate the payload via Zod before insert — same rationale as
      // projects.ts: a future refactor that drifts the payload shape blows
      // up at the boundary (programming error) rather than landing a
      // malformed event on the chain.
      const advancedPayload = ClaimStageAdvancedPayload.parse({
        claim_id: result.row.id,
        from_stage: result.prev.stage,
        to_stage: result.row.stage,
        advanced_by_user_id: userId,
      });
      await insertEventWithChain({
        tenant_id: tenantId,
        subject_tenant_id: result.row.subject_tenant_id,
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

      return reply.status(200).send({ claim: toApi(result.row) });
    },
  );

  // ---------------------------------------------------------------------
  // PATCH /v1/claims/:id — set ausindustry_reference / submitted_at; emit
  // CLAIM_SUBMITTED when both fields are populated.
  // ---------------------------------------------------------------------
  app.patch<{ Params: { id: string } }>(
    '/v1/claims/:id',
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

      const parsed = UpdateClaimBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'invalid_body',
          message:
            'Body must be a partial { ausindustry_reference?, submitted_at? } with no extra keys',
          requestId: req.id,
        });
      }
      const patch = parsed.data;
      const { id } = req.params;
      const tenantId = req.user!.tenantId!;
      const userId = req.user!.id;

      const patchKeys = Object.keys(patch) as Array<keyof typeof patch>;

      // Load + update in one tx so the stage gate is checked against the
      // row that's actually being mutated.
      const result = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const before = await tx<RawClaimRow[]>`
          SELECT id, tenant_id, subject_tenant_id, fiscal_year, stage,
                 delivery_kind, platform_fee_charged_at,
                 ausindustry_reference, submitted_at, submitted_by_user_id,
                 created_at, updated_at,
                 (workflow_state IS NOT NULL) AS is_wizard_claim
            FROM claim
           WHERE id = ${id}
             AND tenant_id = ${tenantId}
        `;
        const prev = before[0];
        if (!prev) return { kind: 'not_found' as const };
        if (patchKeys.length === 0) {
          return { kind: 'noop' as const, row: prev };
        }

        // Stage gate: ausindustry_reference is the regulator-issued ID,
        // only meaningful once the claim has reached 'submitted' (the
        // regulator returns it on lodgment). Setting it earlier would
        // poison downstream readers that treat it as proof of submission.
        if (patch.ausindustry_reference !== undefined && prev.stage !== 'submitted') {
          return { kind: 'invalid_state' as const };
        }

        const setAusRef =
          patch.ausindustry_reference !== undefined
            ? tx`ausindustry_reference = ${patch.ausindustry_reference},`
            : tx``;
        const setSubmittedAt =
          patch.submitted_at !== undefined
            ? tx`submitted_at = ${patch.submitted_at}::timestamptz,
                 submitted_by_user_id = ${userId},`
            : tx``;

        const updated = await tx<RawClaimRow[]>`
          UPDATE claim
             SET ${setAusRef}
                 ${setSubmittedAt}
                 updated_at = NOW()
           WHERE id = ${id}
             AND tenant_id = ${tenantId}
           RETURNING id, tenant_id, subject_tenant_id, fiscal_year, stage,
                     delivery_kind, platform_fee_charged_at,
                     ausindustry_reference, submitted_at, submitted_by_user_id,
                     created_at, updated_at,
                     (workflow_state IS NOT NULL) AS is_wizard_claim
        `;
        const row = updated[0];
        if (!row) {
          throw new Error('PATCH /v1/claims/:id: UPDATE returned no row');
        }
        return { kind: 'updated' as const, prev, row };
      });

      if (result.kind === 'not_found') {
        return reply.status(404).send({
          error: 'claim_not_found',
          message: 'No claim with that id in this firm',
          requestId: req.id,
        });
      }
      if (result.kind === 'invalid_state') {
        return reply.status(409).send({
          error: 'invalid_state',
          message: 'cannot set ausindustry_reference unless stage is submitted',
          requestId: req.id,
        });
      }
      if (result.kind === 'noop') {
        return reply.status(200).send({ claim: toApi(result.row) });
      }

      // CLAIM_SUBMITTED is emitted when the resulting row has BOTH
      // ausindustry_reference AND submitted_at populated — and at least
      // one of them was set (or transitioned non-null) in this patch.
      // Idempotency: if both were already populated before the patch,
      // we don't re-emit (avoids ledger pollution on retries).
      const wasComplete =
        result.prev.ausindustry_reference !== null && result.prev.submitted_at !== null;
      const isComplete =
        result.row.ausindustry_reference !== null && result.row.submitted_at !== null;
      if (isComplete && !wasComplete) {
        const submittedPayload = ClaimSubmittedPayload.parse({
          claim_id: result.row.id,
          ausindustry_reference: result.row.ausindustry_reference!,
          submitted_by_user_id: userId,
        });
        await insertEventWithChain({
          tenant_id: tenantId,
          subject_tenant_id: result.row.subject_tenant_id,
          project_id: null,
          kind: 'CLAIM_SUBMITTED',
          payload: submittedPayload,
          classification: null,
          captured_at: new Date(),
          captured_by_user_id: userId,
          override_of_event_id: null,
          override_new_kind: null,
          override_reason: null,
        });
      }

      return reply.status(200).send({ claim: toApi(result.row) });
    },
  );

  // ---------------------------------------------------------------------
  // PATCH /v1/claims/:id/deliver — set delivery_kind (NULL → value) and
  // emit a Stripe per-claim usage record via emitClaimUsageRecord.
  //
  // Called once per claim when the consultant decides whether the claim
  // will be delivered as a quarterly_assurance or annual_claim. Setting
  // delivery_kind for the first time triggers the metered usage record.
  //
  // Idempotency: emitClaimUsageRecord guards against double-billing via
  // platform_fee_charged_at (see job JSDoc). This route still allows
  // re-setting delivery_kind (e.g. to correct a typo) without re-billing.
  //
  // No Stripe configured: if deps.stripe is undefined (local dev / tests
  // that don't pass deps), the DB update still lands but no usage record
  // is posted. This matches the pattern in prompt-suggestions.ts where
  // the AI client is optional in dev.
  // ---------------------------------------------------------------------
  app.patch<{ Params: { id: string } }>(
    '/v1/claims/:id/deliver',
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

      const bodyParsed = DeliveryKindEnum.safeParse(
        (req.body as Record<string, unknown>)?.delivery_kind,
      );
      if (!bodyParsed.success) {
        return reply.status(400).send({
          error: 'invalid_body',
          message: 'Body must be { delivery_kind: "quarterly_assurance" | "annual_claim" }',
          requestId: req.id,
        });
      }
      const delivery_kind = bodyParsed.data;
      const { id } = req.params;
      const tenantId = req.user!.tenantId!;

      // Set delivery_kind and return the updated row in one transaction.
      const result = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const updated = await tx<RawClaimRow[]>`
          UPDATE claim
             SET delivery_kind = ${delivery_kind},
                 updated_at    = NOW()
           WHERE id        = ${id}
             AND tenant_id = ${tenantId}
           RETURNING id, tenant_id, subject_tenant_id, fiscal_year, stage,
                     delivery_kind, platform_fee_charged_at,
                     ausindustry_reference, submitted_at, submitted_by_user_id,
                     created_at, updated_at,
                     (workflow_state IS NOT NULL) AS is_wizard_claim
        `;
        const row = updated[0];
        return row ?? null;
      });

      if (!result) {
        return reply.status(404).send({
          error: 'claim_not_found',
          message: 'No claim with that id in this firm',
          requestId: req.id,
        });
      }

      // Emit usage record if stripe is configured. Fire-and-forget with
      // error logging — a transient Stripe failure here is not fatal to
      // the API response; pg-boss retry handles persistence.
      if (stripe) {
        emitClaimUsageRecord({ claim_id: id, tenant_id: tenantId }, stripe).catch(
          (err: unknown) => {
            app.log.error({ err, claim_id: id }, 'emit-claim-usage-record failed');
          },
        );
      }

      return reply.status(200).send({ claim: toApi(result) });
    },
  );

  // -----------------------------------------------------------------------
  // GET /v1/claims/:id/preflight
  // Pre-flight check before allowing Submit Claim.
  // Returns { ok, issues[], activity_count, activities_without_hypothesis,
  //           unlinked_evidence_count, has_expenditure }
  // -----------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/v1/claims/:id/preflight',
    { preHandler: requireSession },
    async (req, reply) => {
      const { id } = req.params;
      const tenantId = req.user!.tenantId!;

      const result = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;

        // Claim must exist and belong to this tenant.
        const claimRows = await tx<{ id: string; stage: string }[]>`
          SELECT id, stage FROM claim WHERE id = ${id} AND tenant_id = ${tenantId}
        `;
        if (!claimRows[0]) return null;

        // Activity count + hypothesis completeness.
        const activityRows = await tx<{ id: string; hypothesis: string | null }[]>`
          SELECT id, hypothesis FROM activity WHERE claim_id = ${id}
        `;
        const activity_count = activityRows.length;
        const activities_without_hypothesis = activityRows.filter(
          (a) => !a.hypothesis || a.hypothesis.trim().length === 0,
        ).length;

        // Evidence linked to any activity in this claim.
        const linkedRows = await tx<{ n: string }[]>`
          SELECT COUNT(*)::text AS n
            FROM event e
           WHERE e.tenant_id = ${tenantId}
             AND e.kind = 'ARTEFACT_LINKED'
             AND e.payload->>'activity_id' IN (
               SELECT id::text FROM activity WHERE claim_id = ${id}
             )
        `;
        const linked_evidence_count = parseInt(linkedRows[0]?.n ?? '0', 10);

        // Total classified evidence for this claim's subject_tenant.
        const subjectRows = await tx<{ subject_tenant_id: string }[]>`
          SELECT subject_tenant_id FROM claim WHERE id = ${id}
        `;
        const subject_tenant_id = subjectRows[0]?.subject_tenant_id;
        let total_classified_events = 0;
        if (subject_tenant_id) {
          const totalRows = await tx<{ n: string }[]>`
            SELECT COUNT(*)::text AS n
              FROM event
             WHERE subject_tenant_id = ${subject_tenant_id}
               AND classification IS NOT NULL
               AND kind NOT IN ('OVERRIDE', 'ARTEFACT_LINKED', 'ARTEFACT_UNLINKED')
          `;
          total_classified_events = parseInt(totalRows[0]?.n ?? '0', 10);
        }
        const unlinked_evidence_count = Math.max(
          0,
          total_classified_events - linked_evidence_count,
        );

        // Expenditure summary.
        const expendRows = await tx<{ n: string }[]>`
          SELECT COUNT(*)::text AS n
            FROM expenditure
           WHERE claim_id = ${id}
             AND tenant_id = ${tenantId}
        `;
        const has_expenditure = parseInt(expendRows[0]?.n ?? '0', 10) > 0;

        return {
          activity_count,
          activities_without_hypothesis,
          unlinked_evidence_count,
          has_expenditure,
        };
      });

      if (!result) {
        return reply.status(404).send({
          error: 'claim_not_found',
          message: 'No claim with that id in this firm',
          requestId: req.id,
        });
      }

      const issues: string[] = [];
      if (result.activity_count === 0) {
        issues.push('No activities registered for this claim.');
      }
      if (result.activities_without_hypothesis > 0) {
        issues.push(
          `${result.activities_without_hypothesis} ${result.activities_without_hypothesis === 1 ? 'activity is' : 'activities are'} missing a hypothesis.`,
        );
      }
      if (!result.has_expenditure) {
        issues.push('No expenditure records found — add at least one before submitting.');
      }

      return reply.status(200).send({
        ok: issues.length === 0,
        issues,
        ...result,
      });
    },
  );

  // -----------------------------------------------------------------------
  // GET /v1/claims/:id/pending-review
  // Returns events with suggestion_status = 'pending' (or un-allocated but
  // classified evidence) for the consultant review queue.
  // -----------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/v1/claims/:id/pending-review',
    { preHandler: requireSession },
    async (req, reply) => {
      const { id } = req.params;
      const tenantId = req.user!.tenantId!;

      return await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;

        // Resolve subject_tenant_id for this claim.
        const claimRows = await tx<{ subject_tenant_id: string }[]>`
          SELECT subject_tenant_id FROM claim WHERE id = ${id} AND tenant_id = ${tenantId}
        `;
        if (!claimRows[0]) {
          return reply.status(404).send({
            error: 'claim_not_found',
            message: 'No claim with that id in this firm',
            requestId: req.id,
          });
        }
        const { subject_tenant_id } = claimRows[0];

        // All activities for this claim (for joining suggestion details).
        const activityRows = await tx<{ id: string; code: string; title: string }[]>`
          SELECT id, code, title FROM activity WHERE claim_id = ${id}
        `;
        const activityMap = new Map(activityRows.map((a) => [a.id, a]));

        // Events with a suggestion (any status) OR classified events with no suggestion yet.
        const eventRows = await tx<
          {
            id: string;
            kind: string;
            effective_kind: string;
            payload: unknown;
            classification: unknown;
            suggested_activity_id: string | null;
            suggested_at: string | null;
            suggestion_confidence: string | null;
            suggestion_status: string | null;
            captured_at: string;
          }[]
        >`
          SELECT e.id,
                 e.kind,
                 e.kind AS effective_kind,
                 e.payload,
                 e.classification,
                 e.suggested_activity_id,
                 e.suggested_at::text,
                 e.suggestion_confidence,
                 e.suggestion_status,
                 e.captured_at::text
            FROM event e
           WHERE e.subject_tenant_id = ${subject_tenant_id}
             AND e.tenant_id = ${tenantId}
             AND e.classification IS NOT NULL
             AND e.kind NOT IN (
               'OVERRIDE', 'ARTEFACT_LINKED', 'ARTEFACT_UNLINKED',
               'CLAIM_STAGE_ADVANCED', 'CLAIM_SUBMITTED', 'ACTIVITY_CREATED',
               'ACTIVITY_UPDATED', 'ACTIVITY_LOCKED'
             )
           ORDER BY e.captured_at DESC
           LIMIT 200
        `;

        const events = eventRows.map((row) => {
          const suggestedActivity = row.suggested_activity_id
            ? activityMap.get(row.suggested_activity_id)
            : null;
          return {
            id: row.id,
            kind: row.kind,
            effective_kind: row.effective_kind,
            payload: row.payload,
            classification: row.classification,
            suggested_activity_id: row.suggested_activity_id,
            suggested_at: row.suggested_at,
            suggestion_confidence: row.suggestion_confidence
              ? parseFloat(row.suggestion_confidence)
              : null,
            suggestion_status: row.suggestion_status,
            captured_at: row.captured_at,
            suggested_activity_code: suggestedActivity?.code ?? null,
            suggested_activity_title: suggestedActivity?.title ?? null,
          };
        });

        // Status counters.
        const pending_count = events.filter((e) => e.suggestion_status === 'pending').length;
        const confirmed_count = events.filter((e) => e.suggestion_status === 'confirmed').length;
        const rejected_count = events.filter((e) => e.suggestion_status === 'rejected').length;
        const edited_count = events.filter((e) => e.suggestion_status === 'edited').length;

        return reply.status(200).send({
          events,
          total_in_claim: events.length,
          pending_count,
          confirmed_count,
          rejected_count,
          edited_count,
        });
      });
    },
  );

  // -----------------------------------------------------------------------
  // POST /v1/claims/:id/events/:event_id/confirm-allocation
  // Marks suggestion_status='confirmed' + creates artefact-link.
  // -----------------------------------------------------------------------
  app.post<{ Params: { id: string; event_id: string } }>(
    '/v1/claims/:id/events/:event_id/confirm-allocation',
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

      const { id: claimId, event_id: eventId } = req.params;
      const tenantId = req.user!.tenantId!;
      const userId = req.user!.id;

      // Load the event + suggestion + claim context.
      const guard = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;

        const eventRows = await tx<
          {
            id: string;
            subject_tenant_id: string;
            suggested_activity_id: string | null;
            suggestion_status: string | null;
          }[]
        >`
          SELECT e.id, e.subject_tenant_id, e.suggested_activity_id, e.suggestion_status
            FROM event e
           WHERE e.id = ${eventId}
             AND e.tenant_id = ${tenantId}
        `;
        const evt = eventRows[0];
        if (!evt) return { kind: 'event_not_found' as const };
        if (!evt.suggested_activity_id) return { kind: 'no_suggestion' as const };

        const activityRows = await tx<{ id: string; project_id: string }[]>`
          SELECT a.id, a.project_id
            FROM activity a
            JOIN claim c ON c.id = a.claim_id
           WHERE a.id = ${evt.suggested_activity_id}
             AND a.tenant_id = ${tenantId}
             AND c.id = ${claimId}
        `;
        const activity = activityRows[0];
        if (!activity) return { kind: 'activity_not_found' as const };

        return {
          kind: 'ok' as const,
          subject_tenant_id: evt.subject_tenant_id,
          activity_id: activity.id,
          project_id: activity.project_id,
        };
      });

      if (guard.kind === 'event_not_found') {
        return reply
          .status(404)
          .send({ error: 'event_not_found', message: 'Event not found', requestId: req.id });
      }
      if (guard.kind === 'no_suggestion') {
        return reply.status(422).send({
          error: 'no_suggestion',
          message: 'Event has no pending suggestion',
          requestId: req.id,
        });
      }
      if (guard.kind === 'activity_not_found') {
        return reply.status(404).send({
          error: 'activity_not_found',
          message: 'Suggested activity not found in this claim',
          requestId: req.id,
        });
      }

      // Mark confirmed.
      await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        await tx`
          UPDATE event
             SET suggestion_status = 'confirmed'
           WHERE id = ${eventId} AND tenant_id = ${tenantId}
        `;
      });

      // Create the artefact-link chain event.
      const inserted = await insertEventWithChain({
        tenant_id: tenantId,
        subject_tenant_id: guard.subject_tenant_id,
        project_id: guard.project_id,
        kind: 'ARTEFACT_LINKED',
        payload: {
          activity_id: guard.activity_id,
          artefact_kind: 'event',
          artefact_id: eventId,
          link_reason: 'auto-allocation confirmed by consultant',
        },
        classification: null,
        captured_at: new Date(),
        captured_by_user_id: userId,
        override_of_event_id: null,
        override_new_kind: null,
        override_reason: null,
      });

      return reply.status(200).send({
        event_id: eventId,
        suggestion_status: 'confirmed',
        link_event_id: inserted.id,
      });
    },
  );

  // -----------------------------------------------------------------------
  // POST /v1/claims/:id/events/:event_id/reject-allocation
  // Marks suggestion_status='rejected'. No artefact-link created.
  // -----------------------------------------------------------------------
  app.post<{ Params: { id: string; event_id: string } }>(
    '/v1/claims/:id/events/:event_id/reject-allocation',
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

      const { id: claimId, event_id: eventId } = req.params;
      const tenantId = req.user!.tenantId!;

      const exists = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<{ id: string }[]>`
          SELECT e.id FROM event e
           JOIN claim c ON c.subject_tenant_id = e.subject_tenant_id
           WHERE e.id = ${eventId} AND e.tenant_id = ${tenantId} AND c.id = ${claimId}
        `;
        return rows[0] != null;
      });

      if (!exists) {
        return reply.status(404).send({
          error: 'event_not_found',
          message: 'Event not found in this claim',
          requestId: req.id,
        });
      }

      await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        await tx`
          UPDATE event
             SET suggestion_status = 'rejected'
           WHERE id = ${eventId} AND tenant_id = ${tenantId}
        `;
      });

      return reply.status(200).send({ event_id: eventId, suggestion_status: 'rejected' });
    },
  );

  // -----------------------------------------------------------------------
  // POST /v1/claims/:id/batch-confirm-allocations
  // Confirm multiple suggestions at once.
  // body: { event_ids: string[] }
  // -----------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/v1/claims/:id/batch-confirm-allocations',
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

      const bodyParsed = z
        .object({ event_ids: z.array(z.string().uuid()).min(1).max(100) })
        .safeParse(req.body);
      if (!bodyParsed.success) {
        return reply.status(400).send({
          error: 'invalid_body',
          message: 'Body must be { event_ids: uuid[] }',
          requestId: req.id,
        });
      }
      const { event_ids } = bodyParsed.data;
      const { id: claimId } = req.params;
      const tenantId = req.user!.tenantId!;
      const userId = req.user!.id;

      let confirmed = 0;
      let failed = 0;

      for (const eventId of event_ids) {
        try {
          const guard = await sql.begin(async (tx) => {
            await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
            const rows = await tx<
              {
                subject_tenant_id: string;
                suggested_activity_id: string | null;
                project_id: string | null;
              }[]
            >`
              SELECT e.subject_tenant_id,
                     e.suggested_activity_id,
                     a.project_id
                FROM event e
                LEFT JOIN activity a ON a.id = e.suggested_activity_id
               WHERE e.id = ${eventId}
                 AND e.tenant_id = ${tenantId}
                 AND EXISTS (
                   SELECT 1 FROM claim c
                    WHERE c.id = ${claimId}
                      AND c.subject_tenant_id = e.subject_tenant_id
                 )
            `;
            return rows[0] ?? null;
          });

          if (!guard?.suggested_activity_id) {
            failed++;
            continue;
          }

          await sql.begin(async (tx) => {
            await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
            await tx`UPDATE event SET suggestion_status = 'confirmed' WHERE id = ${eventId} AND tenant_id = ${tenantId}`;
          });

          await insertEventWithChain({
            tenant_id: tenantId,
            subject_tenant_id: guard.subject_tenant_id,
            project_id: guard.project_id ?? null,
            kind: 'ARTEFACT_LINKED',
            payload: {
              activity_id: guard.suggested_activity_id,
              artefact_kind: 'event',
              artefact_id: eventId,
              link_reason: 'auto-allocation batch confirmed',
            },
            classification: null,
            captured_at: new Date(),
            captured_by_user_id: userId,
            override_of_event_id: null,
            override_new_kind: null,
            override_reason: null,
          });

          confirmed++;
        } catch {
          failed++;
        }
      }

      return reply.status(200).send({ confirmed, failed });
    },
  );

  // -----------------------------------------------------------------------
  // POST /v1/claims/:id/auto-allocate-batch
  // Run the auto-allocator on all unallocated classified events for a claim.
  // -----------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/v1/claims/:id/auto-allocate-batch',
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

      const { id: claimId } = req.params;
      const tenantId = req.user!.tenantId!;

      // Resolve subject_tenant_id.
      const claimRow = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<{ subject_tenant_id: string }[]>`
          SELECT subject_tenant_id FROM claim WHERE id = ${claimId} AND tenant_id = ${tenantId}
        `;
        return rows[0] ?? null;
      });

      if (!claimRow) {
        return reply.status(404).send({
          error: 'claim_not_found',
          message: 'No claim with that id in this firm',
          requestId: req.id,
        });
      }

      // Load activities.
      const activities = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        return tx<
          { id: string; code: string; kind: string; title: string; hypothesis: string | null }[]
        >`
          SELECT id, code, kind, title, hypothesis
            FROM activity
           WHERE claim_id = ${claimId}
             AND tenant_id = ${tenantId}
           ORDER BY code ASC
        `;
      });

      // Load unallocated classified events (suggestion_status IS NULL means not yet run).
      const unallocatedEvents = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        return tx<{ id: string; kind: string; payload: unknown; classification: unknown }[]>`
          SELECT id, kind, payload, classification
            FROM event
           WHERE subject_tenant_id = ${claimRow.subject_tenant_id}
             AND tenant_id = ${tenantId}
             AND classification IS NOT NULL
             AND suggestion_status IS NULL
             AND kind NOT IN (
               'OVERRIDE', 'ARTEFACT_LINKED', 'ARTEFACT_UNLINKED',
               'CLAIM_STAGE_ADVANCED', 'CLAIM_SUBMITTED', 'ACTIVITY_CREATED',
               'ACTIVITY_UPDATED', 'ACTIVITY_LOCKED'
             )
           LIMIT 50
        `;
      });

      // Lazy allocator.
      const { makeAutoAllocator } = await import('@cpa/agents');
      const allocator = makeAutoAllocator();

      const suggestions = [];
      let suggested = 0;
      let unallocated_count = 0;

      for (const evt of unallocatedEvents) {
        const classification = evt.classification as {
          kind: string;
          confidence: number;
          rationale: string;
          statutory_anchor: string | null;
        } | null;
        if (!classification) continue;

        const payload = evt.payload as Record<string, unknown> | null;
        const raw_text =
          typeof payload?.raw_text === 'string'
            ? payload.raw_text
            : typeof payload?.transcript === 'string'
              ? payload.transcript
              : evt.kind;

        try {
          const suggestion = await allocator.allocate({
            event_id: evt.id,
            raw_text,
            classification: classification as Parameters<
              typeof allocator.allocate
            >[0]['classification'],
            activities: activities.map((a) => ({
              id: a.id,
              code: a.code,
              kind: a.kind as 'core' | 'supporting',
              title: a.title,
              hypothesis: a.hypothesis,
            })),
          });

          // Persist.
          await sql.begin(async (tx) => {
            await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
            if (!suggestion.unallocated) {
              await tx`
                UPDATE event
                   SET suggested_activity_id  = ${suggestion.activity_id}::uuid,
                       suggested_at           = NOW(),
                       suggestion_confidence  = ${String(suggestion.confidence)},
                       suggestion_status      = 'pending'
                 WHERE id = ${evt.id} AND tenant_id = ${tenantId}
              `;
              suggested++;
            } else {
              await tx`
                UPDATE event
                   SET suggested_activity_id  = NULL,
                       suggested_at           = NOW(),
                       suggestion_confidence  = NULL,
                       suggestion_status      = 'pending'
                 WHERE id = ${evt.id} AND tenant_id = ${tenantId}
              `;
              unallocated_count++;
            }
          });

          suggestions.push({
            event_id: evt.id,
            suggestion: suggestion.unallocated
              ? {
                  unallocated: true,
                  activity_id: null,
                  activity_code: null,
                  confidence: null,
                  rationale: suggestion.rationale,
                }
              : {
                  unallocated: false,
                  activity_id: suggestion.activity_id,
                  activity_code: suggestion.activity_code,
                  confidence: suggestion.confidence,
                  rationale: suggestion.rationale,
                },
          });
        } catch (err) {
          app.log.error({ err, event_id: evt.id }, 'auto-allocate batch: event failed');
        }
      }

      return reply.status(200).send({
        suggestions,
        total: unallocatedEvents.length,
        suggested,
        unallocated: unallocated_count,
      });
    },
  );

  // -----------------------------------------------------------------------
  // POST /v1/claims/:id/finalise
  // Kicks off the claim-finalisation pg-boss job.
  // Returns { job_id, claim_id }
  // -----------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/v1/claims/:id/finalise',
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

      const { id } = req.params;
      const tenantId = req.user!.tenantId!;
      const userId = req.user!.id;

      // Verify claim exists.
      const claimRow = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<{ id: string; stage: string }[]>`
          SELECT id, stage FROM claim WHERE id = ${id} AND tenant_id = ${tenantId}
        `;
        return rows[0] ?? null;
      });

      if (!claimRow) {
        return reply.status(404).send({
          error: 'claim_not_found',
          message: 'No claim with that id in this firm',
          requestId: req.id,
        });
      }

      // Advance stage to narrative_drafting.
      await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        await tx`
          UPDATE claim
             SET stage              = 'narrative_drafting',
                 finalisation_status = 'queued',
                 updated_at          = NOW()
           WHERE id = ${id} AND tenant_id = ${tenantId}
        `;
      });

      // Enqueue the pg-boss job. In non-test environments getBoss() is live.
      let job_id: string;
      try {
        const boss = await getBoss();
        const jobInput: ClaimFinalisationJobInput = {
          claim_id: id,
          tenant_id: tenantId,
          triggered_by_user_id: userId,
        };
        const sent = await boss.send(CLAIM_FINALISATION_JOB_NAME, jobInput);
        job_id = sent ?? `local-${crypto.randomUUID()}`;
      } catch (err) {
        // pg-boss not available in some environments — run inline (best-effort).
        app.log.warn({ err }, 'pg-boss unavailable; running finalisation inline');
        job_id = `inline-${crypto.randomUUID()}`;
        // Fire-and-forget inline execution.
        import('../jobs/claim-finalisation.js')
          .then(({ runClaimFinalisationJob }) => {
            void runClaimFinalisationJob({
              claim_id: id,
              tenant_id: tenantId,
              triggered_by_user_id: userId,
            }).catch((e: unknown) => {
              app.log.error({ err: e }, 'inline finalisation failed');
            });
          })
          .catch((e: unknown) => {
            app.log.error({ err: e }, 'claim-finalisation import failed');
          });
      }

      return reply.status(202).send({ job_id, claim_id: id });
    },
  );

  // -----------------------------------------------------------------------
  // GET /v1/claims/:id/finalisation-status
  // Returns { status, progress: { activities_drafted, total_activities, pdfs_generated, total_pdfs } }
  // -----------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/v1/claims/:id/finalisation-status',
    { preHandler: requireSession },
    async (req, reply) => {
      const { id } = req.params;
      const tenantId = req.user!.tenantId!;

      const row = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<
          {
            finalisation_status: string | null;
            finalisation_progress: unknown;
          }[]
        >`
          SELECT finalisation_status, finalisation_progress
            FROM claim
           WHERE id = ${id} AND tenant_id = ${tenantId}
        `;
        return rows[0] ?? null;
      });

      if (!row) {
        return reply.status(404).send({
          error: 'claim_not_found',
          message: 'No claim with that id in this firm',
          requestId: req.id,
        });
      }

      const progress =
        (row.finalisation_progress as {
          activities_drafted?: number;
          total_activities?: number;
          pdfs_generated?: number;
          total_pdfs?: number;
        } | null) ?? {};

      return reply.status(200).send({
        status: row.finalisation_status ?? 'not_started',
        progress: {
          activities_drafted: progress.activities_drafted ?? 0,
          total_activities: progress.total_activities ?? 0,
          pdfs_generated: progress.pdfs_generated ?? 0,
          total_pdfs: progress.total_pdfs ?? 6,
        },
      });
    },
  );

  // -----------------------------------------------------------------------
  // GET /v1/claims/:id/final-draft
  // Returns the completed narrative sections + PDF download URLs.
  // -----------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/v1/claims/:id/final-draft',
    { preHandler: requireSession },
    async (req, reply) => {
      const { id } = req.params;
      const tenantId = req.user!.tenantId!;

      const result = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;

        const claimRows = await tx<{ id: string; stage: string }[]>`
          SELECT id, stage FROM claim WHERE id = ${id} AND tenant_id = ${tenantId}
        `;
        if (!claimRows[0]) return null;

        const draftRows = await tx<
          {
            activity_id: string;
            activity_code: string;
            activity_title: string;
            segments: unknown;
            updated_at: string;
          }[]
        >`
          SELECT nd.activity_id,
                 a.code  AS activity_code,
                 a.title AS activity_title,
                 nd.segments,
                 nd.updated_at::text
            FROM narrative_draft nd
            JOIN activity a ON a.id = nd.activity_id
           WHERE a.claim_id = ${id}
             AND nd.tenant_id = ${tenantId}
             AND nd.section_kind = 'new_knowledge'
             AND nd.status IN ('complete', 'accepted')
           ORDER BY a.code ASC
        `;

        return {
          stage: claimRows[0].stage,
          drafts: draftRows,
        };
      });

      if (!result) {
        return reply.status(404).send({
          error: 'claim_not_found',
          message: 'No claim with that id in this firm',
          requestId: req.id,
        });
      }

      const sections = result.drafts.map((d) => {
        const segments = (d.segments as Array<{ type: string; text?: string }> | null) ?? [];
        const prose = segments.map((s) => s.text ?? '').join('\n\n');
        return {
          activity_id: d.activity_id,
          activity_code: d.activity_code,
          activity_title: d.activity_title,
          prose,
          generated_at: d.updated_at,
        };
      });

      return reply.status(200).send({
        claim_id: id,
        sections,
        pdf_urls: {
          claim_summary: `/v1/claims/${id}/summary.pdf`,
          apportionment: `/v1/claims/${id}/apportionment.pdf`,
        },
        locked: result.stage === 'submitted' || result.stage === 'audit_defence',
      });
    },
  );
}
