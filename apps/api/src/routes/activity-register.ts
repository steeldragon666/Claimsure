import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import { insertEventWithChain, nextActivityCode } from '@cpa/db';
import {
  ActivityCreatedPayload,
  ActivityRegisterDraftedPayload,
  type ProposedActivity,
  Uuid,
} from '@cpa/schemas';
import { isAgentEnabled, isTenantAllowed } from '@cpa/agents/runtime';
import { enqueueActivityRegisterSynthesize } from '../lib/enqueue-synthesize.js';

/**
 * Agent B activity-register endpoints (Tasks 4.4 + 4.5).
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
 *     Admin/consultant/viewer/auditor read access. Returns the latest
 *     `ACTIVITY_REGISTER_DRAFTED` event for the project plus a derived
 *     status: `'none'` (no draft yet), `'pending'` (draft exists, not
 *     all proposals accepted), `'complete'` (all proposed_activities
 *     promoted to real activity rows via the accept endpoint below).
 *
 *   POST /v1/projects/:id/activity-register/accept
 *     Admin/consultant only. Promotes one or more proposed activities
 *     from the latest draft into real `activity` rows. Idempotent on
 *     `proposed_id` — a re-accept is a no-op. Optional per-row edits
 *     (name / kind / statutory_anchor) overlay the proposed values.
 *
 * Feature-flag + tenant-allowlist gates live inside the synthesize
 * shim (`enqueue-synthesize.ts`), NOT in the route. The synthesize
 * route surfaces a disabled feature as 503; the accept + latest
 * routes are unaffected (they don't call the agent — they read the
 * chain that the agent already wrote).
 */

// ---------------------------------------------------------------------------
// Response / body schemas
// ---------------------------------------------------------------------------

/**
 * Per-row body for {@link AcceptActivityRegisterBody}. Each acceptance
 * carries the synthesizer-minted `proposed_id` plus an optional `edits`
 * overlay. Edits are only validated when present — a bare
 * `{ proposed_id }` is the common path (consultant accepted the
 * proposal verbatim).
 *
 * Edits intentionally exclude `proposed_hypothesis` / `proposed_uncertainty`:
 * those propagate verbatim to Agent C's narrative drafter and are not
 * part of the acceptance contract. Per-activity narrative edits land
 * on the `activity` row via the existing PATCH /v1/activities/:id flow.
 */
const AcceptanceEdits = z
  .object({
    name: z.string().min(1).max(200).optional(),
    kind: z.enum(['core', 'supporting']).optional(),
    statutory_anchor: z.enum(['s.355-25', 's.355-30']).optional(),
  })
  .strict();

const AcceptanceItem = z
  .object({
    proposed_id: Uuid,
    edits: AcceptanceEdits.optional(),
  })
  .strict();

const AcceptActivityRegisterBody = z
  .object({
    acceptances: z.array(AcceptanceItem).min(1),
  })
  .strict();
type AcceptActivityRegisterBody = z.infer<typeof AcceptActivityRegisterBody>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Canonical kind ↔ anchor pairing. `core` always pairs with `s.355-25`
 * (systematic experimentation, Division 355 §355-25); `supporting`
 * always pairs with `s.355-30` (directly contributing). Mirrored in
 * `packages/agents/src/synthesizer-register/types.ts` and enforced by
 * the synthesizer's prompt + tool schema. Repeated here so the route
 * can validate consultant edits without importing from `@cpa/agents`
 * (the package boundary is asymmetric — agents may grow runtime deps
 * the API doesn't want to pull through).
 */
function anchorForKind(kind: 'core' | 'supporting'): 's.355-25' | 's.355-30' {
  return kind === 'core' ? 's.355-25' : 's.355-30';
}

function isCanonicalPair(kind: 'core' | 'supporting', anchor: 's.355-25' | 's.355-30'): boolean {
  return anchorForKind(kind) === anchor;
}

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

  // ---------------------------------------------------------------------
  // POST /v1/projects/:id/activity-register/accept
  // ---------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/v1/projects/:id/activity-register/accept',
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

      const parsed = AcceptActivityRegisterBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'invalid_body',
          message:
            'Body must be { acceptances: Array<{ proposed_id: uuid, edits?: { name?, kind?, statutory_anchor? } }> } with at least one entry',
          requestId: req.id,
        });
      }

      const tenantId = req.user!.tenantId!;
      const userId = req.user!.id;
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
        return reply.status(404).send({
          error: 'no_draft_register',
          message: 'No ACTIVITY_REGISTER_DRAFTED event for this project; run synthesize first',
          requestId: req.id,
        });
      }

      // Index proposals by id for O(1) lookup during the accept loop.
      const proposalsById = new Map<string, ProposedActivity>(
        latest.parsed.proposed_activities.map((p) => [p.proposed_id, p]),
      );

      // Pre-load: all ACTIVITY_CREATED events for this project whose
      // payload.proposed_id matches one of THIS draft's proposals. Used
      // to detect already-accepted proposals (idempotency). One read up
      // front is cheaper than a per-row probe inside the loop.
      const proposalIds = Array.from(proposalsById.keys());
      const existingAcceptanceById = new Map<string, { activity_id: string; code: string }>();
      if (proposalIds.length > 0) {
        const rows = await sql.begin(async (tx) => {
          await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
          return await tx<{ proposed_id: string; activity_id: string; code: string }[]>`
            SELECT payload ->> 'proposed_id'  AS proposed_id,
                   payload ->> 'activity_id'  AS activity_id,
                   payload ->> 'code'         AS code
              FROM event
             WHERE tenant_id = ${tenantId}
               AND project_id = ${projectId}
               AND kind = 'ACTIVITY_CREATED'
               AND payload ->> 'proposed_id' = ANY(${proposalIds}::text[])
          `;
        });
        for (const r of rows) {
          existingAcceptanceById.set(r.proposed_id, {
            activity_id: r.activity_id,
            code: r.code,
          });
        }
      }

      // We need a claim to FK each new activity row against. The
      // synthesizer doesn't pin a claim id — the proposed activities
      // are project-scoped. Pick the most-recent open claim for the
      // project's claimant. If none exists, the consultant must create
      // one before accepting — surface as a whole-request 409 since
      // none of the rows can land without it.
      const claimRows = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        return await tx<{ id: string }[]>`
          SELECT id
            FROM claim
           WHERE tenant_id = ${tenantId}
             AND project_id = ${projectId}
             AND stage NOT IN ('submitted', 'audit_defence')
           ORDER BY fiscal_year DESC, created_at DESC
           LIMIT 1
        `;
      });
      const claim = claimRows[0];
      if (!claim) {
        return reply.status(409).send({
          error: 'no_open_claim',
          message:
            'No open claim under this project — create or reopen a claim before accepting proposed activities',
          requestId: req.id,
        });
      }
      const claimId = claim.id;

      const accepted: Array<{
        proposed_id: string;
        activity_id: string;
        code: string;
        skipped_idempotent: boolean;
      }> = [];
      const rejected: Array<{ proposed_id: string; reason: string }> = [];

      for (const item of parsed.data.acceptances) {
        const proposed = proposalsById.get(item.proposed_id);
        if (!proposed) {
          rejected.push({
            proposed_id: item.proposed_id,
            reason: 'proposed_id not in latest ACTIVITY_REGISTER_DRAFTED for this project',
          });
          continue;
        }

        // Idempotency: a previous accept for this proposed_id already
        // wrote an ACTIVITY_CREATED event. Return the existing
        // activity_id + code rather than creating a duplicate row.
        const existing = existingAcceptanceById.get(item.proposed_id);
        if (existing) {
          accepted.push({
            proposed_id: item.proposed_id,
            activity_id: existing.activity_id,
            code: existing.code,
            skipped_idempotent: true,
          });
          continue;
        }

        // Resolve the effective fields: edits overlay the proposal.
        const effectiveKind = item.edits?.kind ?? proposed.kind;
        const effectiveAnchor = item.edits?.statutory_anchor ?? proposed.statutory_anchor;
        const effectiveName = item.edits?.name ?? proposed.name;

        // Validate canonical pairing AFTER edits land. A consultant
        // edit that flips kind without flipping anchor (or vice versa)
        // is a per-row reject. We surface the per-row failure rather
        // than 4xx-ing the whole request: a partial accept is the
        // common path (consultant ticks 4 of 5 boxes) and we want to
        // give them the 4 successful rows.
        if (!isCanonicalPair(effectiveKind, effectiveAnchor)) {
          rejected.push({
            proposed_id: item.proposed_id,
            reason: `kind '${effectiveKind}' must pair with anchor '${anchorForKind(effectiveKind)}', got '${effectiveAnchor}'`,
          });
          continue;
        }

        // Auto-generate the next CA-NN / SA-NN under the chosen claim.
        let code: string;
        try {
          code = await nextActivityCode({ claim_id: claimId, kind: effectiveKind });
        } catch (err) {
          // Code-exhaustion is the only documented throw. Surface as
          // a per-row reject so the rest of the batch can land.
          rejected.push({
            proposed_id: item.proposed_id,
            reason: `code_exhausted: ${(err as Error).message}`,
          });
          continue;
        }

        // Insert the activity row + emit ACTIVITY_CREATED with
        // proposed_id correlation. Wrapped per-row so a failure on
        // row N doesn't roll back rows 1..N-1.
        try {
          const inserted = await sql.begin(async (tx) => {
            await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
            const rows = await tx<{ id: string }[]>`
              INSERT INTO activity (
                id, tenant_id, project_id, claim_id, code, kind, title,
                description, hypothesis, technical_uncertainty
              )
              VALUES (
                ${crypto.randomUUID()}, ${tenantId}, ${projectId}, ${claimId},
                ${code}, ${effectiveKind}, ${effectiveName},
                ${proposed.rationale ?? null},
                ${proposed.proposed_hypothesis ?? null},
                ${proposed.proposed_uncertainty ?? null}
              )
              RETURNING id
            `;
            return rows[0]!;
          });

          const createdPayload = ActivityCreatedPayload.parse({
            activity_id: inserted.id,
            code,
            kind: effectiveKind,
            title: effectiveName,
            project_id: projectId,
            claim_id: claimId,
            proposed_id: item.proposed_id,
          });

          await insertEventWithChain({
            tenant_id: tenantId,
            subject_tenant_id: guard.subject_tenant_id,
            project_id: projectId,
            kind: 'ACTIVITY_CREATED',
            payload: createdPayload,
            classification: null,
            captured_at: new Date(),
            captured_by_user_id: userId,
            override_of_event_id: null,
            override_new_kind: null,
            override_reason: null,
          });

          accepted.push({
            proposed_id: item.proposed_id,
            activity_id: inserted.id,
            code,
            skipped_idempotent: false,
          });
          // Update the local idempotency cache so a duplicate
          // proposed_id earlier in the same batch + later in the same
          // batch resolves as skipped on the second occurrence.
          existingAcceptanceById.set(item.proposed_id, {
            activity_id: inserted.id,
            code,
          });
        } catch (err) {
          // Detect the partial unique-index violation from migration 0036:
          //   event_activity_created_proposed_id_unique on
          //   (tenant_id, payload->>'proposed_id') WHERE kind='ACTIVITY_CREATED'.
          // This fires when a concurrent accept request for the same
          // proposed_id raced past our pre-load. The pre-load already
          // handles sequential retries; the index handles the truly-
          // concurrent case. On 23505, look up the existing activity
          // and route to skipped_idempotent so the second client sees
          // the same outcome as the first.
          const isUniqueViolation =
            err !== null &&
            typeof err === 'object' &&
            'code' in err &&
            (err as { code?: string }).code === '23505';
          if (isUniqueViolation) {
            const winnerRows = await privilegedSql<{ activity_id: string; code: string }[]>`
              SELECT
                (payload ->> 'activity_id') AS activity_id,
                (payload ->> 'code') AS code
              FROM event
              WHERE tenant_id = ${tenantId}
                AND kind = 'ACTIVITY_CREATED'
                AND payload ->> 'proposed_id' = ${item.proposed_id}
              ORDER BY captured_at DESC
              LIMIT 1
            `;
            const winner = winnerRows[0];
            if (winner) {
              accepted.push({
                proposed_id: item.proposed_id,
                activity_id: winner.activity_id,
                code: winner.code,
                skipped_idempotent: true,
              });
              continue;
            }
            // Fall through to rejected if we can't find the winner —
            // shouldn't happen but defensive.
          }
          rejected.push({
            proposed_id: item.proposed_id,
            reason: `insert_failed: ${(err as Error).message}`,
          });
        }
      }
      return reply.status(200).send({ accepted, rejected });
    },
  );
}
