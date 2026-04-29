import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { requireSession } from '@cpa/auth';
import { sql } from '@cpa/db/client';
import { insertEventWithChain } from '@cpa/db';
import {
  ArchiveProjectBody,
  CreateProjectBody,
  ListProjectsQuery,
  ProjectArchivedPayload,
  ProjectCreatedPayload,
  ProjectUpdatedPayload,
  UpdateProjectBody,
  type Project,
} from '@cpa/schemas';

// TODO(p4-a-cleanup): post-A1 review-flagged refactors deferred to a separate
// cross-cutting task after the swimlanes merge:
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

/**
 * Raw project row as stored in postgres. Columns are snake_case to match
 * the SQL surface; conversion to the wire format (still snake_case but
 * with ISO-8601 timestamps in place of Date objects) happens in
 * {@link toApi}.
 */
interface RawProjectRow {
  id: string;
  tenant_id: string;
  subject_tenant_id: string;
  name: string;
  description: string | null;
  started_at: Date | string;
  ended_at: Date | string | null;
  archived_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

// Normalise postgres timestamptz output to strict ISO 8601 with offset.
// postgres-js returns timestamptz columns either as Date OR as a string
// in postgres's native format like '2026-04-01 00:00:00+00' (depending
// on connection config). The native format fails Zod's `.datetime({offset:true})`
// because of the space-instead-of-T and the `+00` (not `+00:00`).
// Round-tripping through `new Date(...)` produces strict ISO regardless
// of input shape — Node's Date accepts both postgres native + ISO formats.
const isoOf = (v: Date | string): string =>
  v instanceof Date ? v.toISOString() : new Date(v).toISOString();
const isoOrNull = (v: Date | string | null): string | null => (v === null ? null : isoOf(v));

const toApi = (r: RawProjectRow): Project => ({
  id: r.id,
  tenant_id: r.tenant_id,
  subject_tenant_id: r.subject_tenant_id,
  name: r.name,
  description: r.description,
  started_at: isoOf(r.started_at),
  ended_at: isoOrNull(r.ended_at),
  archived_at: isoOrNull(r.archived_at),
  created_at: isoOf(r.created_at),
  updated_at: isoOf(r.updated_at),
});

/**
 * Register the project CRUD routes (T-A1 of the P4 plan).
 *
 * Auth: requireSession + admin-or-consultant gating on mutations.
 *   - Viewers can list/detail but cannot create/update/archive.
 *
 * RLS: every read/write inside `sql.begin` sets `app.current_tenant_id`
 * so the `project_tenant_isolation` policy filters cross-firm rows
 * automatically (added in F2 alongside the project table).
 *
 * Event chain: each mutation extends the per-claimant hash chain via
 * `insertEventWithChain` from `@cpa/db`. The helper holds a
 * pg_advisory_xact_lock per-subject_tenant so concurrent mutations on
 * the same chain serialise; mutations on different claimants do not
 * block each other.
 *
 * PROJECT_UPDATED kind: T-A1 introduces a new state-transition kind
 * rather than reusing PROJECT_CREATED for partial updates — see the
 * `evidenceKind` enum and migration `0015_project_updated_kind.sql`
 * for the rationale.
 */
export function registerProjects(app: FastifyInstance): void {
  // ---------------------------------------------------------------------
  // POST /v1/projects — create + emit PROJECT_CREATED.
  // ---------------------------------------------------------------------
  app.post('/v1/projects', { preHandler: requireSession }, async (req, reply) => {
    const role = req.user!.role;
    if (role !== 'admin' && role !== 'consultant') {
      return reply.status(403).send({
        error: 'forbidden',
        message: 'Admin or consultant role required',
        requestId: req.id,
      });
    }

    const parsed = CreateProjectBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'invalid_body',
        message:
          'Body must be { subject_tenant_id, name, description?, started_at, ended_at? } with ISO-8601 timestamps',
        requestId: req.id,
      });
    }
    const { subject_tenant_id, name, description, started_at, ended_at } = parsed.data;
    const tenantId = req.user!.tenantId!;
    const userId = req.user!.id;

    // Confirm the subject_tenant is visible under RLS — guards against
    // cross-firm subject_tenant_id (404) or being asked to create under
    // a soft-deleted claimant.
    let subjectVisible: boolean;
    try {
      subjectVisible = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<{ id: string }[]>`
          SELECT id FROM subject_tenant
           WHERE id = ${subject_tenant_id} AND deleted_at IS NULL
        `;
        return rows[0] != null;
      });
    } catch (e) {
      const err = e as Error;
      console.error('[POST /v1/projects subjectVisible FAILED]', {
        name: err.name,
        message: err.message,
        stack: err.stack?.split('\n').slice(0, 8).join('\n'),
        tenantId,
        subject_tenant_id,
      });
      throw e;
    }
    if (!subjectVisible) {
      return reply.status(404).send({
        error: 'subject_tenant_not_found',
        message: 'No subject_tenant with that id in this firm',
        requestId: req.id,
      });
    }

    // Insert the project row. ISO-string + ::timestamptz cast on the
    // started_at/ended_at parameters mirrors the chain.ts pattern —
    // postgres-js v3.4.9 + Node 22 doesn't round-trip Date params on
    // the prepared-statement bind path.
    //
    // Pattern: INSERT (no RETURNING) → SELECT to fetch back. The PATCH
    // handler in this file relies on a SELECT-before-UPDATE ordering
    // that "warms up" the RLS GUC for the subsequent RETURNING; POST
    // had no such prior SELECT and was hitting a RETURNING-returns-0-rows
    // bug under RLS USING when the GUC propagation through the bind
    // path was incomplete (test #337 in PR #4 CI). Splitting INSERT
    // from RETURNING into two statements removes that dependency: we
    // generate the id client-side, INSERT it, then SELECT WHERE id=...
    // and rely on the SELECT (a normal, non-RETURNING read) to return
    // the row under the policy that we've already proved works for
    // SELECT (the subjectVisible check above passes the same way).
    const newProjectId = crypto.randomUUID();
    let inserted: RawProjectRow | null;
    try {
      inserted = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        await tx`
          INSERT INTO project (
            id, tenant_id, subject_tenant_id, name, description,
            started_at, ended_at
          )
          VALUES (
            ${newProjectId}, ${tenantId}, ${subject_tenant_id}, ${name},
            ${description ?? null},
            ${started_at}::timestamptz,
            ${ended_at ?? null}::timestamptz
          )
        `;
        const rows = await tx<RawProjectRow[]>`
          SELECT id, tenant_id, subject_tenant_id, name, description,
                 started_at, ended_at, archived_at, created_at, updated_at
            FROM project
           WHERE id = ${newProjectId}
        `;
        return rows[0] ?? null;
      });
    } catch (e) {
      const err = e as Error;
      console.error('[POST /v1/projects projectInsert FAILED]', {
        name: err.name,
        message: err.message,
        stack: err.stack?.split('\n').slice(0, 10).join('\n'),
        tenantId,
        subject_tenant_id,
        started_at,
        ended_at: ended_at ?? null,
      });
      throw e;
    }
    if (!inserted) {
      throw new Error(
        'POST /v1/projects: INSERT succeeded but follow-up SELECT returned 0 rows — RLS USING policy must be filtering even the post-INSERT SELECT, which would be a deeper bug than RETURNING-only',
      );
    }

    // Extend the chain with PROJECT_CREATED. captured_at = now() so
    // the timeline reflects creation order; payload mirrors
    // `ProjectCreatedPayload` in @cpa/schemas — we `parse()` here so a
    // future refactor that drifts the payload shape blows up at the
    // boundary (programming error) rather than landing a malformed
    // event on the chain.
    let createdPayload;
    try {
      createdPayload = ProjectCreatedPayload.parse({
        project_id: inserted.id,
        name: inserted.name,
        started_at: isoOf(inserted.started_at),
      });
    } catch (e) {
      const err = e as Error;
      console.error('[POST /v1/projects ProjectCreatedPayload.parse FAILED]', {
        name: err.name,
        message: err.message,
        stack: err.stack?.split('\n').slice(0, 8).join('\n'),
        // Don't dump full inserted object; show shape:
        inserted_id_type: typeof inserted.id,
        inserted_id: inserted.id,
        inserted_name_type: typeof inserted.name,
        inserted_name: inserted.name,
        inserted_started_at_type: typeof inserted.started_at,
        inserted_started_at: inserted.started_at,
      });
      throw e;
    }
    try {
      await insertEventWithChain({
        tenant_id: tenantId,
        subject_tenant_id,
        project_id: inserted.id,
        kind: 'PROJECT_CREATED',
        payload: createdPayload,
        classification: null,
        captured_at: new Date(),
        captured_by_user_id: userId,
        override_of_event_id: null,
        override_new_kind: null,
        override_reason: null,
      });
    } catch (e) {
      // Temporary diagnostic: surface the underlying error to the client so
      // CI test output captures the root cause for PR #4 test #337. Will be
      // reverted once the issue is identified and fixed.
      const err = e as Error;
      // Use console.error directly (LOG_LEVEL=silent in CI suppresses pino).
      console.error('[PROJECT_CREATED chain insert FAILED]', {
        name: err.name,
        message: err.message,
        stack: err.stack?.split('\n').slice(0, 10).join('\n'),
        payload: createdPayload,
        tenant_id: tenantId,
        subject_tenant_id,
        project_id: inserted.id,
      });
      throw e;
    }

    return reply.status(201).send({ project: toApi(inserted) });
  });

  // ---------------------------------------------------------------------
  // GET /v1/projects?subject_tenant_id=... — list (RLS filters cross-firm).
  // ---------------------------------------------------------------------
  app.get('/v1/projects', { preHandler: requireSession }, async (req, reply) => {
    const parsed = ListProjectsQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'invalid_query',
        message: 'Query must match { subject_tenant_id?: uuid }',
        requestId: req.id,
      });
    }
    const { subject_tenant_id } = parsed.data;
    const tenantId = req.user!.tenantId!;

    return await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
      // Filter archived_at IS NULL by default — archived projects stay
      // queryable for prior-year claims but are filtered from default
      // active lists (per the schema docstring on `project.archived_at`).
      const rows = subject_tenant_id
        ? await tx<RawProjectRow[]>`
            SELECT id, tenant_id, subject_tenant_id, name, description,
                   started_at, ended_at, archived_at, created_at, updated_at
              FROM project
             WHERE subject_tenant_id = ${subject_tenant_id}
               AND archived_at IS NULL
             ORDER BY started_at ASC
          `
        : await tx<RawProjectRow[]>`
            SELECT id, tenant_id, subject_tenant_id, name, description,
                   started_at, ended_at, archived_at, created_at, updated_at
              FROM project
             WHERE archived_at IS NULL
             ORDER BY started_at ASC
          `;
      return { projects: rows.map(toApi) };
    });
  });

  // ---------------------------------------------------------------------
  // GET /v1/projects/:id — detail (admin/consultant/viewer all allowed).
  // ---------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/v1/projects/:id',
    { preHandler: requireSession },
    async (req, reply) => {
      const { id } = req.params;
      const tenantId = req.user!.tenantId!;
      return await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<RawProjectRow[]>`
          SELECT id, tenant_id, subject_tenant_id, name, description,
                 started_at, ended_at, archived_at, created_at, updated_at
            FROM project
           WHERE id = ${id}
        `;
        const row = rows[0];
        if (!row) {
          return reply.status(404).send({
            error: 'project_not_found',
            message: 'No project with that id in this firm',
            requestId: req.id,
          });
        }
        return { project: toApi(row) };
      });
    },
  );

  // ---------------------------------------------------------------------
  // PATCH /v1/projects/:id — partial update + emit PROJECT_UPDATED.
  // ---------------------------------------------------------------------
  app.patch<{ Params: { id: string } }>(
    '/v1/projects/:id',
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

      const parsed = UpdateProjectBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'invalid_body',
          message:
            'Body must be a partial update of { name?, description?, started_at?, ended_at? } with no extra keys',
          requestId: req.id,
        });
      }
      const patch = parsed.data;
      const { id } = req.params;
      const tenantId = req.user!.tenantId!;
      const userId = req.user!.id;

      // Empty patch — nothing to do, but still 200 with the current row.
      // We could 400 here, but the "no-op PATCH" idiom is friendlier for
      // optimistic UI clients that resubmit a form unchanged.
      const patchKeys = Object.keys(patch) as Array<keyof typeof patch>;

      // Load the current row + perform the update in one transaction
      // so the {from, to} diff is computed against the row that's
      // actually being mutated (no read-modify-write race).
      const result = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const before = await tx<RawProjectRow[]>`
          SELECT id, tenant_id, subject_tenant_id, name, description,
                 started_at, ended_at, archived_at, created_at, updated_at
            FROM project
           WHERE id = ${id}
        `;
        const prev = before[0];
        if (!prev) return { kind: 'not_found' as const };
        // Reject patches against archived projects — once archived, the
        // row is read-only (consultants must un-archive via a separate
        // admin flow, out of scope for A1).
        if (prev.archived_at !== null) {
          return { kind: 'archived' as const };
        }
        if (patchKeys.length === 0) {
          return { kind: 'noop' as const, row: prev };
        }

        // Cross-field date validation server-side. The schema's `.refine()`
        // catches the both-fields-in-patch case, but a PATCH that supplies
        // only `started_at` (with the existing `ended_at` already on the
        // row) or only `ended_at` (with the existing `started_at`) needs
        // the combined value to validate. Compute the resulting pair and
        // reject inverted ranges with a 400.
        const resultingStartedAt =
          patch.started_at !== undefined ? patch.started_at : isoOf(prev.started_at);
        const resultingEndedAt =
          patch.ended_at !== undefined ? patch.ended_at : isoOrNull(prev.ended_at);
        if (
          resultingEndedAt !== null &&
          new Date(resultingStartedAt) > new Date(resultingEndedAt)
        ) {
          return { kind: 'invalid_range' as const };
        }

        // Per-column conditional UPDATE — postgres-js supports
        // `column = COALESCE($newOrSentinel, column)` style updates, but
        // the cleanest path that preserves null-vs-undefined semantics
        // is an explicit SET list. We build it via tagged template
        // fragments so each parametrised value remains bound (no string
        // interpolation of values).
        const setName = patch.name !== undefined ? tx`name = ${patch.name},` : tx``;
        const setDescription =
          patch.description !== undefined ? tx`description = ${patch.description},` : tx``;
        const setStartedAt =
          patch.started_at !== undefined
            ? tx`started_at = ${patch.started_at}::timestamptz,`
            : tx``;
        const setEndedAt =
          patch.ended_at !== undefined ? tx`ended_at = ${patch.ended_at}::timestamptz,` : tx``;

        const updated = await tx<RawProjectRow[]>`
          UPDATE project
             SET ${setName}
                 ${setDescription}
                 ${setStartedAt}
                 ${setEndedAt}
                 updated_at = NOW()
           WHERE id = ${id}
           RETURNING id, tenant_id, subject_tenant_id, name, description,
                     started_at, ended_at, archived_at, created_at, updated_at
        `;
        const row = updated[0];
        if (!row) {
          // Should be unreachable — `before` saw the row under the same
          // tenant context inside this same tx.
          throw new Error('PATCH /v1/projects/:id: UPDATE returned no row');
        }
        return { kind: 'updated' as const, prev, row };
      });

      if (result.kind === 'not_found') {
        return reply.status(404).send({
          error: 'project_not_found',
          message: 'No project with that id in this firm',
          requestId: req.id,
        });
      }
      if (result.kind === 'archived') {
        return reply.status(409).send({
          error: 'project_archived',
          message: 'Cannot modify an archived project',
          requestId: req.id,
        });
      }
      if (result.kind === 'invalid_range') {
        return reply.status(400).send({
          error: 'invalid_range',
          message: 'ended_at must be on or after started_at',
          requestId: req.id,
        });
      }
      if (result.kind === 'noop') {
        return reply.status(200).send({ project: toApi(result.row) });
      }

      // Build the {from, to} field diff. Only include columns whose
      // value actually changed — a no-op patch (e.g. setting name to
      // its existing value) shouldn't pollute the audit chain.
      const fieldsChanged: Record<string, { from: unknown; to: unknown }> = {};
      const recordIfChanged = (
        key: 'name' | 'description' | 'started_at' | 'ended_at',
        from: unknown,
        to: unknown,
      ): void => {
        // started_at/ended_at compare via ISO string after toApi
        // normalisation so timezone-equivalent values don't false-fire.
        if (key === 'started_at' || key === 'ended_at') {
          const f = from === null ? null : isoOf(from as Date | string);
          const t = to === null ? null : isoOf(to as Date | string);
          if (f !== t) fieldsChanged[key] = { from: f, to: t };
          return;
        }
        if (from !== to) fieldsChanged[key] = { from, to };
      };
      if (patch.name !== undefined) recordIfChanged('name', result.prev.name, result.row.name);
      if (patch.description !== undefined) {
        recordIfChanged('description', result.prev.description, result.row.description);
      }
      if (patch.started_at !== undefined) {
        recordIfChanged('started_at', result.prev.started_at, result.row.started_at);
      }
      if (patch.ended_at !== undefined) {
        recordIfChanged('ended_at', result.prev.ended_at, result.row.ended_at);
      }

      // Skip the event write when nothing actually changed. Validate the
      // payload via Zod before insert — same rationale as POST: a future
      // refactor that drifts the `fields_changed` shape blows up at the
      // boundary rather than landing a malformed event.
      if (Object.keys(fieldsChanged).length > 0) {
        const updatedPayload = ProjectUpdatedPayload.parse({
          project_id: result.row.id,
          fields_changed: fieldsChanged,
        });
        await insertEventWithChain({
          tenant_id: tenantId,
          subject_tenant_id: result.row.subject_tenant_id,
          project_id: result.row.id,
          kind: 'PROJECT_UPDATED',
          payload: updatedPayload,
          classification: null,
          captured_at: new Date(),
          captured_by_user_id: userId,
          override_of_event_id: null,
          override_new_kind: null,
          override_reason: null,
        });
      }

      return reply.status(200).send({ project: toApi(result.row) });
    },
  );

  // ---------------------------------------------------------------------
  // DELETE /v1/projects/:id — soft delete + emit PROJECT_ARCHIVED.
  // ---------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>(
    '/v1/projects/:id',
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

      // Optional body: { reason } — surfaced on the PROJECT_ARCHIVED
      // payload. Empty body / no body is fine and very common (DELETE
      // requests typically omit a body).
      let reason: string | undefined;
      if (req.body !== undefined && req.body !== null) {
        const parsed = ArchiveProjectBody.safeParse(req.body);
        if (!parsed.success) {
          return reply.status(400).send({
            error: 'invalid_body',
            message: 'Body, when present, must be { reason?: string } with no extra keys',
            requestId: req.id,
          });
        }
        reason = parsed.data.reason;
      }

      const { id } = req.params;
      const tenantId = req.user!.tenantId!;
      const userId = req.user!.id;

      // Idempotent archive: re-archiving an already-archived project
      // is a 200 (no-op) rather than a 404, so retries don't cause
      // ledger pollution. We detect via the RETURNING clause being
      // empty when archived_at IS NOT NULL.
      const result = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<RawProjectRow[]>`
          UPDATE project
             SET archived_at = NOW(),
                 updated_at = NOW()
           WHERE id = ${id} AND archived_at IS NULL
           RETURNING id, tenant_id, subject_tenant_id, name, description,
                     started_at, ended_at, archived_at, created_at, updated_at
        `;
        if (rows[0]) return { kind: 'archived' as const, row: rows[0] };
        // Either the project doesn't exist (404) or it was already
        // archived (200 no-op). Disambiguate with a follow-up read.
        const existing = await tx<RawProjectRow[]>`
          SELECT id, tenant_id, subject_tenant_id, name, description,
                 started_at, ended_at, archived_at, created_at, updated_at
            FROM project
           WHERE id = ${id}
        `;
        if (!existing[0]) return { kind: 'not_found' as const };
        return { kind: 'noop' as const, row: existing[0] };
      });

      if (result.kind === 'not_found') {
        return reply.status(404).send({
          error: 'project_not_found',
          message: 'No project with that id in this firm',
          requestId: req.id,
        });
      }
      if (result.kind === 'noop') {
        // Already archived — return the row as-is, no event emitted.
        return reply.status(200).send({ project: toApi(result.row) });
      }

      // First-time archive — extend the chain. Same Zod-parse-at-boundary
      // pattern as POST/PATCH so a malformed payload fails fast.
      const archivedPayload = ProjectArchivedPayload.parse({
        project_id: result.row.id,
        archived_by_user_id: userId,
        ...(reason !== undefined ? { reason } : {}),
      });
      await insertEventWithChain({
        tenant_id: tenantId,
        subject_tenant_id: result.row.subject_tenant_id,
        project_id: result.row.id,
        kind: 'PROJECT_ARCHIVED',
        payload: archivedPayload,
        classification: null,
        captured_at: new Date(),
        captured_by_user_id: userId,
        override_of_event_id: null,
        override_new_kind: null,
        override_reason: null,
      });

      return reply.status(200).send({ project: toApi(result.row) });
    },
  );
}
