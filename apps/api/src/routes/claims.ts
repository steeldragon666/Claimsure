import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { requireSession } from '@cpa/auth';
import { sql } from '@cpa/db/client';
import { insertEventWithChain } from '@cpa/db';
import {
  ClaimStageAdvancedPayload,
  ClaimSubmittedPayload,
  CreateClaimBody,
  ListClaimsQuery,
  UpdateClaimBody,
  UpdateClaimStageBody,
  type Claim,
  type ClaimStage,
} from '@cpa/schemas';
import { validateStageTransition } from '../lib/claim-stage.js';

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
  ausindustry_reference: string | null;
  submitted_at: Date | string | null;
  submitted_by_user_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const isoOf = (v: Date | string): string => (typeof v === 'string' ? v : v.toISOString());
const isoOrNull = (v: Date | string | null): string | null => (v === null ? null : isoOf(v));

const toApi = (r: RawClaimRow): Claim => ({
  id: r.id,
  tenant_id: r.tenant_id,
  subject_tenant_id: r.subject_tenant_id,
  fiscal_year: r.fiscal_year,
  stage: r.stage,
  ausindustry_reference: r.ausindustry_reference,
  submitted_at: isoOrNull(r.submitted_at),
  submitted_by_user_id: r.submitted_by_user_id,
  created_at: isoOf(r.created_at),
  updated_at: isoOf(r.updated_at),
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
export function registerClaims(app: FastifyInstance): void {
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
    let inserted: RawClaimRow | null;
    try {
      inserted = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<RawClaimRow[]>`
          INSERT INTO claim (
            id, tenant_id, subject_tenant_id, fiscal_year, stage,
            ausindustry_reference
          )
          VALUES (
            ${crypto.randomUUID()}, ${tenantId}, ${subject_tenant_id}, ${fiscal_year},
            ${stage ?? 'engagement'},
            ${ausindustry_reference ?? null}
          )
          RETURNING id, tenant_id, subject_tenant_id, fiscal_year, stage,
                    ausindustry_reference, submitted_at, submitted_by_user_id,
                    created_at, updated_at
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
          'Query must match { subject_tenant_id?: uuid, stage?, assignee?: uuid, fiscal_year?: int }',
        requestId: req.id,
      });
    }
    const { subject_tenant_id, stage, fiscal_year } = parsed.data;
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

      const rows = await tx<RawClaimRow[]>`
        SELECT id, tenant_id, subject_tenant_id, fiscal_year, stage,
               ausindustry_reference, submitted_at, submitted_by_user_id,
               created_at, updated_at
          FROM claim
         WHERE 1 = 1
               ${whereSubject}
               ${whereStage}
               ${whereFiscalYear}
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
                 ausindustry_reference, submitted_at, submitted_by_user_id,
                 created_at, updated_at
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
                 ausindustry_reference, submitted_at, submitted_by_user_id,
                 created_at, updated_at
            FROM claim
           WHERE id = ${id}
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
           RETURNING id, tenant_id, subject_tenant_id, fiscal_year, stage,
                     ausindustry_reference, submitted_at, submitted_by_user_id,
                     created_at, updated_at
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
                 ausindustry_reference, submitted_at, submitted_by_user_id,
                 created_at, updated_at
            FROM claim
           WHERE id = ${id}
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
           RETURNING id, tenant_id, subject_tenant_id, fiscal_year, stage,
                     ausindustry_reference, submitted_at, submitted_by_user_id,
                     created_at, updated_at
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
}
