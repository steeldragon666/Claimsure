import type { FastifyInstance } from 'fastify';
import { requireSession } from '@cpa/auth';
import { sql } from '@cpa/db/client';
import { insertEventWithChain } from '@cpa/db';
import {
  applyRules,
  type ExpenditureForRules,
  type ExpenditureKind,
  type MappingRule,
  type RuleAction,
  type RuleCondition,
  type RuleMatch,
} from '@cpa/integrations/xero-accounting';

/**
 * Apply-rules writer endpoints (P5 Theme 5 Task 5.4).
 *
 * Two endpoints under `/v1/...apply-rules`:
 *
 *   POST /v1/expenditures/:id/apply-rules — single-row writer
 *   POST /v1/claims/:id/apply-rules       — batch writer (capped)
 *
 * **Relationship to preview-rules**: `apply-rules` is the writer
 * counterpart to `preview-rules` (T-B10 / preview-rules.ts). Same
 * load + engine call; the difference is that matches are *committed*
 * to the chain as `EXPENDITURE_MAPPED` / `EXPENDITURE_APPORTIONED`
 * events instead of returned as a JSON preview. The two surfaces are
 * deliberately separate (vs. one endpoint with a `commit: true` flag)
 * so the audit trail's source-of-action is unambiguous: if
 * `apply-rules` wrote it, the chain row is the authoritative record;
 * if `preview-rules` saw it, no chain row exists.
 *
 * **Action ↔ event mapping**:
 *   - `map_to_activity` → emits `EXPENDITURE_MAPPED`
 *   - `apportion`       → emits `EXPENDITURE_APPORTIONED`
 *   - `flag_for_review` → no chain write; surfaced under `skipped[]`
 *     with a human-readable reason. The flag is a UI signal for the
 *     consultant review queue, not a chain event.
 *
 * **Auth + RLS**:
 *   - Both routes require a session (`requireSession`).
 *   - Roles: admin / consultant only. Viewers do NOT get this surface
 *     because writing to the chain is a consultant-grade action (it
 *     mutates the audit history, not just a UI state).
 *   - Every query runs inside `sql.begin` with `app.current_tenant_id`
 *     AND `app.current_firm_id` set (the latter is unused by these
 *     routes' tables today, but the chain helper /
 *     `insertEventWithChain` keeps its own GUC scope inside its own
 *     `sql.begin`; we set it here for symmetry with mapping-rules.ts
 *     and so any future audit-log emission from this handler "just
 *     works"). Every WHERE clause additionally filters
 *     `tenant_id = $tenantId` (defence in depth — same pattern as
 *     mapping-rules.ts and preview-rules.ts).
 *   - Cross-firm expenditure / claim ids return 404 (info hiding).
 *
 * **Engine error surfacing**: if `applyRules` throws
 * `InvalidRuleError`, we let it bubble. The global error handler
 * emits 500 with `error: e.name`; this matches preview-rules.ts and
 * keeps the failure mode consistent across the two endpoints.
 *
 * **No idempotency key**: each call to `apply-rules` is treated as a
 * fresh action — re-running the endpoint emits NEW events on the
 * chain. Idempotency is the caller's responsibility (the consultant
 * UI either holds a "rules already applied" flag or asks before
 * re-running). The append-only chain is the audit primary; replaying
 * apply-rules is logically a series of "I asked the engine again";
 * each call is its own audit footprint.
 *
 * **Why `insertEventWithChain` per match (vs. a single batched
 * insert)**: the chain helper takes a per-call hash chain lock and
 * stamps `prev_hash` / `hash` deterministically on each row. Batching
 * inside the SAME `sql.begin → tx` would interleave with the helper's
 * own `sql.begin` and require a deeper refactor of the chain
 * primitive. Per-match is N round-trips; B10 / preview-rules already
 * pays this cost on its DB reads, and apply-rules typically writes
 * 1–5 events per call (one rule per expenditure on average). If batch
 * volumes ever push this past hundreds of writes per call, a chain-
 * helper-level "insertManyWithChain" would be the right answer (see
 * P6 cleanup item — same comment on chain.ts).
 *
 * **DO NOT modify chain.ts here**: the existing single-cast jsonb
 * binding pattern in `insertEventWithChain` works under `sql.begin →
 * tx`, which is what this handler uses. The double-cast pattern
 * (`::text::jsonb`) for our own `INSERT` would be required if we
 * wrote to jsonb columns directly — but every write here goes
 * through the chain helper.
 */

// ---------------------------------------------------------------------------
// Constants.
// ---------------------------------------------------------------------------

/**
 * Maximum number of expenditures the batch endpoint will process per
 * request. Mirrors preview-rules.ts so the two surfaces have parity.
 * Above this, the response carries `truncated: true` and the
 * `expenditures` array is the first 500 (ordered by
 * `expenditure_date` DESC, id ASC for tie-break stability — same
 * order preview uses).
 */
const BATCH_CAP = 500;

// ---------------------------------------------------------------------------
// Named errors.
// ---------------------------------------------------------------------------

/**
 * Same as preview-rules.ts: thrown by `mapSourceToKind` if a row
 * carries a `source` value that isn't in the closed enum. The DB
 * CHECK (`expenditure_source_valid`) makes this unreachable in
 * production; the named error matches the codebase's convention so a
 * real schema-vs-route drift surfaces with a distinctive identifier.
 */
class UnknownExpenditureSourceError extends Error {
  override readonly name = 'UnknownExpenditureSourceError';
}

// ---------------------------------------------------------------------------
// Row → ExpenditureForRules mapping (mirrors preview-rules.ts).
// ---------------------------------------------------------------------------

type ExpenditureSource = 'xero_invoice' | 'xero_bank_tx' | 'xero_receipt' | 'manual';

function mapSourceToKind(source: ExpenditureSource): ExpenditureKind {
  switch (source) {
    case 'xero_invoice':
      return 'INVOICE';
    case 'xero_bank_tx':
      return 'BANK_TX';
    case 'xero_receipt':
      return 'RECEIPT';
    case 'manual':
      return 'RECEIPT';
    default: {
      const _exhaustive: never = source;
      throw new UnknownExpenditureSourceError(
        `apply-rules: unknown expenditure source '${String(_exhaustive)}'`,
      );
    }
  }
}

/**
 * Row shape for the SELECT we issue. Same fields as preview-rules.ts
 * PLUS `claim_id` (P5 Task 1.x denormalised this onto `expenditure`)
 * and `subject_tenant_id` (the chain helper needs it). The two extra
 * fields are required to populate `EXPENDITURE_MAPPED` /
 * `EXPENDITURE_APPORTIONED` payloads (claim_id) and route the row to
 * the correct subject_tenant chain.
 *
 * `account_code` and `description` come from the FIRST line, same
 * "ORDER BY line_number ASC, id ASC" rule as preview-rules.ts (see
 * its row-shape comment for the correctness ceiling).
 */
interface ExpenditureRow {
  id: string;
  subject_tenant_id: string;
  claim_id: string | null;
  source: ExpenditureSource;
  vendor_name: string;
  reference: string | null;
  expenditure_date: Date | string;
  total_amount: string;
  currency: string;
  account_code: string | null;
  description: string | null;
}

function dateToIsoDate(d: Date | string): string {
  if (typeof d === 'string') {
    return d.length >= 10 ? d.slice(0, 10) : d;
  }
  return d.toISOString().slice(0, 10);
}

function rowToExpenditureForRules(row: ExpenditureRow): ExpenditureForRules {
  return {
    id: row.id,
    kind: mapSourceToKind(row.source),
    contact_name: row.vendor_name,
    reference: row.reference,
    account_code: row.account_code,
    amount: parseFloat(row.total_amount),
    currency: row.currency,
    description: row.description,
    date: dateToIsoDate(row.expenditure_date),
  };
}

// ---------------------------------------------------------------------------
// Mapping rule loader (shared between single + batch).
// ---------------------------------------------------------------------------

interface RawMappingRuleRow {
  id: string;
  tenant_id: string;
  name: string;
  priority: number;
  enabled: boolean;
  conditions: unknown;
  action: unknown;
}

function rowToMappingRule(r: RawMappingRuleRow): MappingRule {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    name: r.name,
    priority: r.priority,
    enabled: r.enabled,
    conditions: r.conditions as readonly RuleCondition[],
    action: r.action as RuleAction,
  };
}

// ---------------------------------------------------------------------------
// Match → event emission. Returns either the inserted event id (for
// chain-writing actions) or a `{ skipped: { rule_id, reason } }`
// marker (for `flag_for_review`, which doesn't write).
// ---------------------------------------------------------------------------

type EmittedEvent = { kind: 'EXPENDITURE_MAPPED' | 'EXPENDITURE_APPORTIONED'; event_id: string };
type SkippedRule = { rule_id: string; reason: string };

/**
 * Emit one event per `RuleMatch` whose action is `map_to_activity`
 * or `apportion`. `flag_for_review` matches are returned in the
 * `skipped` array — the consumer's review queue handles them.
 *
 * Pure projection: NO I/O inside the loop body except the
 * `insertEventWithChain` call. The helper opens its own
 * `sql.begin` for the chain lock + INSERT; calling it inside the
 * route's outer `sql.begin` is fine because postgres-js shares the
 * same connection inside a transaction (the inner `sql.begin` runs as
 * a SAVEPOINT under the hood).
 *
 * **Mapping rationale**:
 *   - `map_to_activity`: 100% of the expenditure goes to one
 *     activity → one EXPENDITURE_MAPPED event. The payload's
 *     `activity_id` is the rule's target.
 *   - `apportion`: split across N activities (percentages sum to
 *     100, validated by B8) → one EXPENDITURE_APPORTIONED event.
 *     The payload carries the full allocations array; downstream
 *     readers don't need to re-fetch the rule.
 *   - `flag_for_review`: no chain write. The reason string is
 *     surfaced verbatim in `skipped[].reason`.
 */
async function emitForMatch(opts: {
  match: RuleMatch;
  expenditure: { id: string; subject_tenant_id: string; claim_id: string };
  tenantId: string;
  userId: string;
}): Promise<{ emitted?: EmittedEvent; skipped?: SkippedRule }> {
  const { match, expenditure, tenantId, userId } = opts;
  const action = match.action;
  switch (action.type) {
    case 'map_to_activity': {
      const inserted = await insertEventWithChain({
        tenant_id: tenantId,
        subject_tenant_id: expenditure.subject_tenant_id,
        kind: 'EXPENDITURE_MAPPED',
        payload: {
          _v: 1,
          expenditure_id: expenditure.id,
          claim_id: expenditure.claim_id,
          activity_id: action.activity_id,
          mapped_by_user_id: userId,
          rule_id: match.rule_id,
        },
        classification: null,
        captured_at: new Date(),
        captured_by_user_id: userId,
        override_of_event_id: null,
        override_new_kind: null,
        override_reason: null,
      });
      return { emitted: { kind: 'EXPENDITURE_MAPPED', event_id: inserted.id } };
    }
    case 'apportion': {
      const inserted = await insertEventWithChain({
        tenant_id: tenantId,
        subject_tenant_id: expenditure.subject_tenant_id,
        kind: 'EXPENDITURE_APPORTIONED',
        payload: {
          _v: 1,
          expenditure_id: expenditure.id,
          claim_id: expenditure.claim_id,
          allocations: action.allocations.map((a) => ({
            activity_id: a.activity_id,
            percentage: a.percentage,
          })),
          apportioned_by_user_id: userId,
          rule_id: match.rule_id,
        },
        classification: null,
        captured_at: new Date(),
        captured_by_user_id: userId,
        override_of_event_id: null,
        override_new_kind: null,
        override_reason: null,
      });
      return { emitted: { kind: 'EXPENDITURE_APPORTIONED', event_id: inserted.id } };
    }
    case 'flag_for_review': {
      return { skipped: { rule_id: match.rule_id, reason: action.reason } };
    }
    default: {
      const _exhaustive: never = action;
      throw new Error(`apply-rules: unhandled action type '${String(_exhaustive)}'`);
    }
  }
}

// ---------------------------------------------------------------------------
// Routes.
// ---------------------------------------------------------------------------

export function registerApplyRules(app: FastifyInstance): void {
  // -------------------------------------------------------------------
  // POST /v1/expenditures/:id/apply-rules — admin / consultant
  // -------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/v1/expenditures/:id/apply-rules',
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

      // Step 1 + 2: load the expenditure + first line + rules under
      // RLS. We do this inside a sql.begin so the GUC is set; the
      // chain inserts that follow are individual `insertEventWithChain`
      // calls (each opens its own sql.begin internally — see the
      // module doc-block for why per-match writes vs. a single batch).
      const loaded = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        await tx`SELECT set_config('app.current_firm_id', ${tenantId}, true)`;

        const expenditureRows = await tx<ExpenditureRow[]>`
          SELECT
            e.id,
            e.subject_tenant_id,
            e.claim_id,
            e.source,
            e.vendor_name,
            e.reference,
            e.expenditure_date,
            e.total_amount::text AS total_amount,
            e.currency,
            l.account_code,
            l.description
          FROM expenditure e
          LEFT JOIN LATERAL (
            SELECT account_code, description
              FROM expenditure_line
             WHERE expenditure_id = e.id
             ORDER BY line_number ASC, id ASC
             LIMIT 1
          ) l ON TRUE
          WHERE e.id = ${id} AND e.tenant_id = ${tenantId}
        `;
        const row = expenditureRows[0];
        if (!row) return { row: null, rules: [] as MappingRule[] };

        const ruleRows = await tx<RawMappingRuleRow[]>`
          SELECT id, tenant_id, name, priority, enabled, conditions, action
            FROM mapping_rule
           WHERE tenant_id = ${tenantId} AND enabled = true
           ORDER BY priority ASC, id ASC
        `;
        return { row, rules: ruleRows.map(rowToMappingRule) };
      });

      if (!loaded.row) {
        return reply.status(404).send({
          error: 'expenditure_not_found',
          message: 'No expenditure with that id in this firm',
          requestId: req.id,
        });
      }

      // Expenditures without a claim_id can't carry meaningful
      // EXPENDITURE_MAPPED / EXPENDITURE_APPORTIONED payloads (the
      // events are claim-scoped facts), and the apply-rules contract
      // reads "events written" — surfacing a 422 is honest about the
      // gap. The DB column is nullable today (legacy rows pre-P5
      // Task 1.x); going forward, sync writers should populate
      // claim_id at ingest time.
      if (!loaded.row.claim_id) {
        return reply.status(422).send({
          error: 'expenditure_missing_claim',
          message: 'Expenditure has no claim_id; cannot apply rules without a claim context',
          requestId: req.id,
        });
      }

      // Step 3: build engine input + run engine. Throwing
      // InvalidRuleError surfaces as 500 via the global error handler
      // — same contract as preview-rules.ts.
      const expenditure = rowToExpenditureForRules(loaded.row);
      const matches: RuleMatch[] = applyRules(loaded.rules, expenditure);

      // Step 4: emit one event per chain-writing match. Sequential
      // so each event extends the chain head deterministically (the
      // helper takes a per-subject_tenant advisory lock so concurrent
      // emissions against the same chain serialise — but within a
      // single request, sequential is the contract).
      const emitted: EmittedEvent[] = [];
      const skipped: SkippedRule[] = [];
      const claimId = loaded.row.claim_id;
      for (const match of matches) {
        const result = await emitForMatch({
          match,
          expenditure: {
            id: loaded.row.id,
            subject_tenant_id: loaded.row.subject_tenant_id,
            claim_id: claimId,
          },
          tenantId,
          userId,
        });
        if (result.emitted) emitted.push(result.emitted);
        if (result.skipped) skipped.push(result.skipped);
      }

      return { matched: matches.length, emitted, skipped };
    },
  );

  // -------------------------------------------------------------------
  // POST /v1/claims/:id/apply-rules — admin / consultant (batch)
  // -------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/v1/claims/:id/apply-rules',
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

      // Same load shape as preview-rules.ts batch path: confirm the
      // claim, resolve the FY window, count + cap, load rules.
      const loaded = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        await tx`SELECT set_config('app.current_firm_id', ${tenantId}, true)`;

        const claimRows = await tx<
          { id: string; subject_tenant_id: string; fiscal_year: number }[]
        >`
          SELECT id, subject_tenant_id, fiscal_year
            FROM claim
           WHERE id = ${id} AND tenant_id = ${tenantId}
        `;
        const claim = claimRows[0];
        if (!claim)
          return {
            claim: null,
            rows: [] as ExpenditureRow[],
            rules: [] as MappingRule[],
            truncated: false,
          };

        const fyStart = `${claim.fiscal_year - 1}-07-01`;
        const fyEnd = `${claim.fiscal_year}-06-30`;

        const countRows = await tx<{ total: string }[]>`
          SELECT COUNT(*)::text AS total
            FROM expenditure
           WHERE tenant_id = ${tenantId}
             AND subject_tenant_id = ${claim.subject_tenant_id}
             AND voided_at IS NULL
             AND expenditure_date >= ${fyStart}::date
             AND expenditure_date <= ${fyEnd}::date
        `;
        const totalCount = parseInt(countRows[0]?.total ?? '0', 10);
        const truncated = totalCount > BATCH_CAP;

        const expenditureRows = await tx<ExpenditureRow[]>`
          SELECT
            e.id,
            e.subject_tenant_id,
            e.claim_id,
            e.source,
            e.vendor_name,
            e.reference,
            e.expenditure_date,
            e.total_amount::text AS total_amount,
            e.currency,
            l.account_code,
            l.description
          FROM expenditure e
          LEFT JOIN LATERAL (
            SELECT account_code, description
              FROM expenditure_line
             WHERE expenditure_id = e.id
             ORDER BY line_number ASC, id ASC
             LIMIT 1
          ) l ON TRUE
          WHERE e.tenant_id = ${tenantId}
            AND e.subject_tenant_id = ${claim.subject_tenant_id}
            AND e.voided_at IS NULL
            AND e.expenditure_date >= ${fyStart}::date
            AND e.expenditure_date <= ${fyEnd}::date
          ORDER BY e.expenditure_date DESC, e.id ASC
          LIMIT ${BATCH_CAP}
        `;

        const ruleRows = await tx<RawMappingRuleRow[]>`
          SELECT id, tenant_id, name, priority, enabled, conditions, action
            FROM mapping_rule
           WHERE tenant_id = ${tenantId} AND enabled = true
           ORDER BY priority ASC, id ASC
        `;

        return { claim, rows: expenditureRows, rules: ruleRows.map(rowToMappingRule), truncated };
      });

      if (!loaded.claim) {
        return reply.status(404).send({
          error: 'claim_not_found',
          message: 'No claim with that id in this firm',
          requestId: req.id,
        });
      }

      // Run engine + emit events per row. Per-row rather than vectorised
      // so each event-chain insert is independent of the others (a
      // failure mid-batch surfaces as a 500 with whatever events
      // already landed retained — the chain is append-only).
      let totalMatched = 0;
      const expenditures: Array<{
        expenditure_id: string;
        matched: number;
        emitted: EmittedEvent[];
        skipped: SkippedRule[];
      }> = [];
      for (const row of loaded.rows) {
        if (!row.claim_id) {
          // Skip rows missing claim_id (legacy data); record as a
          // skipped entry so the response is honest about coverage.
          expenditures.push({
            expenditure_id: row.id,
            matched: 0,
            emitted: [],
            skipped: [{ rule_id: '', reason: 'expenditure missing claim_id' }],
          });
          continue;
        }
        const expenditure = rowToExpenditureForRules(row);
        const matches: RuleMatch[] = applyRules(loaded.rules, expenditure);
        totalMatched += matches.length;
        const emitted: EmittedEvent[] = [];
        const skipped: SkippedRule[] = [];
        const claimId = row.claim_id;
        for (const match of matches) {
          const result = await emitForMatch({
            match,
            expenditure: {
              id: row.id,
              subject_tenant_id: row.subject_tenant_id,
              claim_id: claimId,
            },
            tenantId,
            userId,
          });
          if (result.emitted) emitted.push(result.emitted);
          if (result.skipped) skipped.push(result.skipped);
        }
        expenditures.push({
          expenditure_id: row.id,
          matched: matches.length,
          emitted,
          skipped,
        });
      }

      return {
        expenditures,
        summary: {
          total_expenditures: expenditures.length,
          total_matched: totalMatched,
          total_emitted: expenditures.reduce((s, e) => s + e.emitted.length, 0),
          total_skipped: expenditures.reduce((s, e) => s + e.skipped.length, 0),
        },
        truncated: loaded.truncated,
      };
    },
  );
}
