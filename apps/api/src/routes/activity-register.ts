import type { FastifyInstance } from 'fastify';
import { requireSession } from '@cpa/auth';
import { sql } from '@cpa/db/client';
import { ActivityRegisterDraftedPayload } from '@cpa/schemas';
import { isAgentEnabled, isTenantAllowed } from '@cpa/agents/runtime';
import { enqueueActivityRegisterSynthesize } from '../lib/enqueue-synthesize.js';

/**
 * Agent B activity-register endpoints (Task 4.4).
 *
 * Surface area:
 *
 *   POST /v1/projects/:id/activity-register/synthesize
 *     Admin/consultant only. Fires the Agent B synthesizer in the
 *     background (via {@link enqueueActivityRegisterSynthesize}) and
 *     returns 202 immediately with `{ requestId }`. The caller polls
 *     GET /latest to see when the new draft event lands.
 *
 *   GET /v1/projects/:id/activity-register/latest
 *     Admin/consultant/viewer read access. Returns the latest
 *     `ACTIVITY_REGISTER_DRAFTED` event for the project plus a derived
 *     status: `'none'` (no draft yet), `'pending'` (draft exists, not
 *     all proposals accepted), `'complete'` (all proposed_activities
 *     promoted to real activity rows via Task 4.5's accept endpoint).
 *
 * Feature-flag + tenant-allowlist gates live inside the synthesize
 * shim (`enqueue-synthesize.ts`), NOT in the route. The synthesize
 * route surfaces a disabled feature as 503; the latest route is
 * unaffected (it doesn't call the agent — it reads the chain).
 *
 * The accept endpoint (Task 4.5) lands in a follow-up commit.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ProjectGuardResult = { kind: 'project_not_found' } | { kind: 'ok'; subject_tenant_id: string };

/**
 * Resolve the project under the caller's tenant (RLS-scoped). Returns
 * `project_not_found` when the project doesn't exist or belongs to a
 * different firm; the route maps both to 404 (we deliberately don't
 * leak the existence of a foreign tenant's project).
 */
async function loadProjectForTenant(
  projectId: string,
  tenantId: string,
): Promise<ProjectGuardResult> {
  return await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
    const rows = await tx<{ id: string; subject_tenant_id: string }[]>`
      SELECT id, subject_tenant_id
        FROM project
       WHERE id = ${projectId}
         AND tenant_id = ${tenantId}
    `;
    const row = rows[0];
    if (!row) return { kind: 'project_not_found' as const };
    return { kind: 'ok' as const, subject_tenant_id: row.subject_tenant_id };
  });
}

type LatestDraftRow = {
  id: string;
  payload: unknown;
  captured_at: Date | string;
};

/**
 * Fetch the latest `ACTIVITY_REGISTER_DRAFTED` event for the project,
 * scoped to the caller's tenant via RLS. Returns `null` when no draft
 * has landed yet.
 */
async function loadLatestDraft(
  projectId: string,
  tenantId: string,
): Promise<{
  event: LatestDraftRow;
  parsed: ActivityRegisterDraftedPayload;
} | null> {
  const rows = await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
    return await tx<LatestDraftRow[]>`
      SELECT id, payload, captured_at
        FROM event
       WHERE tenant_id = ${tenantId}
         AND project_id = ${projectId}
         AND kind = 'ACTIVITY_REGISTER_DRAFTED'
       ORDER BY captured_at DESC, received_at DESC, id DESC
       LIMIT 1
    `;
  });
  const row = rows[0];
  if (!row) return null;
  // Defensive parse: any malformed event is the synthesizer's bug, not
  // the caller's. Throwing here propagates as a 500, which is the right
  // error class — the route can't synthesize a sensible response from a
  // payload it can't parse.
  const parsed = ActivityRegisterDraftedPayload.parse(row.payload);
  return { event: row, parsed };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerActivityRegister(app: FastifyInstance): void {
  // ---------------------------------------------------------------------
  // POST /v1/projects/:id/activity-register/synthesize
  // ---------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/v1/projects/:id/activity-register/synthesize',
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
      const projectId = req.params.id;

      // 503 surface for the feature flag / allowlist. We intentionally
      // duplicate the gate check here (the shim also short-circuits)
      // so the API contract is explicit: callers see 503 when they
      // can't run the agent at all, vs. 202 + a never-arriving draft
      // event if the gate were silently elided.
      if (!isAgentEnabled('B') || !isTenantAllowed(tenantId)) {
        return reply.status(503).send({
          error: 'feature_disabled',
          message: 'Activity register synthesizer is currently disabled for this tenant',
          requestId: req.id,
        });
      }

      const guard = await loadProjectForTenant(projectId, tenantId);
      if (guard.kind === 'project_not_found') {
        return reply.status(404).send({
          error: 'project_not_found',
          message: 'No project with that id in this firm',
          requestId: req.id,
        });
      }

      // Fire-and-forget. Production code does NOT await — the route
      // returns 202 immediately and the job runs in the background.
      // Tests use `enqueueActivityRegisterSynthesize` directly when
      // they need deterministic behaviour.
      void enqueueActivityRegisterSynthesize({
        tenant_id: tenantId,
        project_id: projectId,
      });

      return reply.status(202).send({ requestId: req.id });
    },
  );

  // ---------------------------------------------------------------------
  // GET /v1/projects/:id/activity-register/latest
  // ---------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/v1/projects/:id/activity-register/latest',
    { preHandler: requireSession },
    async (req, reply) => {
      const tenantId = req.user!.tenantId!;
      const projectId = req.params.id;

      const guard = await loadProjectForTenant(projectId, tenantId);
      if (guard.kind === 'project_not_found') {
        return reply.status(404).send({
          error: 'project_not_found',
          message: 'No project with that id in this firm',
          requestId: req.id,
        });
      }

      const latest = await loadLatestDraft(projectId, tenantId);
      if (!latest) {
        return reply.status(200).send({
          status: 'none' as const,
          latest_event: null,
          accepted_count: 0,
          total_proposed: 0,
        });
      }

      const proposedIds = latest.parsed.proposed_activities.map((p) => p.proposed_id);
      const totalProposed = proposedIds.length;

      // Count ACTIVITY_CREATED events for this project whose
      // payload.proposed_id is in the set of proposed_ids from the
      // latest draft. We use jsonb's `->>` operator + ANY() because
      // postgres-js binds string[] cleanly. RLS-scoped via the GUC.
      //
      // Pre-Task-4.5 contract: ACTIVITY_CREATED payloads do not yet
      // carry a `proposed_id` field (the accept endpoint that emits
      // it lands in the next commit). Until then the count is always
      // 0 and `status` is always 'pending' for any non-empty draft.
      let acceptedCount = 0;
      if (totalProposed > 0) {
        acceptedCount = await sql.begin(async (tx) => {
          await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
          const rows = await tx<{ count: string }[]>`
            SELECT COUNT(DISTINCT payload ->> 'proposed_id')::text AS count
              FROM event
             WHERE tenant_id = ${tenantId}
               AND project_id = ${projectId}
               AND kind = 'ACTIVITY_CREATED'
               AND payload ->> 'proposed_id' = ANY(${proposedIds}::text[])
          `;
          return Number(rows[0]?.count ?? 0);
        });
      }

      // 'complete' only when the draft has at least one proposed
      // activity AND all of them are accepted. An empty draft (the
      // synthesizer found no coherent clusters) stays 'pending' —
      // there's nothing to accept, but there's also nothing to be
      // 'complete' about. Callers can detect this via total_proposed.
      const status =
        totalProposed > 0 && acceptedCount >= totalProposed
          ? ('complete' as const)
          : ('pending' as const);

      return reply.status(200).send({
        status,
        latest_event: {
          id: latest.event.id,
          kind: 'ACTIVITY_REGISTER_DRAFTED' as const,
          captured_at:
            typeof latest.event.captured_at === 'string'
              ? new Date(latest.event.captured_at).toISOString()
              : latest.event.captured_at.toISOString(),
          payload: latest.parsed,
        },
        accepted_count: acceptedCount,
        total_proposed: totalProposed,
      });
    },
  );
}
