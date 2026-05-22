import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireSession } from '@cpa/auth';
import { sql } from '@cpa/db/client';
import { insertEventWithChain } from '@cpa/db';
import { isAgentEnabled, isTenantAllowed } from '@cpa/agents';
import { enqueueExpenditureClassify } from '../lib/enqueue-classify.js';
import {
  projectMapping,
  type MappingChainEvent,
  type CurrentMapping,
} from '../lib/expenditure-projection.js';

/**
 * Expenditure routes (Task 3.5 — manual reclassify endpoint).
 *
 * Today this file owns one route:
 *
 *   POST /v1/expenditures/:id/reclassify  — admin / consultant
 *
 * Other expenditure-related verbs already live elsewhere by P5
 * convention:
 *   - `POST /v1/expenditures/:id/apply-rules`  →  routes/apply-rules.ts
 *   - Xero-driven INSERTs                      →  jobs/xero-accounting-sync.ts
 *     (the manual-create POST anticipated by Task 3.4 does not yet exist
 *     in P5 — the only insert path is the Xero sync).
 *
 * **202 Accepted, not 200.** The handler does NOT block on the
 * classifier. It enqueues a job via `enqueueExpenditureClassify` (which
 * today runs the handler inline; tomorrow swaps to `pgBoss.send`) and
 * returns immediately with a `requestId` correlation handle. Match the
 * existing 202 convention from `POST /v1/employees/.../send-magic-link`
 * (employees.ts) — the only other accepted-but-not-yet-completed
 * mutation in the API today.
 *
 * **503 when feature flag disabled.** When `P6_AGENT_A_ENABLED=false`
 * (or the tenant is outside the allowlist), we surface a 503 rather
 * than silently 202'ing on a no-op. Callers should treat the agent as a
 * platform service that may be off; a 503 lets the consultant UI render
 * a "classifier temporarily unavailable" banner instead of pretending
 * the job is in flight.
 *
 * **Why not a /v1/expenditures resource POST too?** The Task 3.4 spec
 * names a "manual-create POST handler" but no such route exists in the
 * P5 codebase — expenditures only enter the system via the Xero sync.
 * If a manual-create endpoint lands later (e.g. for ad-hoc consultant
 * data entry), it should also call `enqueueExpenditureClassify` after
 * its `EXPENDITURE_INGESTED` insert; the shim is the single seam.
 */
export function registerExpenditures(app: FastifyInstance): void {
  app.post<{ Params: { id: string } }>(
    '/v1/expenditures/:id/reclassify',
    { preHandler: requireSession },
    async (req, reply) => {
      // ---------------------------------------------------------------
      // Step 1 — role gate. Admin / consultant only. Viewer 403s.
      // Matches the convention in apply-rules.ts and claims.ts.
      // ---------------------------------------------------------------
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

      // ---------------------------------------------------------------
      // Step 2 — feature-flag + allowlist gate. Prefer 503 over silent
      // no-op. We check the gates BEFORE the existence lookup so a
      // disabled-tenant consultant doesn't get a 404-vs-503 oracle that
      // could leak existence; the lookup runs only after this gate
      // passes. (RLS would also prevent cross-firm leak, but defense-
      // in-depth is cheap here.)
      // ---------------------------------------------------------------
      if (!isAgentEnabled('A') || !isTenantAllowed(tenantId)) {
        return reply.status(503).send({
          error: 'agent_disabled',
          message: 'The expenditure classifier (Agent A) is not available for this caller',
          requestId: req.id,
        });
      }

      // ---------------------------------------------------------------
      // Step 3 — existence + cross-firm guard. RLS scopes the SELECT to
      // the caller's tenant; a row in a different firm comes back as 0
      // rows here, producing a 404 (not 403). This matches apply-rules
      // and other expenditure-id'd routes.
      // ---------------------------------------------------------------
      const expenditureExists = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<{ id: string }[]>`
          SELECT id FROM expenditure
           WHERE id = ${id} AND tenant_id = ${tenantId}
        `;
        return rows[0] != null;
      });
      if (!expenditureExists) {
        return reply.status(404).send({
          error: 'expenditure_not_found',
          message: 'No expenditure with that id in this firm',
          requestId: req.id,
        });
      }

      // ---------------------------------------------------------------
      // Step 4 — enqueue and return 202. Fire-and-forget per the shim's
      // contract; tests can `await app.inject(...)` and then poll for
      // the EXPENDITURE_CLASSIFIED event since the inline-handler
      // implementation has finished writing the chain row by the time
      // the next tick runs (best-effort, but sufficient for our test
      // patterns — see expenditures.test.ts for the deterministic
      // path that awaits the shim explicitly).
      // ---------------------------------------------------------------
      void enqueueExpenditureClassify({
        tenant_id: tenantId,
        expenditure_ids: [id],
      }).catch(() => {
        // Errors are logged inside the shim. The 202 has already gone
        // back to the caller; nothing useful to do here besides
        // suppress the unhandled-rejection warning.
      });

      return reply.status(202).send({ requestId: req.id });
    },
  );

  // =====================================================================
  // A-endpoints: expenditure mapping / apportionment / unmap
  // =====================================================================

  // ── GET /v1/claims/:id/expenditures ──────────────────────────────────
  const listQuery = z.object({
    filter: z.enum(['all', 'unmapped', 'mapped']).default('all'),
  });

  interface ExpenditureRow {
    id: string;
    vendor_name: string;
    reference: string | null;
    expenditure_date: string;
    total_amount: string;
    currency: string;
    source: string;
    voided_at: string | Date | null;
  }

  interface MappingEventRow {
    expenditure_id: string;
    kind: MappingChainEvent['kind'];
    payload: Record<string, unknown>;
    // postgres-js returns timestamptz as a Date in most configs but the
    // workspace pool is set up to leave timestamps as ISO strings (see
    // packages/db/src/client.ts). Normalise on the way out with `new Date(…)`.
    captured_at: string | Date;
    id: string;
  }

  app.get<{ Params: { id: string } }>(
    '/v1/claims/:id/expenditures',
    { preHandler: requireSession },
    async (req, reply) => {
      const parsed = listQuery.safeParse(req.query);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'invalid_query',
          message: parsed.error.issues.map((i) => i.message).join('; '),
          requestId: req.id,
        });
      }
      const { filter } = parsed.data;
      const claimId = req.params.id;
      const tenantId = req.user!.tenantId!;

      const { expRows, eventRows } = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const exp = await tx<ExpenditureRow[]>`
          SELECT id::text, vendor_name, reference, expenditure_date::text,
                 total_amount::text, currency, source, voided_at
          FROM expenditure
          WHERE claim_id = ${claimId}
        `;
        if (exp.length === 0) return { expRows: exp, eventRows: [] as MappingEventRow[] };

        const expIds = exp.map((r) => r.id);
        const ev = await tx<MappingEventRow[]>`
          SELECT
            (payload->>'expenditure_id')::text AS expenditure_id,
            kind,
            payload,
            captured_at,
            id::text
          FROM event
          WHERE kind IN ('EXPENDITURE_MAPPED', 'EXPENDITURE_APPORTIONED', 'EXPENDITURE_UNMAPPED')
            AND (payload->>'expenditure_id') = ANY(${expIds})
        `;
        return { expRows: exp, eventRows: ev };
      });

      // Group events by expenditure_id, project each.
      const byExp = new Map<string, MappingChainEvent[]>();
      for (const ev of eventRows) {
        const list = byExp.get(ev.expenditure_id) ?? [];
        list.push({
          kind: ev.kind,
          payload: ev.payload,
          captured_at: new Date(ev.captured_at).toISOString(),
          id: ev.id,
        });
        byExp.set(ev.expenditure_id, list);
      }

      const expenditures = expRows.map((r) => {
        const current_mapping: CurrentMapping = projectMapping(byExp.get(r.id) ?? []);
        return {
          id: r.id,
          vendor_name: r.vendor_name,
          reference: r.reference,
          expenditure_date: r.expenditure_date,
          total_amount: r.total_amount,
          currency: r.currency,
          source: r.source,
          voided_at: r.voided_at != null ? new Date(r.voided_at).toISOString() : null,
          current_mapping,
        };
      });

      const filtered = expenditures.filter((e) => {
        if (filter === 'unmapped') return e.current_mapping === null;
        if (filter === 'mapped') return e.current_mapping !== null;
        return true;
      });

      return reply.send({ expenditures: filtered });
    },
  );

  // ── Shared: lookup expenditure (RLS-scoped) ──────────────────────────

  interface ExpLookup {
    id: string;
    claim_id: string | null;
    subject_tenant_id: string;
    voided_at: string | Date | null;
  }

  async function lookupExpenditure(tenantId: string, expId: string): Promise<ExpLookup | null> {
    const rows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
      return tx<ExpLookup[]>`
        SELECT id::text, claim_id::text, subject_tenant_id::text, voided_at
        FROM expenditure WHERE id = ${expId}
      `;
    });
    return rows[0] ?? null;
  }

  // ── POST /v1/expenditures/:id/map ────────────────────────────────────

  const mapBody = z.object({
    activity_id: z.string().uuid(),
  });

  app.post<{ Params: { id: string } }>(
    '/v1/expenditures/:id/map',
    { preHandler: requireSession },
    async (req, reply) => {
      const parsed = mapBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'invalid_body',
          message: parsed.error.issues.map((i) => i.message).join('; '),
        });
      }
      const tenantId = req.user!.tenantId!;
      const userId = req.user!.id;
      const expId = req.params.id;
      const { activity_id } = parsed.data;

      const exp = await lookupExpenditure(tenantId, expId);
      if (!exp) {
        return reply
          .status(404)
          .send({ error: 'expenditure_not_found', message: 'Expenditure not found' });
      }
      if (exp.voided_at) {
        return reply
          .status(409)
          .send({ error: 'expenditure_voided', message: 'Cannot map a voided expenditure' });
      }

      // Activity must belong to same claim.
      const actRows = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        return tx<{ id: string; code: string; title: string; claim_id: string }[]>`
          SELECT id::text, code, title, claim_id::text FROM activity WHERE id = ${activity_id}
        `;
      });
      if (actRows.length === 0 || actRows[0]!.claim_id !== exp.claim_id) {
        return reply.status(404).send({
          error: 'activity_not_in_claim',
          message: 'Activity does not belong to this claim',
        });
      }
      const act = actRows[0]!;

      // Idempotency: is the latest mapping event already this same activity?
      const latestRows = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        return tx<{ kind: string; payload: Record<string, unknown>; id: string }[]>`
          SELECT kind, payload, id::text
          FROM event
          WHERE kind IN ('EXPENDITURE_MAPPED','EXPENDITURE_APPORTIONED','EXPENDITURE_UNMAPPED')
            AND (payload->>'expenditure_id') = ${expId}
          ORDER BY captured_at DESC, id DESC
          LIMIT 1
        `;
      });
      const latest = latestRows[0];
      if (
        latest &&
        latest.kind === 'EXPENDITURE_MAPPED' &&
        latest.payload['activity_id'] === activity_id
      ) {
        return reply.send({ event: { id: latest.id, kind: latest.kind, payload: latest.payload } });
      }

      const payload = {
        expenditure_id: expId,
        activity_id,
        activity_code: act.code,
        activity_title: act.title,
      };
      const ev = await insertEventWithChain({
        tenant_id: tenantId,
        subject_tenant_id: exp.subject_tenant_id,
        kind: 'EXPENDITURE_MAPPED',
        payload,
        classification: null,
        captured_at: new Date(),
        captured_by_user_id: userId,
        captured_by_employee_id: null,
        override_of_event_id: null,
        override_new_kind: null,
        override_reason: null,
      });
      return reply.send({ event: { id: ev.id, kind: 'EXPENDITURE_MAPPED', payload } });
    },
  );

  // ── POST /v1/expenditures/:id/apportion ──────────────────────────────

  const apportionBody = z.object({
    allocations: z
      .array(
        z.object({
          activity_id: z.string().uuid(),
          percentage: z.number().positive(),
        }),
      )
      .min(1)
      .max(5)
      .refine(
        (a) => {
          const ids = a.map((x) => x.activity_id);
          return new Set(ids).size === ids.length;
        },
        { message: 'duplicate activity in allocation' },
      )
      .refine((a) => Math.abs(a.reduce((s, x) => s + x.percentage, 0) - 100) < 0.001, {
        message: 'allocations must sum to 100 (±0.001)',
      }),
  });

  app.post<{ Params: { id: string } }>(
    '/v1/expenditures/:id/apportion',
    { preHandler: requireSession },
    async (req, reply) => {
      const parsed = apportionBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'invalid_allocation',
          message: parsed.error.issues.map((i) => i.message).join('; '),
        });
      }
      const tenantId = req.user!.tenantId!;
      const userId = req.user!.id;
      const expId = req.params.id;
      const { allocations } = parsed.data;

      const exp = await lookupExpenditure(tenantId, expId);
      if (!exp) {
        return reply
          .status(404)
          .send({ error: 'expenditure_not_found', message: 'Expenditure not found' });
      }
      if (exp.voided_at) {
        return reply
          .status(409)
          .send({ error: 'expenditure_voided', message: 'Cannot apportion a voided expenditure' });
      }

      // All activities must belong to the same claim.
      const actIds = allocations.map((a) => a.activity_id);
      const actRows = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        return tx<{ id: string; code: string; title: string; claim_id: string }[]>`
          SELECT id::text, code, title, claim_id::text FROM activity WHERE id = ANY(${actIds})
        `;
      });
      if (actRows.length !== actIds.length || actRows.some((a) => a.claim_id !== exp.claim_id)) {
        return reply.status(404).send({
          error: 'activity_not_in_claim',
          message: 'One or more activities do not belong to this claim',
        });
      }
      const actById = new Map(actRows.map((a) => [a.id, a]));

      const payload = {
        expenditure_id: expId,
        allocations: allocations.map((a) => {
          const act = actById.get(a.activity_id)!;
          return {
            activity_id: a.activity_id,
            activity_code: act.code,
            activity_title: act.title,
            percentage: a.percentage,
          };
        }),
        mapped_by_user_id: userId,
      };
      const ev = await insertEventWithChain({
        tenant_id: tenantId,
        subject_tenant_id: exp.subject_tenant_id,
        kind: 'EXPENDITURE_APPORTIONED',
        payload,
        classification: null,
        captured_at: new Date(),
        captured_by_user_id: userId,
        captured_by_employee_id: null,
        override_of_event_id: null,
        override_new_kind: null,
        override_reason: null,
      });
      return reply.send({ event: { id: ev.id, kind: 'EXPENDITURE_APPORTIONED', payload } });
    },
  );

  // ── POST /v1/expenditures/:id/unmap ──────────────────────────────────

  const unmapBody = z.object({
    reason: z.string().optional(),
  });

  app.post<{ Params: { id: string } }>(
    '/v1/expenditures/:id/unmap',
    { preHandler: requireSession },
    async (req, reply) => {
      const parsed = unmapBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'invalid_body',
          message: parsed.error.issues.map((i) => i.message).join('; '),
        });
      }
      const tenantId = req.user!.tenantId!;
      const userId = req.user!.id;
      const expId = req.params.id;
      const { reason } = parsed.data;

      const exp = await lookupExpenditure(tenantId, expId);
      if (!exp) {
        return reply
          .status(404)
          .send({ error: 'expenditure_not_found', message: 'Expenditure not found' });
      }
      if (exp.voided_at) {
        return reply
          .status(409)
          .send({ error: 'expenditure_voided', message: 'Cannot unmap a voided expenditure' });
      }

      // Check current mapping — error if already null.
      const latestRows = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        return tx<{ kind: string; payload: Record<string, unknown> }[]>`
          SELECT kind, payload FROM event
          WHERE kind IN ('EXPENDITURE_MAPPED','EXPENDITURE_APPORTIONED','EXPENDITURE_UNMAPPED')
            AND (payload->>'expenditure_id') = ${expId}
          ORDER BY captured_at DESC, id DESC LIMIT 1
        `;
      });
      const latest = latestRows[0];
      if (!latest || latest.kind === 'EXPENDITURE_UNMAPPED') {
        return reply
          .status(400)
          .send({ error: 'nothing_to_unmap', message: 'Expenditure is not currently mapped' });
      }

      const priorActivityId =
        latest.kind === 'EXPENDITURE_MAPPED'
          ? (latest.payload['activity_id'] as string)
          : undefined;

      const payload: Record<string, unknown> = {
        expenditure_id: expId,
        unmapped_by_user_id: userId,
      };
      if (priorActivityId) payload['prior_activity_id'] = priorActivityId;
      if (reason) payload['reason'] = reason;

      const ev = await insertEventWithChain({
        tenant_id: tenantId,
        subject_tenant_id: exp.subject_tenant_id,
        kind: 'EXPENDITURE_UNMAPPED',
        payload,
        classification: null,
        captured_at: new Date(),
        captured_by_user_id: userId,
        captured_by_employee_id: null,
        override_of_event_id: null,
        override_new_kind: null,
        override_reason: null,
      });
      return reply.send({ event: { id: ev.id, kind: 'EXPENDITURE_UNMAPPED', payload } });
    },
  );
}
