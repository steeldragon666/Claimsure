import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import { requireSession } from '@cpa/auth';
import { insertEventWithChain } from '@cpa/db';
import { privilegedSql, sql } from '@cpa/db/client';
import {
  apportionmentBody,
  createConsultantTimeEntryBody,
  createManualTimeEntryBody,
  listTimeEntriesQuery,
  updateTimeEntryBody,
  TimeEntryCreatedPayload,
  TimeEntryDeletedPayload,
  TimeEntryUpdatedPayload,
  type TimeEntry,
  type TimeEntrySource,
} from '@cpa/schemas';
import { requireMobileSession } from '../middleware/mobile-jwt-verifier.js';
import { toIsoRequired } from '../lib/iso.js';

/**
 * /v1/time-entries route surface (T-B22).
 *
 * Four endpoints across two auth shapes:
 *
 *   GET    /v1/time-entries                       — list (consultant OR mobile)
 *   POST   /v1/time-entries                       — manual create (mobile only)
 *   PATCH  /v1/time-entries/:id/apportionment     — set R&D %  (consultant)
 *   POST   /v1/time-entries/:id/clear-flag        — clear flagged_at (consultant)
 *
 * The consultant-side reads use `sql.begin` + `set_config` so RLS scopes
 * to the firm. Mobile reads / writes use `privilegedSql` and validate
 * the (subject_tenant_id, employee_id) tuple in-app — RLS-via-GUC
 * doesn't help here because the mobile principal has no `req.user`
 * and the connection-scoped GUC is set by the consultant-session
 * plugin only.
 *
 * Apportionment set + flag-clear go through privilegedSql for the
 * UPDATE: the route handler verifies the session has visibility on
 * the row first via a tenant-scoped SELECT, then issues the privileged
 * UPDATE. This pattern is consistent with the existing `employees.ts`
 * invite resend (look up under RLS, mutate via privileged).
 */

interface RawTimeEntryRow {
  id: string;
  tenant_id: string;
  subject_tenant_id: string;
  employee_id: string;
  source: TimeEntrySource;
  external_id: string | null;
  started_at: Date | string;
  ended_at: Date | string;
  duration_minutes: number;
  is_rd: boolean;
  apportionment_pct: string | number | null;
  apportioned_by_user_id: string | null;
  apportioned_at: Date | string | null;
  notes: string | null;
  flagged_at: Date | string | null;
  deleted_at: Date | string | null;
  created_at: Date | string;
}

const isoOf = (v: Date | string): string => (typeof v === 'string' ? v : v.toISOString());
const isoOrNull = (v: Date | string | null): string | null => (v === null ? null : isoOf(v));

const toApi = (r: RawTimeEntryRow): TimeEntry => ({
  id: r.id,
  tenant_id: r.tenant_id,
  subject_tenant_id: r.subject_tenant_id,
  employee_id: r.employee_id,
  source: r.source,
  external_id: r.external_id,
  started_at: isoOf(r.started_at),
  ended_at: isoOf(r.ended_at),
  duration_minutes: r.duration_minutes,
  is_rd: r.is_rd,
  // Postgres NUMERIC comes back as a string from postgres-js; coerce
  // to number for the API contract. Null stays null.
  apportionment_pct: r.apportionment_pct === null ? null : Number(r.apportionment_pct),
  apportioned_by_user_id: r.apportioned_by_user_id,
  apportioned_at: isoOrNull(r.apportioned_at),
  notes: r.notes,
  flagged_at: isoOrNull(r.flagged_at),
  deleted_at: isoOrNull(r.deleted_at),
  created_at: isoOf(r.created_at),
});

/**
 * Resolve the auth principal on the GET /v1/time-entries surface.
 * Returns the (tenantId, optional fixed-employee filter) tuple.
 *
 * Consultant: req.user populated via sessionPlugin. tenantId from
 * the session.
 * Mobile: req.mobileUser populated via requireMobileSession. tenantId
 * + subject_tenant_id from the JWT; employee filter is forced to the
 * JWT's `sub` so an employee can only see their own entries.
 */
type Principal =
  | { kind: 'consultant'; tenantId: string }
  | {
      kind: 'mobile';
      tenantId: string;
      subjectTenantId: string;
      employeeId: string;
    };

const errEnvelope = (
  code: string,
  message: string,
  requestId: string,
): { error: string; message: string; requestId: string } => ({
  error: code,
  message,
  requestId,
});

/**
 * Dual-auth preHandler: try consultant session first (cookie via
 * sessionPlugin already set req.user), then mobile JWT. Sets
 * req.mobileUser on success of the mobile path. 401 if neither
 * surfaces a principal.
 *
 * The consultant path is "did sessionPlugin populate req.user" — no
 * cookie work to do here because the session plugin runs upstream.
 * The mobile path delegates to `requireMobileSession` only when the
 * cookie path failed; we suppress the 401 from that helper by reading
 * the response state after, since `requireMobileSession` writes a 401
 * envelope itself.
 */
async function requireConsultantOrMobile(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.user) {
    if (req.user.tenantId === null) {
      await reply
        .status(403)
        .send(
          errEnvelope(
            'no_active_tenant',
            'No active firm — contact your firm admin to be added',
            req.id,
          ),
        );
      return;
    }
    return;
  }
  // No consultant session — attempt mobile. requireMobileSession sends
  // its own 401 envelope on failure, so we just call it and let it
  // shape the reply. (When it succeeds it leaves the reply alone.)
  await requireMobileSession(req, reply);
}

function getPrincipal(req: FastifyRequest): Principal | null {
  if (req.user && req.user.tenantId !== null) {
    return { kind: 'consultant', tenantId: req.user.tenantId };
  }
  if (req.mobileUser) {
    return {
      kind: 'mobile',
      tenantId: req.mobileUser.tenantId,
      subjectTenantId: req.mobileUser.subjectTenantId,
      employeeId: req.mobileUser.employeeId,
    };
  }
  return null;
}

export function registerTimeEntries(app: FastifyInstance): void {
  // GET /v1/time-entries — list, consultant session OR mobile JWT.
  app.get('/v1/time-entries', { preHandler: requireConsultantOrMobile }, async (req, reply) => {
    const principal = getPrincipal(req);
    if (!principal) {
      // Should never reach here — preHandler already replied — but
      // belt-and-braces: don't double-reply.
      if (!reply.sent) {
        return reply.status(401).send(errEnvelope('unauthenticated', 'No session', req.id));
      }
      return;
    }
    const parsed = listTimeEntriesQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .status(400)
        .send(
          errEnvelope(
            'invalid_query',
            'Query must include subject_tenant_id; from/to are YYYY-MM-DD',
            req.id,
          ),
        );
    }
    const q = parsed.data;

    // Mobile principals are forced to their own claimant + employee.
    if (principal.kind === 'mobile') {
      if (q.subject_tenant_id !== principal.subjectTenantId) {
        return reply
          .status(403)
          .send(
            errEnvelope(
              'forbidden',
              'Mobile sessions are restricted to their own claimant',
              req.id,
            ),
          );
      }
      if (q.employee_id && q.employee_id !== principal.employeeId) {
        return reply
          .status(403)
          .send(
            errEnvelope(
              'forbidden',
              'Mobile sessions are restricted to their own employee_id',
              req.id,
            ),
          );
      }
    }

    // Compose the WHERE clauses from optional filters. Build by
    // dispatching on the combination of present filters — simpler
    // than dynamic SQL for v1 and explicit at the tagged-template
    // boundary.
    const tenantId = principal.tenantId;
    const empFilter = principal.kind === 'mobile' ? principal.employeeId : (q.employee_id ?? null);
    const fromTs = q.from ? `${q.from}T00:00:00Z` : null;
    // 'to' is inclusive at the day boundary. Use < (next-day-00:00)
    // semantics by adding a day; but for v1 we just take 23:59:59Z
    // of the supplied day to keep the boundary obvious in SQL.
    const toTs = q.to ? `${q.to}T23:59:59Z` : null;

    const rows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
      const r = await tx<RawTimeEntryRow[]>`
          SELECT id, tenant_id, subject_tenant_id, employee_id, source, external_id,
                 started_at, ended_at, duration_minutes, is_rd, apportionment_pct,
                 apportioned_by_user_id, apportioned_at, notes, flagged_at, deleted_at, created_at
            FROM time_entry
           WHERE subject_tenant_id = ${q.subject_tenant_id}
             AND (${empFilter}::uuid IS NULL OR employee_id = ${empFilter}::uuid)
             AND (${fromTs}::timestamptz IS NULL OR started_at >= ${fromTs}::timestamptz)
             AND (${toTs}::timestamptz IS NULL OR started_at <= ${toTs}::timestamptz)
             AND (${q.include_flagged} = true OR flagged_at IS NULL)
             AND deleted_at IS NULL
           ORDER BY started_at DESC
        `;
      return r;
    });

    return { time_entries: rows.map(toApi) };
  });

  // POST /v1/time-entries — manual create (mobile OR consultant session).
  //
  // Mobile path: body is createManualTimeEntryBody; employee is derived from
  // the JWT `sub`. Source = 'manual'. No chain event (mobile-created entries
  // predate the consultant audit trail — consistent with the existing pattern).
  //
  // Consultant path: body is createConsultantTimeEntryBody; employee_id and
  // subject_tenant_id are explicit. Source = 'consultant_manual'. Emits
  // TIME_ENTRY_CREATED on the chain.
  app.post('/v1/time-entries', { preHandler: requireConsultantOrMobile }, async (req, reply) => {
    const principal = getPrincipal(req);
    if (!principal) {
      if (!reply.sent) {
        return reply.status(401).send(errEnvelope('unauthenticated', 'No session', req.id));
      }
      return;
    }

    // ---- Mobile path ----
    if (principal.kind === 'mobile') {
      const parsed = createManualTimeEntryBody.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send(
            errEnvelope(
              'invalid_body',
              'Body must be { started_at, ended_at, is_rd?, notes? } with ended_at > started_at',
              req.id,
            ),
          );
      }
      const { started_at, ended_at, is_rd, notes } = parsed.data;

      // Confirm the mobile principal's employee row is still active.
      const empRows = await privilegedSql<{ id: string; deactivated_at: Date | null }[]>`
        SELECT id, deactivated_at FROM subject_tenant_employee
         WHERE id = ${principal.employeeId}
           AND tenant_id = ${principal.tenantId}
           AND subject_tenant_id = ${principal.subjectTenantId}
      `;
      const emp = empRows[0];
      if (!emp || emp.deactivated_at !== null) {
        return reply
          .status(401)
          .send(errEnvelope('unauthenticated', 'employee not active', req.id));
      }

      const durationMs = new Date(ended_at).getTime() - new Date(started_at).getTime();
      const duration_minutes = Math.round(durationMs / 60_000);
      if (duration_minutes <= 0) {
        return reply
          .status(400)
          .send(
            errEnvelope(
              'invalid_body',
              'Duration must be positive (ended_at > started_at)',
              req.id,
            ),
          );
      }

      const entryId = crypto.randomUUID();
      const inserted = await privilegedSql<RawTimeEntryRow[]>`
        INSERT INTO time_entry (
          id, tenant_id, subject_tenant_id, employee_id,
          source, external_id,
          started_at, ended_at, duration_minutes,
          is_rd, notes
        ) VALUES (
          ${entryId}, ${principal.tenantId}, ${principal.subjectTenantId},
          ${principal.employeeId},
          'manual', ${null},
          ${started_at}::timestamptz, ${ended_at}::timestamptz,
          ${duration_minutes},
          ${is_rd}, ${notes ?? null}
        )
        RETURNING id, tenant_id, subject_tenant_id, employee_id, source, external_id,
                  started_at, ended_at, duration_minutes, is_rd,
                  apportionment_pct, apportioned_by_user_id, apportioned_at,
                  notes, flagged_at, deleted_at, created_at
      `;
      const mobileRow = inserted[0];
      if (!mobileRow) {
        throw new Error('POST /v1/time-entries (mobile): INSERT returned no row');
      }
      return reply.status(201).send({ time_entry: toApi(mobileRow) });
    }

    // ---- Consultant path ----
    const role = req.user!.role;
    if (role !== 'admin' && role !== 'consultant') {
      return reply
        .status(403)
        .send(errEnvelope('forbidden', 'Admin or consultant role required', req.id));
    }

    const parsed = createConsultantTimeEntryBody.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send(
          errEnvelope(
            'invalid_body',
            'Body must be { subject_tenant_id, employee_id, started_at, ended_at, is_rd?, notes? } with ended_at > started_at',
            req.id,
          ),
        );
    }
    const { subject_tenant_id, employee_id, started_at, ended_at, is_rd, notes } = parsed.data;
    const tenantId = principal.tenantId;
    const userId = req.user!.id;

    // Verify the employee is active and belongs to the given claimant under RLS.
    const empRows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
      return await tx<{ id: string }[]>`
        SELECT id FROM subject_tenant_employee
         WHERE id = ${employee_id}
           AND subject_tenant_id = ${subject_tenant_id}
           AND deactivated_at IS NULL
      `;
    });
    if (!empRows[0]) {
      return reply
        .status(404)
        .send(
          errEnvelope(
            'employee_not_found',
            'No active employee with that id for this claimant',
            req.id,
          ),
        );
    }

    const durationMs = new Date(ended_at).getTime() - new Date(started_at).getTime();
    const duration_minutes = Math.round(durationMs / 60_000);
    if (duration_minutes <= 0) {
      return reply
        .status(400)
        .send(
          errEnvelope('invalid_body', 'Duration must be positive (ended_at > started_at)', req.id),
        );
    }

    const entryId = crypto.randomUUID();
    // Insert via sql.begin + RLS context (same pattern as projects.ts POST).
    const inserted = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
      await tx`
        INSERT INTO time_entry (
          id, tenant_id, subject_tenant_id, employee_id,
          source, external_id,
          started_at, ended_at, duration_minutes,
          is_rd, notes
        ) VALUES (
          ${entryId}, ${tenantId}, ${subject_tenant_id},
          ${employee_id},
          'consultant_manual', ${null},
          ${started_at}::timestamptz, ${ended_at}::timestamptz,
          ${duration_minutes},
          ${is_rd}, ${notes ?? null}
        )
      `;
      const rows = await tx<RawTimeEntryRow[]>`
        SELECT id, tenant_id, subject_tenant_id, employee_id, source, external_id,
               started_at, ended_at, duration_minutes, is_rd,
               apportionment_pct, apportioned_by_user_id, apportioned_at,
               notes, flagged_at, deleted_at, created_at
          FROM time_entry
         WHERE id = ${entryId}
      `;
      return rows[0] ?? null;
    });

    if (!inserted) {
      throw new Error(
        'POST /v1/time-entries (consultant): INSERT succeeded but SELECT returned 0 rows',
      );
    }

    const createdPayload = TimeEntryCreatedPayload.parse({
      time_entry_id: inserted.id,
      employee_id: inserted.employee_id,
      // toIsoRequired (new Date(..).toISOString()) NORMALISES the pg
      // string timestamp to strict ISO-8601; the local isoOf passes pg's
      // space-separated format through unchanged, which the payload's
      // z.string().datetime() validator rejects → 500.
      started_at: toIsoRequired(inserted.started_at),
      duration_minutes: inserted.duration_minutes,
    });
    await insertEventWithChain({
      tenant_id: tenantId,
      subject_tenant_id: inserted.subject_tenant_id,
      project_id: null,
      kind: 'TIME_ENTRY_CREATED',
      payload: createdPayload,
      classification: null,
      captured_at: new Date(),
      captured_by_user_id: userId,
      override_of_event_id: null,
      override_new_kind: null,
      override_reason: null,
    });

    return reply.status(201).send({ time_entry: toApi(inserted) });
  });

  // PATCH /v1/time-entries/:id/apportionment — consultant sets R&D %.
  app.patch<{ Params: { id: string } }>(
    '/v1/time-entries/:id/apportionment',
    { preHandler: requireSession },
    async (req, reply) => {
      const role = req.user!.role;
      if (role !== 'admin' && role !== 'consultant') {
        return reply
          .status(403)
          .send(errEnvelope('forbidden', 'Admin or consultant role required', req.id));
      }
      const { id } = req.params;
      const parsed = apportionmentBody.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send(
            errEnvelope('invalid_body', 'Body must be { apportionment_pct: number 0-100 }', req.id),
          );
      }
      const { apportionment_pct } = parsed.data;
      const tenantId = req.user!.tenantId!;
      const userId = req.user!.id;

      // Verify visibility under RLS first — 404 on missing OR
      // cross-firm. Then apply the UPDATE via privilegedSql.
      const visibleRow = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<{ id: string }[]>`
          SELECT id FROM time_entry WHERE id = ${id}
        `;
        return rows[0] ?? null;
      });
      if (!visibleRow) {
        return reply
          .status(404)
          .send(
            errEnvelope('time_entry_not_found', 'No time_entry with that id in this firm', req.id),
          );
      }

      const updated = await privilegedSql<RawTimeEntryRow[]>`
        UPDATE time_entry
           SET apportionment_pct = ${apportionment_pct},
               apportioned_by_user_id = ${userId},
               apportioned_at = NOW()
         WHERE id = ${id}
        RETURNING id, tenant_id, subject_tenant_id, employee_id, source, external_id,
                  started_at, ended_at, duration_minutes, is_rd,
                  apportionment_pct, apportioned_by_user_id, apportioned_at,
                  notes, flagged_at, deleted_at, created_at
      `;
      const row = updated[0];
      if (!row) {
        // Row deleted between SELECT and UPDATE — vanishingly rare in
        // practice (no delete endpoint exists) but surface 404 rather
        // than 500.
        return reply
          .status(404)
          .send(errEnvelope('time_entry_not_found', 'time_entry vanished mid-request', req.id));
      }
      return { time_entry: toApi(row) };
    },
  );

  // POST /v1/time-entries/:id/clear-flag — consultant clears flagged_at.
  app.post<{ Params: { id: string } }>(
    '/v1/time-entries/:id/clear-flag',
    { preHandler: requireSession },
    async (req, reply) => {
      const role = req.user!.role;
      if (role !== 'admin' && role !== 'consultant') {
        return reply
          .status(403)
          .send(errEnvelope('forbidden', 'Admin or consultant role required', req.id));
      }
      const { id } = req.params;
      const tenantId = req.user!.tenantId!;

      // RLS visibility check — same pattern as the apportionment patch.
      const visibleRow = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<{ id: string }[]>`
          SELECT id FROM time_entry WHERE id = ${id}
        `;
        return rows[0] ?? null;
      });
      if (!visibleRow) {
        return reply
          .status(404)
          .send(
            errEnvelope('time_entry_not_found', 'No time_entry with that id in this firm', req.id),
          );
      }

      const updated = await privilegedSql<RawTimeEntryRow[]>`
        UPDATE time_entry
           SET flagged_at = NULL
         WHERE id = ${id}
        RETURNING id, tenant_id, subject_tenant_id, employee_id, source, external_id,
                  started_at, ended_at, duration_minutes, is_rd,
                  apportionment_pct, apportioned_by_user_id, apportioned_at,
                  notes, flagged_at, deleted_at, created_at
      `;
      const row = updated[0];
      if (!row) {
        return reply
          .status(404)
          .send(errEnvelope('time_entry_not_found', 'time_entry vanished mid-request', req.id));
      }
      return { time_entry: toApi(row) };
    },
  );

  // -----------------------------------------------------------------------
  // PATCH /v1/time-entries/:id — partial update of editable fields.
  // Distinct from PATCH /v1/time-entries/:id/apportionment (R&D % only).
  // -----------------------------------------------------------------------
  app.patch<{ Params: { id: string } }>(
    '/v1/time-entries/:id',
    { preHandler: requireSession },
    async (req, reply) => {
      const role = req.user!.role;
      if (role !== 'admin' && role !== 'consultant') {
        return reply
          .status(403)
          .send(errEnvelope('forbidden', 'Admin or consultant role required', req.id));
      }

      const parsed = updateTimeEntryBody.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send(
            errEnvelope(
              'invalid_body',
              'Body must be a partial update of { started_at?, ended_at?, is_rd?, notes? } with no extra keys',
              req.id,
            ),
          );
      }
      const patch = parsed.data;
      const { id } = req.params;
      const tenantId = req.user!.tenantId!;
      const userId = req.user!.id;

      const patchKeys = Object.keys(patch) as Array<keyof typeof patch>;

      const result = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const before = await tx<RawTimeEntryRow[]>`
          SELECT id, tenant_id, subject_tenant_id, employee_id, source, external_id,
                 started_at, ended_at, duration_minutes, is_rd,
                 apportionment_pct, apportioned_by_user_id, apportioned_at,
                 notes, flagged_at, deleted_at, created_at
            FROM time_entry
           WHERE id = ${id} AND deleted_at IS NULL
        `;
        const prev = before[0];
        if (!prev) return { kind: 'not_found' as const };
        if (patchKeys.length === 0) {
          return { kind: 'noop' as const, row: prev };
        }

        // Cross-field date validation (same pattern as projects.ts PATCH).
        const resultingStartedAt =
          patch.started_at !== undefined ? patch.started_at : isoOf(prev.started_at);
        const resultingEndedAt =
          patch.ended_at !== undefined ? patch.ended_at : isoOf(prev.ended_at);
        if (new Date(resultingEndedAt) <= new Date(resultingStartedAt)) {
          return { kind: 'invalid_range' as const };
        }

        // Recompute duration_minutes if either timestamp changes.
        const newDuration =
          patch.started_at !== undefined || patch.ended_at !== undefined
            ? Math.round(
                (new Date(resultingEndedAt).getTime() - new Date(resultingStartedAt).getTime()) /
                  60_000,
              )
            : prev.duration_minutes;

        const setStartedAt =
          patch.started_at !== undefined
            ? tx`started_at = ${patch.started_at}::timestamptz,`
            : tx``;
        const setEndedAt =
          patch.ended_at !== undefined ? tx`ended_at = ${patch.ended_at}::timestamptz,` : tx``;
        const setDuration =
          patch.started_at !== undefined || patch.ended_at !== undefined
            ? tx`duration_minutes = ${newDuration},`
            : tx``;
        const setIsRd = patch.is_rd !== undefined ? tx`is_rd = ${patch.is_rd},` : tx``;
        const setNotes = patch.notes !== undefined ? tx`notes = ${patch.notes},` : tx``;

        const updated = await tx<RawTimeEntryRow[]>`
          UPDATE time_entry
             SET ${setStartedAt}
                 ${setEndedAt}
                 ${setDuration}
                 ${setIsRd}
                 ${setNotes}
                 flagged_at = flagged_at
           WHERE id = ${id} AND deleted_at IS NULL
          RETURNING id, tenant_id, subject_tenant_id, employee_id, source, external_id,
                    started_at, ended_at, duration_minutes, is_rd,
                    apportionment_pct, apportioned_by_user_id, apportioned_at,
                    notes, flagged_at, deleted_at, created_at
        `;
        const row = updated[0];
        if (!row) {
          throw new Error('PATCH /v1/time-entries/:id: UPDATE returned no row');
        }
        return { kind: 'updated' as const, prev, row };
      });

      if (result.kind === 'not_found') {
        return reply
          .status(404)
          .send(
            errEnvelope('time_entry_not_found', 'No time_entry with that id in this firm', req.id),
          );
      }
      if (result.kind === 'invalid_range') {
        return reply
          .status(400)
          .send(errEnvelope('invalid_range', 'ended_at must be after started_at', req.id));
      }
      if (result.kind === 'noop') {
        return reply.status(200).send({ time_entry: toApi(result.row) });
      }

      // Build diff and emit chain event when something changed.
      const fieldsChanged: Record<string, { from: unknown; to: unknown }> = {};
      if (patch.started_at !== undefined) {
        const f = isoOf(result.prev.started_at);
        const t = isoOf(result.row.started_at);
        if (f !== t) fieldsChanged['started_at'] = { from: f, to: t };
      }
      if (patch.ended_at !== undefined) {
        const f = isoOf(result.prev.ended_at);
        const t = isoOf(result.row.ended_at);
        if (f !== t) fieldsChanged['ended_at'] = { from: f, to: t };
      }
      if (patch.is_rd !== undefined && result.prev.is_rd !== result.row.is_rd) {
        fieldsChanged['is_rd'] = { from: result.prev.is_rd, to: result.row.is_rd };
      }
      if (patch.notes !== undefined && result.prev.notes !== result.row.notes) {
        fieldsChanged['notes'] = { from: result.prev.notes, to: result.row.notes };
      }
      if (result.prev.duration_minutes !== result.row.duration_minutes) {
        fieldsChanged['duration_minutes'] = {
          from: result.prev.duration_minutes,
          to: result.row.duration_minutes,
        };
      }

      if (Object.keys(fieldsChanged).length > 0) {
        const updatedPayload = TimeEntryUpdatedPayload.parse({
          time_entry_id: result.row.id,
          fields_changed: fieldsChanged,
        });
        await insertEventWithChain({
          tenant_id: tenantId,
          subject_tenant_id: result.row.subject_tenant_id,
          project_id: null,
          kind: 'TIME_ENTRY_UPDATED',
          payload: updatedPayload,
          classification: null,
          captured_at: new Date(),
          captured_by_user_id: userId,
          override_of_event_id: null,
          override_new_kind: null,
          override_reason: null,
        });
      }

      return reply.status(200).send({ time_entry: toApi(result.row) });
    },
  );

  // -----------------------------------------------------------------------
  // DELETE /v1/time-entries/:id — soft-delete via deleted_at + emit TIME_ENTRY_DELETED.
  // -----------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>(
    '/v1/time-entries/:id',
    { preHandler: requireSession },
    async (req, reply) => {
      const role = req.user!.role;
      if (role !== 'admin' && role !== 'consultant') {
        return reply
          .status(403)
          .send(errEnvelope('forbidden', 'Admin or consultant role required', req.id));
      }

      const { id } = req.params;
      const tenantId = req.user!.tenantId!;
      const userId = req.user!.id;

      const result = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<{ id: string; subject_tenant_id: string }[]>`
          UPDATE time_entry
             SET deleted_at = NOW()
           WHERE id = ${id} AND deleted_at IS NULL
           RETURNING id, subject_tenant_id
        `;
        if (rows[0]) return { kind: 'deleted' as const, row: rows[0] };
        const existing = await tx<{ id: string; subject_tenant_id: string }[]>`
          SELECT id, subject_tenant_id FROM time_entry WHERE id = ${id}
        `;
        if (!existing[0]) return { kind: 'not_found' as const };
        return { kind: 'noop' as const };
      });

      if (result.kind === 'not_found') {
        return reply
          .status(404)
          .send(
            errEnvelope('time_entry_not_found', 'No time_entry with that id in this firm', req.id),
          );
      }

      if (result.kind === 'deleted') {
        const deletedPayload = TimeEntryDeletedPayload.parse({
          time_entry_id: id,
          deleted_by_user_id: userId,
        });
        await insertEventWithChain({
          tenant_id: tenantId,
          subject_tenant_id: result.row.subject_tenant_id,
          project_id: null,
          kind: 'TIME_ENTRY_DELETED',
          payload: deletedPayload,
          classification: null,
          captured_at: new Date(),
          captured_by_user_id: userId,
          override_of_event_id: null,
          override_new_kind: null,
          override_reason: null,
        });
      }

      // 204 for both first-delete and idempotent re-delete.
      return reply.status(204).send();
    },
  );
}
