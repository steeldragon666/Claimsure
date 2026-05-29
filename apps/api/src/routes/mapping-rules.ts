import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { requireSession } from '@cpa/auth';
import { insertAuditLog } from '@cpa/db';
import { sql } from '@cpa/db/client';
import {
  createMappingRuleBody,
  listMappingRulesQuery,
  updateMappingRuleBody,
  type MappingRuleApi,
} from '@cpa/schemas';
import {
  evaluateRule,
  type ExpenditureForRules,
  type MappingRule,
  type RuleAction,
  type RuleCondition,
} from '@cpa/integrations/xero-accounting';

/**
 * Mapping rule REST surface (T-B9).
 *
 * Five endpoints under `/v1/mapping-rules`:
 *
 *   POST   /v1/mapping-rules            — admin / consultant create
 *   GET    /v1/mapping-rules            — all roles, cursor-paginated
 *   GET    /v1/mapping-rules/:id        — all roles, 404 cross-firm
 *   PATCH  /v1/mapping-rules/:id        — admin / consultant update
 *   DELETE /v1/mapping-rules/:id        — admin only, soft-archive
 *
 * Auth + RLS:
 *   - All routes require a session (`requireSession`).
 *   - Mutations gate on role.
 *   - Every query runs inside `sql.begin` with `app.current_tenant_id`
 *     set, and every WHERE clause additionally filters
 *     `tenant_id = $tenantId` (defence in depth — RLS is the primary
 *     gate but the explicit predicate guards against a future config
 *     mistake that disables FORCE row-level security).
 *   - Cross-firm rule ids return 404 (info hiding), not 403.
 *
 * Validation pipeline at write time:
 *   1. Zod parses the body (createMappingRuleBody / updateMappingRuleBody).
 *      Failures surface as 400 with `parsed.error.issues.map(...).join('; ')`.
 *   2. The fully-formed rule is handed to B8's `evaluateRule(rule, dummy)`
 *      against a synthetic expenditure. B8's runtime validator runs even
 *      when no condition matches (it eagerly validates the action), so a
 *      rule with `apportion sum != 100` throws `InvalidRuleError` at the
 *      write boundary rather than silently waiting for B10's apply job.
 *
 * Soft-delete: DELETE flips `enabled = false` rather than removing the
 * row. The row stays visible to GET (with `enabled: false` in the
 * response) so audit trails survive.
 *
 * Audit emission (P5 Task 2.4): the three POST/PATCH/DELETE handlers
 * now emit MAPPING_RULE_CREATED / UPDATED / ARCHIVED rows to the
 * firm-scoped `audit_log` table (P5 Task 2.1) via `insertAuditLog`.
 * Each emission rides on the same `sql.begin` as the underlying
 * mutation so a downstream throw rolls both back atomically. The
 * three kinds are no longer in `EVIDENCE_KINDS` — Task 2.2 moved them
 * to `AUDIT_KINDS` and rebuilt `event_kind_valid` (0023) to exclude
 * them, making attempts to insert them into `event` fail with CHECK
 * violation. See `@cpa/db/audit-log.ts` for the writer contract.
 */

// ---------------------------------------------------------------------------
// Drift between Zod (in @cpa/schemas) and B8's runtime types is caught
// at runtime, not at typecheck. Reasons we don't assert structurally:
//
//   1. B8 uses `readonly` on arrays/tuples (engine never mutates inputs);
//      Zod's `z.array()` produces a mutable array. The two shapes are
//      runtime-compatible but TS-asymmetric.
//   2. B8 uses `case_insensitive?: boolean` (the field may be absent);
//      Zod's `.optional()` produces `case_insensitive?: boolean | undefined`,
//      which under `exactOptionalPropertyTypes: true` is a different type.
//
// The runtime safety net is `evaluateRule(rule, dummy)`: it eagerly
// validates the action and walks each condition, throwing
// `InvalidRuleError` on any mismatch. We call it on every POST/PATCH
// before INSERT, so a Zod-accepted-but-B8-rejected shape is a 400, not
// a silent corruption. If B8 adds a new field/op pair, the worst case
// is that the API accepts a body Zod parses but the engine rejects —
// surfaces as a 400 to the caller, never as silent data drift.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Row → API mapping.
// ---------------------------------------------------------------------------

interface RawMappingRuleRow {
  id: string;
  tenant_id: string;
  name: string;
  priority: number;
  enabled: boolean;
  conditions: unknown;
  action: unknown;
  created_at: Date | string;
  created_by_user_id: string;
  updated_at: Date | string;
}

const isoOf = (v: Date | string): string => (typeof v === 'string' ? v : v.toISOString());

const toApi = (r: RawMappingRuleRow): MappingRuleApi =>
  // jsonb columns come back as `unknown`; everything that landed in
  // them passed Zod + B8 validation at write time, so the cast is
  // sound. Wire-format consumers can re-validate via `mappingRuleApi`
  // if they want to be defensive.
  //
  // Cast through unknown for the conditions/action: the Zod-derived
  // MappingRuleApi types use mutable arrays while we want to allow
  // whatever shape parsed cleanly through Zod. The dual-cast also
  // bypasses the readonly/non-readonly mismatch with B8's types.
  ({
    id: r.id,
    tenant_id: r.tenant_id,
    name: r.name,
    priority: r.priority,
    enabled: r.enabled,
    conditions: r.conditions as MappingRuleApi['conditions'],
    action: r.action as MappingRuleApi['action'],
    created_at: isoOf(r.created_at),
    created_by_user_id: r.created_by_user_id,
    updated_at: isoOf(r.updated_at),
  });

/**
 * Synthetic expenditure used to trigger B8's runtime validator at the
 * write boundary. The values themselves don't matter — `evaluateRule`
 * validates the action eagerly (before checking any condition), so a
 * rule with apportion sum != 100 throws regardless of whether the rule
 * matches the dummy. We pin every field to a valid value so a *valid*
 * rule never throws on the dummy by accident.
 */
const VALIDATION_DUMMY: ExpenditureForRules = {
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'INVOICE',
  // B8 types contact_name / reference / description as `string | null`.
  // Using null (rather than '') aligns the dummy with the real wire
  // shape — and per B8's README, nullable fields never match string
  // ops, so a rule with `contact_name eq ''` won't accidentally
  // "match" the dummy and short-circuit validation. The dummy's
  // purpose is to trigger eager action validation; the conditions
  // arm of evaluateRule walks every condition regardless.
  contact_name: null,
  reference: null,
  account_code: '',
  amount: 1,
  currency: 'AUD',
  description: null,
  date: '2025-01-01',
};

/**
 * Run B8's runtime validator on a candidate rule. Returns the
 * InvalidRuleError message on failure (route emits 400), null on
 * success. We swallow non-InvalidRuleError throws because they
 * indicate a programming error in B8, which should surface as 500
 * via the route's error handler — not be reshaped as a 400.
 */
function validateRuleViaEngine(rule: MappingRule): string | null {
  try {
    evaluateRule(rule, VALIDATION_DUMMY);
    return null;
  } catch (err) {
    if (err instanceof Error && err.name === 'InvalidRuleError') {
      return err.message;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Cursor — opaque base64url JSON of (priority, id). Keeps the GET list
// stable across pages even if rules are inserted at higher priority
// values mid-pagination.
// ---------------------------------------------------------------------------

interface CursorTuple {
  priority: number;
  id: string;
}

function encodeCursor(t: CursorTuple): string {
  return Buffer.from(JSON.stringify(t), 'utf8').toString('base64url');
}

function decodeCursor(s: string): CursorTuple | null {
  try {
    const json = Buffer.from(s, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as Partial<CursorTuple>;
    if (typeof parsed.priority !== 'number' || typeof parsed.id !== 'string') {
      return null;
    }
    return { priority: parsed.priority, id: parsed.id };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Routes.
// ---------------------------------------------------------------------------

export function registerMappingRules(app: FastifyInstance): void {
  // -------------------------------------------------------------------
  // POST /v1/mapping-rules — admin / consultant
  // -------------------------------------------------------------------
  app.post('/v1/mapping-rules', { preHandler: requireSession }, async (req, reply) => {
    const role = req.user!.role;
    if (role !== 'admin' && role !== 'consultant') {
      return reply.status(403).send({
        error: 'forbidden',
        message: 'Admin or consultant role required',
        requestId: req.id,
      });
    }

    const parsed = createMappingRuleBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'invalid_body',
        message: parsed.error.issues.map((i) => i.message).join('; '),
        requestId: req.id,
      });
    }
    const body = parsed.data;
    const tenantId = req.user!.tenantId!;
    const userId = req.user!.id;
    const id = crypto.randomUUID();
    const enabled = body.enabled ?? true;

    // Run B8's runtime validator before INSERT. A rule with `apportion
    // sum = 87%` returns 400 here, NOT a runtime error in B10.
    const candidate: MappingRule = {
      id,
      tenant_id: tenantId,
      name: body.name,
      priority: body.priority,
      enabled,
      // Cast through unknown — the Zod-derived types and B8's are
      // structurally compatible at runtime (writable array satisfies
      // ReadonlyArray param; case_insensitive missing vs undefined are
      // observationally identical) but tsc rejects the direct cast
      // under exactOptionalPropertyTypes: true. See identity-assertion
      // comment above for the rationale.
      conditions: body.conditions as unknown as readonly RuleCondition[],
      action: body.action,
    };
    const validationError = validateRuleViaEngine(candidate);
    if (validationError !== null) {
      return reply.status(400).send({
        error: 'invalid_rule',
        message: validationError,
        requestId: req.id,
      });
    }

    const inserted = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
      // P5 Task 2.4: also set app.current_firm_id inside this tx so the
      // audit_log RLS WITH CHECK passes when insertAuditLog runs below.
      // In this codebase firm_id IS the consultant tenant id.
      await tx`SELECT set_config('app.current_firm_id', ${tenantId}, true)`;
      // jsonb columns: bind a JSON-text string with the SQL-side cast
      // `::text::jsonb`. The double cast pins the parameter's wire type
      // to TEXT (postgres oid 25), which sidesteps a postgres-js v3.4.9
      // pitfall: `client.ts` calls `drizzle(sql)`, and drizzle's
      // postgres-js driver MUTATES `sql.options.serializers[3802]`
      // (jsonb) to an identity passthrough so its ORM-side query
      // builder can manage serialization itself. Raw `${value}`
      // (Object/Array) then trips `Buffer.byteLength` at Bind time
      // (CI runs 25165786894 / 25167769866; same root cause as the
      // Date workaround in chain.ts ~line 117). The single-cast form
      // `${JSON.stringify(value)}::jsonb` works under drizzle (identity
      // passes the JSON-string unmodified, server parses text→jsonb)
      // but DOUBLE-ENCODES under privilegedSql (default JSON.stringify
      // serializer JSON.stringify's the already-JSON string, producing
      // a jsonb scalar STRING — see audit_log_payload_object CHECK
      // failure in CI 25160635668). The double-cast `::text::jsonb`
      // works in both: server infers parameter type as TEXT (25),
      // postgres-js's text serializer is consistent across both
      // contexts (default `'' + x` and drizzle identity both no-op on
      // strings), and Postgres casts text→jsonb after the wire round-
      // trip. See audit-log.ts for the same idiom.
      const rows = await tx<RawMappingRuleRow[]>`
        INSERT INTO mapping_rule (
          tenant_id, id, name, priority, enabled,
          conditions, action, created_by_user_id
        )
        VALUES (
          ${tenantId}, ${id}, ${body.name}, ${body.priority}, ${enabled},
          ${JSON.stringify(body.conditions)}::text::jsonb,
          ${JSON.stringify(body.action)}::text::jsonb,
          ${userId}
        )
        RETURNING id, tenant_id, name, priority, enabled,
                  conditions, action, created_at, created_by_user_id, updated_at
      `;
      const row = rows[0];
      if (!row) {
        throw new Error('POST /v1/mapping-rules: INSERT returned no row');
      }
      // P5 Task 2.4: emit MAPPING_RULE_CREATED to audit_log. Same tx as
      // the INSERT above so a downstream failure rolls both back; the
      // helper riding on `tx` is the contract documented in
      // @cpa/db/audit-log.ts.
      await insertAuditLog({
        tx,
        firmId: tenantId,
        kind: 'MAPPING_RULE_CREATED',
        payload: {
          mapping_rule_id: row.id,
          name: row.name,
          priority: row.priority,
          conditions: row.conditions,
          action: row.action,
        },
        actorUserId: userId,
      });
      return row;
    });

    return reply.status(201).send({ mapping_rule: toApi(inserted) });
  });

  // -------------------------------------------------------------------
  // GET /v1/mapping-rules — all roles, cursor pagination
  // -------------------------------------------------------------------
  app.get('/v1/mapping-rules', { preHandler: requireSession }, async (req, reply) => {
    const parsed = listMappingRulesQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'invalid_query',
        message: parsed.error.issues.map((i) => i.message).join('; '),
        requestId: req.id,
      });
    }
    const { enabled, cursor, limit } = parsed.data;
    const tenantId = req.user!.tenantId!;

    const decoded = cursor ? decodeCursor(cursor) : null;
    if (cursor && !decoded) {
      return reply.status(400).send({
        error: 'invalid_cursor',
        message: 'cursor is malformed',
        requestId: req.id,
      });
    }

    return await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;

      // Over-fetch by 1 to know whether a next page exists.
      const fetchN = limit + 1;

      // Cursor predicate: lexicographic (priority ASC, id ASC).
      const cursorClause = decoded
        ? tx`AND (priority > ${decoded.priority}
                  OR (priority = ${decoded.priority} AND id > ${decoded.id}::uuid))`
        : tx``;

      // Defence-in-depth: explicit tenant_id filter alongside the RLS
      // policy. Same pattern as employees.ts / time-entries.ts.
      const enabledClause = enabled === undefined ? tx`` : tx`AND enabled = ${enabled}`;

      const rows = await tx<RawMappingRuleRow[]>`
        SELECT id, tenant_id, name, priority, enabled,
               conditions, action, created_at, created_by_user_id, updated_at
          FROM mapping_rule
         WHERE tenant_id = ${tenantId}
           ${cursorClause}
           ${enabledClause}
         ORDER BY priority ASC, id ASC
         LIMIT ${fetchN}
      `;

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      const nextCursor =
        hasMore && last ? encodeCursor({ priority: last.priority, id: last.id }) : null;

      return { mapping_rules: page.map(toApi), next_cursor: nextCursor };
    });
  });

  // -------------------------------------------------------------------
  // GET /v1/mapping-rules/:id — all roles
  // -------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/v1/mapping-rules/:id',
    { preHandler: requireSession },
    async (req, reply) => {
      const { id } = req.params;
      const tenantId = req.user!.tenantId!;
      return await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<RawMappingRuleRow[]>`
          SELECT id, tenant_id, name, priority, enabled,
                 conditions, action, created_at, created_by_user_id, updated_at
            FROM mapping_rule
           WHERE id = ${id} AND tenant_id = ${tenantId}
        `;
        const row = rows[0];
        if (!row) {
          return reply.status(404).send({
            error: 'mapping_rule_not_found',
            message: 'No mapping rule with that id in this firm',
            requestId: req.id,
          });
        }
        return { mapping_rule: toApi(row) };
      });
    },
  );

  // -------------------------------------------------------------------
  // PATCH /v1/mapping-rules/:id — admin / consultant
  // -------------------------------------------------------------------
  app.patch<{ Params: { id: string } }>(
    '/v1/mapping-rules/:id',
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
      const parsed = updateMappingRuleBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'invalid_body',
          message: parsed.error.issues.map((i) => i.message).join('; '),
          requestId: req.id,
        });
      }
      const patch = parsed.data;
      if (Object.keys(patch).length === 0) {
        return reply.status(400).send({
          error: 'empty_patch',
          message: 'At least one field must be provided',
          requestId: req.id,
        });
      }

      const tenantId = req.user!.tenantId!;

      return await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        // P5 Task 2.4: also set app.current_firm_id inside this tx so
        // the audit_log RLS WITH CHECK passes when insertAuditLog runs
        // below. firm_id IS the consultant tenant id in this codebase.
        await tx`SELECT set_config('app.current_firm_id', ${tenantId}, true)`;

        // Step 1: load the existing row under RLS. 404 covers missing
        // + cross-firm.
        const existingRows = await tx<RawMappingRuleRow[]>`
          SELECT id, tenant_id, name, priority, enabled,
                 conditions, action, created_at, created_by_user_id, updated_at
            FROM mapping_rule
           WHERE id = ${id} AND tenant_id = ${tenantId}
        `;
        const existing = existingRows[0];
        if (!existing) {
          return reply.status(404).send({
            error: 'mapping_rule_not_found',
            message: 'No mapping rule with that id in this firm',
            requestId: req.id,
          });
        }

        // Step 2: merge patch onto existing, then validate via B8.
        // Casts through unknown for the same exactOptionalPropertyTypes
        // reason as the POST path above.
        const mergedConditions =
          patch.conditions !== undefined
            ? (patch.conditions as unknown as readonly RuleCondition[])
            : (existing.conditions as readonly RuleCondition[]);
        const mergedAction =
          patch.action !== undefined
            ? (patch.action as unknown as RuleAction)
            : (existing.action as RuleAction);
        const merged: MappingRule = {
          id: existing.id,
          tenant_id: existing.tenant_id,
          name: patch.name ?? existing.name,
          priority: patch.priority ?? existing.priority,
          enabled: patch.enabled ?? existing.enabled,
          conditions: mergedConditions,
          action: mergedAction,
        };
        const validationError = validateRuleViaEngine(merged);
        if (validationError !== null) {
          return reply.status(400).send({
            error: 'invalid_rule',
            message: validationError,
            requestId: req.id,
          });
        }

        // Step 3: perform the UPDATE. COALESCE-on-undefined-bind keeps
        // the statement single-shot regardless of which subset of
        // fields the patch carried (mirrors brand-config PATCH).
        //
        // jsonb columns: same `${JSON.stringify(value)}::text::jsonb`
        // double-cast pattern as the POST above (see commentary there).
        // For absent fields we pass `null` and let the surrounding CASE
        // pick the ELSE branch (existing column value).
        const conditionsPresent = patch.conditions !== undefined;
        const conditionsJson = conditionsPresent ? JSON.stringify(patch.conditions) : null;
        const actionPresent = patch.action !== undefined;
        const actionJson = actionPresent ? JSON.stringify(patch.action) : null;

        const updatedRows = await tx<RawMappingRuleRow[]>`
          UPDATE mapping_rule
             SET name = COALESCE(${patch.name ?? null}, name),
                 priority = COALESCE(${patch.priority ?? null}, priority),
                 enabled = COALESCE(${patch.enabled ?? null}, enabled),
                 conditions = CASE WHEN ${conditionsPresent} THEN ${conditionsJson}::text::jsonb ELSE conditions END,
                 action = CASE WHEN ${actionPresent} THEN ${actionJson}::text::jsonb ELSE action END,
                 updated_at = NOW()
           WHERE id = ${id} AND tenant_id = ${tenantId}
          RETURNING id, tenant_id, name, priority, enabled,
                    conditions, action, created_at, created_by_user_id, updated_at
        `;
        const row = updatedRows[0];
        if (!row) {
          // Should be unreachable — we just verified the row exists
          // under RLS — but belt-and-braces in case of a concurrent delete.
          return reply.status(404).send({
            error: 'mapping_rule_not_found',
            message: 'No mapping rule with that id in this firm',
            requestId: req.id,
          });
        }
        // P5 Task 2.4: emit MAPPING_RULE_UPDATED to audit_log. Same tx
        // as the UPDATE so a downstream failure rolls both back.
        // `fields_changed` carries only the fields the patch touched
        // (mirrors ACTIVITY_UPDATED) — readers render field-level
        // diffs without re-fetching prior state.
        const fieldsChanged: Record<string, { from: unknown; to: unknown }> = {};
        if (patch.name !== undefined && patch.name !== existing.name) {
          fieldsChanged['name'] = { from: existing.name, to: row.name };
        }
        if (patch.priority !== undefined && patch.priority !== existing.priority) {
          fieldsChanged['priority'] = { from: existing.priority, to: row.priority };
        }
        if (patch.enabled !== undefined && patch.enabled !== existing.enabled) {
          fieldsChanged['enabled'] = { from: existing.enabled, to: row.enabled };
        }
        if (patch.conditions !== undefined) {
          fieldsChanged['conditions'] = { from: existing.conditions, to: row.conditions };
        }
        if (patch.action !== undefined) {
          fieldsChanged['action'] = { from: existing.action, to: row.action };
        }
        // Only emit if something actually changed (the empty-patch
        // 400 above already rejects no-op PATCHes, but a patch that
        // only sets fields to their current values would be a no-op
        // diff — silent no-op rather than a misleading audit row).
        if (Object.keys(fieldsChanged).length > 0) {
          await insertAuditLog({
            tx,
            firmId: tenantId,
            kind: 'MAPPING_RULE_UPDATED',
            payload: {
              mapping_rule_id: row.id,
              fields_changed: fieldsChanged,
            },
            actorUserId: req.user!.id,
          });
        }
        return { mapping_rule: toApi(row) };
      });
    },
  );

  // -------------------------------------------------------------------
  // DELETE /v1/mapping-rules/:id — admin only, soft-archive
  // -------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>(
    '/v1/mapping-rules/:id',
    { preHandler: requireSession },
    async (req, reply) => {
      const role = req.user!.role;
      if (role !== 'admin') {
        return reply.status(403).send({
          error: 'forbidden',
          message: 'Admin role required',
          requestId: req.id,
        });
      }
      const { id } = req.params;
      const tenantId = req.user!.tenantId!;

      // Capture the outcome inside the tx but DON'T send the reply from
      // within sql.begin — doing so flushes the HTTP response before the
      // COMMIT lands, so a caller that immediately re-reads the row (or the
      // audit_log) races the commit and sees the pre-archive state. Send the
      // reply only after the transaction resolves.
      const archivedOk = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        // P5 Task 2.4: also set app.current_firm_id inside this tx so
        // the audit_log RLS WITH CHECK passes when insertAuditLog runs
        // below. firm_id IS the consultant tenant id in this codebase.
        await tx`SELECT set_config('app.current_firm_id', ${tenantId}, true)`;
        // Soft-archive: flip `enabled = false`. The row stays
        // queryable for audit; mirrors the project.ts archive pattern.
        const rows = await tx<{ id: string }[]>`
          UPDATE mapping_rule
             SET enabled = false,
                 updated_at = NOW()
           WHERE id = ${id} AND tenant_id = ${tenantId}
          RETURNING id
        `;
        const archived = rows[0];
        if (!archived) {
          return false;
        }
        // P5 Task 2.4: emit MAPPING_RULE_ARCHIVED to audit_log. Same
        // tx as the UPDATE so a downstream failure rolls both back.
        // No `reason` field on the wire (DELETE body is empty); admins
        // who need to record rationale can add it later via a follow-
        // up audit kind. The archive itself is the auditable event.
        await insertAuditLog({
          tx,
          firmId: tenantId,
          kind: 'MAPPING_RULE_ARCHIVED',
          payload: {
            mapping_rule_id: archived.id,
            archived_by_user_id: req.user!.id,
          },
          actorUserId: req.user!.id,
        });
        return true;
      });
      if (!archivedOk) {
        return reply.status(404).send({
          error: 'mapping_rule_not_found',
          message: 'No mapping rule with that id in this firm',
          requestId: req.id,
        });
      }
      return reply.status(204).send();
    },
  );
}
