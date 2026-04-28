import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { requireSession } from '@cpa/auth';
import { sql } from '@cpa/db/client';
import { insertEventWithChain, nextActivityCode } from '@cpa/db';
import {
  ActivityCreatedPayload,
  ActivityUpdatedPayload,
  CreateActivityBody,
  ListActivitiesQuery,
  UpdateActivityBody,
  type Activity,
  type ActivityKind,
} from '@cpa/schemas';

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
// TODO(p4-a-field-diff): The `recordIfChanged` field-diff helper is now
// duplicated in projects.ts (A1) and here (A3). The third caller — A2's
// PATCH /:id stage advance also computes a field diff inline — is the
// threshold the A1 reviewer flagged for extraction. Pull these into
// `apps/api/src/lib/field-diff.ts` as a separate cross-cutting refactor
// once the A-swimlane merges; doing it inline here is scope creep.
// See: A3 plan, "Field diff helper (architectural decision)".

/**
 * Raw activity row as stored in postgres. Columns are snake_case to match
 * the SQL surface; conversion to the wire format (still snake_case but
 * with ISO-8601 timestamps in place of Date objects) happens in
 * {@link toApi}.
 */
interface RawActivityRow {
  id: string;
  tenant_id: string;
  project_id: string;
  claim_id: string;
  code: string;
  kind: ActivityKind;
  title: string;
  description: string | null;
  hypothesis: string | null;
  technical_uncertainty: string | null;
  experimentation_log: string | null;
  expected_outcome: string | null;
  actual_outcome: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const isoOf = (v: Date | string): string => (typeof v === 'string' ? v : v.toISOString());

const toApi = (r: RawActivityRow): Activity => ({
  id: r.id,
  tenant_id: r.tenant_id,
  project_id: r.project_id,
  claim_id: r.claim_id,
  code: r.code,
  kind: r.kind,
  title: r.title,
  description: r.description,
  hypothesis: r.hypothesis,
  technical_uncertainty: r.technical_uncertainty,
  experimentation_log: r.experimentation_log,
  expected_outcome: r.expected_outcome,
  actual_outcome: r.actual_outcome,
  created_at: isoOf(r.created_at),
  updated_at: isoOf(r.updated_at),
});

/**
 * The narrative-update column set. Listed once so the PATCH SET-list, the
 * RETURNING clause, and the field-diff loop stay in lock-step. If a new
 * narrative column is added, update the migration first (CHECK +
 * Drizzle), then this list, then UpdateActivityBody.
 */
const NARRATIVE_FIELDS = [
  'title',
  'description',
  'hypothesis',
  'technical_uncertainty',
  'experimentation_log',
  'expected_outcome',
  'actual_outcome',
] as const;
type NarrativeField = (typeof NARRATIVE_FIELDS)[number];

/**
 * Register the activity CRUD routes (T-A3 of the P4 plan).
 *
 * Auth: requireSession + admin-or-consultant gating on mutations.
 *   - Viewers can list/detail but cannot create or update.
 *
 * RLS: every read/write inside `sql.begin` sets `app.current_tenant_id`
 * so the `activity_tenant_isolation` policy filters cross-firm rows
 * automatically (added in F2 alongside the activity table).
 *
 * Defense-in-depth: every UPDATE/SELECT-by-id query also includes
 * `AND tenant_id = ${tenantId}` — RLS is the canonical guard, but a
 * mis-set GUC (or any future code path that opens a tx without the
 * `set_config` line) would silently widen visibility. Belt and braces.
 *
 * Event chain: each mutation extends the per-claimant hash chain via
 * `insertEventWithChain` from `@cpa/db`. The helper holds a
 * pg_advisory_xact_lock per-subject_tenant so concurrent mutations on
 * the same chain serialise; mutations on different claimants do not
 * block each other.
 *
 * Auto-generated codes: POST /v1/activities does NOT accept a `code` in
 * the body — the route resolves the next available CA-NN / SA-NN via
 * `nextActivityCode` (F9). The helper gap-fills (CA-01 + CA-03 already
 * present → returns CA-02) and keeps core/supporting sequences
 * independent (CA-01 does not shadow SA-01).
 *
 * Stage gating:
 *   - POST: 409 if parent project archived, parent claim is 'submitted',
 *     or claim is 'audit_defence' (no edits to a locked claim).
 *   - PATCH: 409 if parent claim is 'submitted' or 'audit_defence' —
 *     activities are read-only once the claim hits a terminal stage.
 *     UI may also surface this via the ACTIVITY_LOCKED event kind.
 */
export function registerActivities(app: FastifyInstance): void {
  // ---------------------------------------------------------------------
  // POST /v1/activities — create + emit ACTIVITY_CREATED.
  // ---------------------------------------------------------------------
  app.post('/v1/activities', { preHandler: requireSession }, async (req, reply) => {
    const role = req.user!.role;
    if (role !== 'admin' && role !== 'consultant') {
      return reply.status(403).send({
        error: 'forbidden',
        message: 'Admin or consultant role required',
        requestId: req.id,
      });
    }

    const parsed = CreateActivityBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'invalid_body',
        message:
          'Body must be { project_id, claim_id, kind: "core" | "supporting", title, description?, hypothesis?, technical_uncertainty?, expected_outcome? }',
        requestId: req.id,
      });
    }
    const {
      project_id,
      claim_id,
      kind,
      title,
      description,
      hypothesis,
      technical_uncertainty,
      expected_outcome,
    } = parsed.data;
    const tenantId = req.user!.tenantId!;
    const userId = req.user!.id;

    // Verify the parent project + claim are both visible under RLS, the
    // project isn't archived, and the claim isn't in a terminal stage.
    // We resolve all three preconditions in one transaction so a
    // racing archive/submit can't slip past between checks. We also
    // check that the project's subject_tenant_id matches the claim's
    // — otherwise an activity could orphan to the wrong claimant.
    const guard = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
      const projectRows = await tx<
        { id: string; subject_tenant_id: string; archived_at: Date | string | null }[]
      >`
        SELECT id, subject_tenant_id, archived_at
          FROM project
         WHERE id = ${project_id}
           AND tenant_id = ${tenantId}
      `;
      const project = projectRows[0];
      if (!project) return { kind: 'project_not_found' as const };
      if (project.archived_at !== null) return { kind: 'project_archived' as const };

      const claimRows = await tx<{ id: string; subject_tenant_id: string; stage: string }[]>`
        SELECT id, subject_tenant_id, stage
          FROM claim
         WHERE id = ${claim_id}
           AND tenant_id = ${tenantId}
      `;
      const claim = claimRows[0];
      if (!claim) return { kind: 'claim_not_found' as const };
      if (claim.subject_tenant_id !== project.subject_tenant_id) {
        return { kind: 'project_claim_mismatch' as const };
      }
      if (claim.stage === 'submitted' || claim.stage === 'audit_defence') {
        return { kind: 'claim_locked' as const, stage: claim.stage };
      }

      return {
        kind: 'ok' as const,
        subject_tenant_id: claim.subject_tenant_id,
      };
    });

    if (guard.kind === 'project_not_found') {
      return reply.status(404).send({
        error: 'project_not_found',
        message: 'No project with that id in this firm',
        requestId: req.id,
      });
    }
    if (guard.kind === 'claim_not_found') {
      return reply.status(404).send({
        error: 'claim_not_found',
        message: 'No claim with that id in this firm',
        requestId: req.id,
      });
    }
    if (guard.kind === 'project_archived') {
      return reply.status(409).send({
        error: 'project_archived',
        message: 'Cannot add an activity under an archived project',
        requestId: req.id,
      });
    }
    if (guard.kind === 'project_claim_mismatch') {
      return reply.status(409).send({
        error: 'project_claim_mismatch',
        message: 'Project and claim belong to different claimants',
        requestId: req.id,
      });
    }
    if (guard.kind === 'claim_locked') {
      return reply.status(409).send({
        error: 'claim_locked',
        message: `Cannot add an activity to a claim in stage "${guard.stage}"`,
        requestId: req.id,
      });
    }

    // Auto-generate the next CA-NN / SA-NN. nextActivityCode runs
    // against `privilegedSql` (RLS-bypassed) — the parent-claim guard
    // above already proved tenant authorization, and the helper is
    // documented to require caller-side authz.
    //
    // Race notes: nextActivityCode is documented as "race-prone" — two
    // concurrent POSTs against the same (claim_id, kind) could both
    // resolve the same code. The activity_claim_code_unique index
    // (uniqueIndex on (claim_id, code)) catches the second insert with
    // a 23505. We surface that as 409 + retry signal so the consultant
    // portal can resubmit once. In practice the race is extremely rare
    // (consultant flow is single-user-per-claim).
    let code: string;
    try {
      code = await nextActivityCode({ claim_id, kind });
    } catch (err) {
      // The only documented throw is "code exhausted" (1-999). Surface
      // as 409 — the claim is at the wire-format CHECK regex's upper
      // bound (`^(CA|SA)-\d{2,3}$` allows 999 codes per kind per claim).
      app.log.error({ err, claim_id, kind }, 'nextActivityCode failed');
      return reply.status(409).send({
        error: 'code_exhausted',
        message: 'Activity code sequence exhausted for this claim and kind',
        requestId: req.id,
      });
    }

    let inserted: RawActivityRow | null;
    try {
      inserted = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<RawActivityRow[]>`
          INSERT INTO activity (
            id, tenant_id, project_id, claim_id, code, kind, title,
            description, hypothesis, technical_uncertainty, expected_outcome
          )
          VALUES (
            ${crypto.randomUUID()}, ${tenantId}, ${project_id}, ${claim_id},
            ${code}, ${kind}, ${title},
            ${description ?? null},
            ${hypothesis ?? null},
            ${technical_uncertainty ?? null},
            ${expected_outcome ?? null}
          )
          RETURNING id, tenant_id, project_id, claim_id, code, kind, title,
                    description, hypothesis, technical_uncertainty,
                    experimentation_log, expected_outcome, actual_outcome,
                    created_at, updated_at
        `;
        return rows[0] ?? null;
      });
    } catch (err) {
      // UNIQUE (claim_id, code) violation — a concurrent POST stole our
      // resolved code. Surface as 409 so the client can retry.
      if ((err as { code?: string }).code === '23505') {
        return reply.status(409).send({
          error: 'code_collision',
          message: 'Activity code race lost to a concurrent request; retry',
          requestId: req.id,
        });
      }
      throw err;
    }
    if (!inserted) {
      throw new Error('POST /v1/activities: INSERT returned no row');
    }

    // Validate the payload via Zod before insert — same rationale as
    // projects.ts / claims.ts: a future refactor that drifts the payload
    // shape blows up at the boundary (programming error) rather than
    // landing a malformed event on the chain.
    const createdPayload = ActivityCreatedPayload.parse({
      activity_id: inserted.id,
      code: inserted.code,
      kind: inserted.kind,
      title: inserted.title,
      project_id: inserted.project_id,
      claim_id: inserted.claim_id,
    });
    await insertEventWithChain({
      tenant_id: tenantId,
      subject_tenant_id: guard.subject_tenant_id,
      project_id: inserted.project_id,
      kind: 'ACTIVITY_CREATED',
      payload: createdPayload,
      classification: null,
      captured_at: new Date(),
      captured_by_user_id: userId,
      override_of_event_id: null,
      override_new_kind: null,
      override_reason: null,
    });

    return reply.status(201).send({ activity: toApi(inserted) });
  });

  // ---------------------------------------------------------------------
  // GET /v1/activities?claim_id=... — list, ordered by code (RLS filters
  // cross-firm). Order is a string compare, which is correct for CA/SA
  // codes because the prefix sorts CA before SA and the zero-padded
  // suffix sorts numerically (CA-02 < CA-10 holds because the DB stores
  // 'CA-02' lexicographically before 'CA-10').
  // ---------------------------------------------------------------------
  app.get('/v1/activities', { preHandler: requireSession }, async (req, reply) => {
    const parsed = ListActivitiesQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'invalid_query',
        message: 'Query must match { claim_id?: uuid }',
        requestId: req.id,
      });
    }
    const { claim_id } = parsed.data;
    const tenantId = req.user!.tenantId!;

    return await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
      const rows = claim_id
        ? await tx<RawActivityRow[]>`
            SELECT id, tenant_id, project_id, claim_id, code, kind, title,
                   description, hypothesis, technical_uncertainty,
                   experimentation_log, expected_outcome, actual_outcome,
                   created_at, updated_at
              FROM activity
             WHERE claim_id = ${claim_id}
             ORDER BY code ASC
          `
        : await tx<RawActivityRow[]>`
            SELECT id, tenant_id, project_id, claim_id, code, kind, title,
                   description, hypothesis, technical_uncertainty,
                   experimentation_log, expected_outcome, actual_outcome,
                   created_at, updated_at
              FROM activity
             ORDER BY code ASC
          `;
      return { activities: rows.map(toApi) };
    });
  });

  // ---------------------------------------------------------------------
  // GET /v1/activities/:id — detail (admin/consultant/viewer all allowed).
  // ---------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/v1/activities/:id',
    { preHandler: requireSession },
    async (req, reply) => {
      const { id } = req.params;
      const tenantId = req.user!.tenantId!;
      return await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<RawActivityRow[]>`
          SELECT id, tenant_id, project_id, claim_id, code, kind, title,
                 description, hypothesis, technical_uncertainty,
                 experimentation_log, expected_outcome, actual_outcome,
                 created_at, updated_at
            FROM activity
           WHERE id = ${id}
             AND tenant_id = ${tenantId}
        `;
        const row = rows[0];
        if (!row) {
          return reply.status(404).send({
            error: 'activity_not_found',
            message: 'No activity with that id in this firm',
            requestId: req.id,
          });
        }
        return { activity: toApi(row) };
      });
    },
  );

  // ---------------------------------------------------------------------
  // PATCH /v1/activities/:id — partial update + emit ACTIVITY_UPDATED.
  // ---------------------------------------------------------------------
  app.patch<{ Params: { id: string } }>(
    '/v1/activities/:id',
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

      const parsed = UpdateActivityBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'invalid_body',
          message:
            'Body must be a partial update of { title?, description?, hypothesis?, technical_uncertainty?, experimentation_log?, expected_outcome?, actual_outcome? } with no extra keys',
          requestId: req.id,
        });
      }
      const patch = parsed.data;
      const { id } = req.params;
      const tenantId = req.user!.tenantId!;
      const userId = req.user!.id;

      const patchKeys = Object.keys(patch) as Array<keyof typeof patch>;

      // Load + update in one tx so the stage gate is checked against the
      // claim that's actually being mutated. We join activity → claim
      // for the stage; cross-firm protection is RLS + tenant_id guard.
      const result = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const before = await tx<
          (RawActivityRow & { claim_stage: string; subject_tenant_id: string })[]
        >`
          SELECT a.id, a.tenant_id, a.project_id, a.claim_id, a.code, a.kind,
                 a.title, a.description, a.hypothesis, a.technical_uncertainty,
                 a.experimentation_log, a.expected_outcome, a.actual_outcome,
                 a.created_at, a.updated_at,
                 c.stage AS claim_stage,
                 c.subject_tenant_id AS subject_tenant_id
            FROM activity a
            JOIN claim c ON c.id = a.claim_id
           WHERE a.id = ${id}
             AND a.tenant_id = ${tenantId}
        `;
        const prev = before[0];
        if (!prev) return { kind: 'not_found' as const };

        // Stage gate: a 'submitted' or 'audit_defence' claim freezes its
        // activities (no further narrative edits — UI may surface the
        // ACTIVITY_LOCKED event kind for explicit consultant-driven locks
        // earlier in the pipeline; this is the implicit gate).
        if (prev.claim_stage === 'submitted' || prev.claim_stage === 'audit_defence') {
          return { kind: 'claim_locked' as const, stage: prev.claim_stage };
        }

        if (patchKeys.length === 0) {
          return { kind: 'noop' as const, row: prev };
        }

        // Per-column conditional UPDATE — same shape as projects.ts /
        // claims.ts. Implicit trailing-comma discipline survives because
        // `updated_at = NOW()` always lands at the end. See TODO at top
        // of file (refactor to a `setIfDefined` helper is a separate
        // cross-cutting task).
        const setTitle = patch.title !== undefined ? tx`title = ${patch.title},` : tx``;
        const setDescription =
          patch.description !== undefined ? tx`description = ${patch.description},` : tx``;
        const setHypothesis =
          patch.hypothesis !== undefined ? tx`hypothesis = ${patch.hypothesis},` : tx``;
        const setTechnicalUncertainty =
          patch.technical_uncertainty !== undefined
            ? tx`technical_uncertainty = ${patch.technical_uncertainty},`
            : tx``;
        const setExperimentationLog =
          patch.experimentation_log !== undefined
            ? tx`experimentation_log = ${patch.experimentation_log},`
            : tx``;
        const setExpectedOutcome =
          patch.expected_outcome !== undefined
            ? tx`expected_outcome = ${patch.expected_outcome},`
            : tx``;
        const setActualOutcome =
          patch.actual_outcome !== undefined ? tx`actual_outcome = ${patch.actual_outcome},` : tx``;

        const updated = await tx<RawActivityRow[]>`
          UPDATE activity
             SET ${setTitle}
                 ${setDescription}
                 ${setHypothesis}
                 ${setTechnicalUncertainty}
                 ${setExperimentationLog}
                 ${setExpectedOutcome}
                 ${setActualOutcome}
                 updated_at = NOW()
           WHERE id = ${id}
             AND tenant_id = ${tenantId}
           RETURNING id, tenant_id, project_id, claim_id, code, kind, title,
                     description, hypothesis, technical_uncertainty,
                     experimentation_log, expected_outcome, actual_outcome,
                     created_at, updated_at
        `;
        const row = updated[0];
        if (!row) {
          // Should be unreachable — `before` saw the row under the same
          // tenant context inside this same tx.
          throw new Error('PATCH /v1/activities/:id: UPDATE returned no row');
        }
        return {
          kind: 'updated' as const,
          prev,
          row,
          subject_tenant_id: prev.subject_tenant_id,
        };
      });

      if (result.kind === 'not_found') {
        return reply.status(404).send({
          error: 'activity_not_found',
          message: 'No activity with that id in this firm',
          requestId: req.id,
        });
      }
      if (result.kind === 'claim_locked') {
        return reply.status(409).send({
          error: 'claim_locked',
          message: `Cannot edit an activity on a claim in stage "${result.stage}"`,
          requestId: req.id,
        });
      }
      if (result.kind === 'noop') {
        return reply.status(200).send({ activity: toApi(result.row) });
      }

      // Build the {from, to} field diff. Only include columns whose value
      // actually changed — a no-op patch (e.g. setting title to its
      // existing value) shouldn't pollute the audit chain.
      //
      // Local-copy of A1's `recordIfChanged` pattern; see TODO at top of
      // file for the cross-cutting extraction plan.
      const fieldsChanged: Record<string, { from: unknown; to: unknown }> = {};
      const recordIfChanged = (key: NarrativeField, from: unknown, to: unknown): void => {
        if (from !== to) fieldsChanged[key] = { from, to };
      };
      for (const key of NARRATIVE_FIELDS) {
        if (patch[key] !== undefined) {
          recordIfChanged(key, result.prev[key], result.row[key]);
        }
      }

      // Skip the event write when nothing actually changed.
      if (Object.keys(fieldsChanged).length > 0) {
        const updatedPayload = ActivityUpdatedPayload.parse({
          activity_id: result.row.id,
          fields_changed: fieldsChanged,
        });
        await insertEventWithChain({
          tenant_id: tenantId,
          subject_tenant_id: result.subject_tenant_id,
          project_id: result.row.project_id,
          kind: 'ACTIVITY_UPDATED',
          payload: updatedPayload,
          classification: null,
          captured_at: new Date(),
          captured_by_user_id: userId,
          override_of_event_id: null,
          override_new_kind: null,
          override_reason: null,
        });
      }

      return reply.status(200).send({ activity: toApi(result.row) });
    },
  );
}
