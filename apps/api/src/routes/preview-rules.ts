import type { FastifyInstance } from 'fastify';
import { requireSession } from '@cpa/auth';
import { sql } from '@cpa/db/client';
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
 * Mapping-rule preview surface (T-B10).
 *
 * Two endpoints under `/v1/...preview-rules`:
 *
 *   POST /v1/expenditures/:id/preview-rules — single-row preview
 *   POST /v1/claims/:id/preview-rules       — batch preview (capped)
 *
 * **Why "preview" not "writer"**: B10 *would* emit
 * `EXPENDITURE_MAPPED` and `EXPENDITURE_APPORTIONED` events when rules
 * match. Those event kinds are deferred to A-swimlane (they need
 * schema/migration work first). Rather than block B10, this surface
 * exercises B8's rules engine against real expenditure data and
 * returns the would-be matches as JSON — read-only, no chain writes.
 *
 * When A-swimlane adds the deferred events, a "writer" version of
 * these endpoints (B11+) becomes a near-mechanical extension: same
 * load + engine call, but emit events instead of returning JSON.
 *
 * **Auth + RLS**:
 *   - Both routes require a session (`requireSession`).
 *   - Roles: admin / consultant only. Viewers do NOT get this surface
 *     because the response exposes rule logic (action types, activity
 *     ids), and the project's role model treats rule logic as
 *     consultant-grade information.
 *   - Every query runs inside `sql.begin` with `app.current_tenant_id`
 *     set, and every WHERE clause additionally filters
 *     `tenant_id = $tenantId` (defence in depth — same pattern as
 *     mapping-rules.ts and employees.ts).
 *   - Cross-firm expenditure / claim ids return 404 (info hiding).
 *
 * **Engine error surfacing**: if `applyRules` throws
 * `InvalidRuleError`, we return 500 with the error message — this
 * means B9's write-time validator missed an invalid rule, which is a
 * real bug to flag, not silently swallow. The `Error.name` discrimination
 * pattern matches B8's portable-error convention.
 *
 * **Boundary**: this endpoint is read-only. Adding a "preview-and-
 * commit" mode here would dilute the audit story (the boundary
 * "preview is read-only" is load-bearing — events written by a
 * writer endpoint will live alongside human-captured events on the
 * same chain, and a single endpoint with a `commit: true` flag would
 * make the audit trail's source-of-action ambiguous).
 *
 * **Claim → expenditure relationship**: there is no direct FK from
 * `expenditure` to `claim`. Both link to `subject_tenant_id`, and
 * `claim` carries `fiscal_year` while `expenditure` carries
 * `expenditure_date`. The batch endpoint resolves the relationship by
 * joining on `subject_tenant_id` AND filtering `expenditure_date`
 * within the Australian fiscal year window
 * (`{fiscal_year-1}-07-01` through `{fiscal_year}-06-30`).
 *
 * **Batch cap**: 500 expenditures per request, with a `truncated:
 * true` flag when the underlying claim has more. We chose cap-and-
 * flag over cursor pagination because:
 *   1. Preview is a UI-driven testing surface — admins eyeball the
 *      output, they don't iterate. The cap is generous enough that
 *      truncation is rare in practice (a claim with >500 expenditures
 *      is exceptional).
 *   2. A cursor would require a stable secondary sort (priority +
 *      id) that's meaningful at the engine output level, not the
 *      expenditure level — but the engine output is per-expenditure,
 *      so the cursor would need a compound encoding. Out of scope
 *      for a "preview" surface.
 *   3. A1's claims fan-out uses the same cap-and-flag pattern, so
 *      consumers already understand the convention.
 */

// ---------------------------------------------------------------------------
// Constants.
// ---------------------------------------------------------------------------

/**
 * Maximum number of expenditures the batch endpoint will process per
 * request. Above this, the response carries `truncated: true` and the
 * `expenditures` array is the first 500 (ordered by expenditure_date
 * DESC, id ASC for tie-break stability).
 */
const BATCH_CAP = 500;

// ---------------------------------------------------------------------------
// Named errors.
// ---------------------------------------------------------------------------

/**
 * Thrown by `mapSourceToKind` if a row carries a `source` value that
 * isn't in the closed enum. The DB CHECK constraint
 * (`expenditure_source_valid`) makes this unreachable in production,
 * but the named error matches the codebase's convention (B8's
 * `InvalidRuleError`, etc.) — the global error handler emits
 * `error: e.name` so a real schema-vs-route drift surfaces with a
 * distinctive identifier instead of bare `Error`.
 */
class UnknownExpenditureSourceError extends Error {
  override readonly name = 'UnknownExpenditureSourceError';
}

// ---------------------------------------------------------------------------
// Row → ExpenditureForRules mapping.
// ---------------------------------------------------------------------------

// Closed-enum representation of the DB `expenditure.source` column.
// Mirrored from the `expenditure_source_valid` CHECK constraint so the
// `mapSourceToKind` exhaustiveness check below catches drift at
// typecheck time.
type ExpenditureSource = 'xero_invoice' | 'xero_bank_tx' | 'xero_receipt' | 'manual';

/**
 * Map the DB `source` enum to B8's `ExpenditureKind` enum.
 *
 * The two enums are intentionally different shapes:
 *   - DB `source`: 'xero_invoice' | 'xero_bank_tx' | 'xero_receipt' | 'manual'
 *   - B8 `kind`:   'INVOICE' | 'BANK_TX' | 'RECEIPT'
 *
 * `manual` has no native B8 kind — manual entries are user-captured
 * receipts in spirit (an employee expense claim, a cash payment with
 * no Xero anchor). We map them to `'RECEIPT'` so rules with
 * `kind eq RECEIPT` apply to manual entries too. This is documented
 * here rather than added to B8's type because B8 is a leaf module
 * with its own contract; the API layer is the right place to bridge
 * the storage-vs-engine impedance mismatch.
 *
 * NOTE on cross-swimlane consistency: C9 (separate swimlane) maps
 * `'manual' → 'INVOICE'`. The reconciliation is deliberately deferred
 * to D-swimlane so it lands in one coordinated commit; B10 keeps
 * `'manual' → 'RECEIPT'` until then.
 */
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
      // Exhaustiveness check — the DB CHECK constraint
      // (`expenditure_source_valid`) guards this at runtime. The
      // `never` assignment turns any future enum addition into a
      // typecheck failure here, surfacing schema-vs-route drift at
      // build time.
      const _exhaustive: never = source;
      throw new UnknownExpenditureSourceError(
        `preview-rules: unknown expenditure source '${String(_exhaustive)}'`,
      );
    }
  }
}

/**
 * Row shape for the SELECT we issue. The fields we need across both
 * the single and batch endpoints overlap entirely; one shape covers
 * both. `total_amount` arrives as a string from postgres-js (NUMERIC
 * is not auto-coerced — see expenditure.ts schemas) so we parse to a
 * number at the row → `ExpenditureForRules` boundary. ISO date is
 * already a string and lexicographically comparable; pass through.
 *
 * `account_code` and `description` come from the FIRST line of the
 * expenditure as a representative source for B8's
 * `ExpenditureForRules` (which wants both, but they live one table
 * down on `expenditure_line`).
 *
 * "First line" here means `ORDER BY line_number ASC, id ASC` (P5
 * Theme 1.3). `line_number` is the authored 1-based sequence stamped
 * by sync paths and manual route handlers; `id` is the UUID
 * tie-breaker for legacy rows that were backfilled to line_number=1
 * (and any future rows that share a line_number for the same
 * expenditure, though the unique index on (expenditure_id,
 * line_number) prevents that going forward).
 *
 * Correctness ceiling (now reduced, but not eliminated): for multi-line
 * expenditures with rules using `account_code eq` (or `description
 * contains`) conditions, the rule matches or misses based on which
 * line is line_number=1. Sync paths now stamp this meaningfully (the
 * first line of the upstream invoice), so for Xero-sourced data this
 * is a real, documented choice rather than an arbitrary UUID order.
 *
 * The proper fix remains per-line rule application (`lines:
 * ExpenditureLineForRules[]` on the engine input — see TODO(B11+) at
 * the route doc-block for line-level semantics).
 *
 * TODO(B11+): per-line rule semantics so all lines participate.
 */
interface ExpenditureRow {
  id: string;
  source: ExpenditureSource;
  vendor_name: string;
  reference: string | null;
  expenditure_date: Date | string;
  total_amount: string;
  currency: string;
  account_code: string | null;
  description: string | null;
}

/**
 * Convert a DB date column to a YYYY-MM-DD string. postgres-js may
 * return `date` columns as either a `Date` object (parse-as-date
 * paths) or a plain string. The B8 engine wants the canonical ISO
 * date format.
 */
function dateToIsoDate(d: Date | string): string {
  if (typeof d === 'string') {
    // postgres-js sometimes returns dates as 'YYYY-MM-DD' already;
    // guard against the timestamptz path that adds a time component.
    return d.length >= 10 ? d.slice(0, 10) : d;
  }
  return d.toISOString().slice(0, 10);
}

/**
 * Build the engine input from a DB row. Pure projection — no I/O.
 *
 * `vendor_name` is the source of B8's `contact_name`. The DB column
 * is non-null (Xero always supplies a vendor; manual entries require
 * one too — see expenditure.ts); the engine accepts `string | null`
 * but we'll never produce null here in practice. Keeping the signature
 * `string | null` preserves the engine's contract.
 */
function rowToExpenditureForRules(row: ExpenditureRow): ExpenditureForRules {
  return {
    id: row.id,
    kind: mapSourceToKind(row.source),
    contact_name: row.vendor_name,
    reference: row.reference,
    account_code: row.account_code,
    // total_amount is NUMERIC(12,2) — postgres-js returns a string. The
    // ".NN" suffix means parseFloat is lossless within the precision.
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

/**
 * Cast jsonb columns to B8's runtime types. The same pattern as
 * mapping-rules.ts: the row went through Zod + B8 validation at write
 * time, so the cast is sound. The engine re-validates the action
 * eagerly on each call (B8 contract) — if a malformed rule somehow
 * escaped write-time validation it'll throw `InvalidRuleError` and
 * we'll surface a 500.
 */
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
// Routes.
// ---------------------------------------------------------------------------

export function registerPreviewRules(app: FastifyInstance): void {
  // -------------------------------------------------------------------
  // POST /v1/expenditures/:id/preview-rules — admin / consultant
  // -------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/v1/expenditures/:id/preview-rules',
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

      return await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;

        // Step 1: load the expenditure + first line under RLS. LEFT JOIN
        // because manual entries may have zero lines (account_code +
        // description default to NULL, which the engine handles via
        // the null-short-circuit branch in matchStringField).
        //
        // Defence-in-depth: the WHERE clause repeats `tenant_id =
        // ${tenantId}` even though the RLS policy already gates this
        // — same belt-and-braces posture as mapping-rules.ts.
        const expenditureRows = await tx<ExpenditureRow[]>`
          SELECT
            e.id,
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
        if (!row) {
          return reply.status(404).send({
            error: 'expenditure_not_found',
            message: 'No expenditure with that id in this firm',
            requestId: req.id,
          });
        }

        // Step 2: load enabled mapping rules for the tenant. We filter
        // to enabled = true here (vs. letting B8's `applyRules` skip
        // disabled rules) because:
        //   - Disabled rules are noise on the wire — the engine would
        //     skip them anyway.
        //   - The DB filter shrinks the result set before it crosses
        //     the wire, so a tenant with hundreds of archived rules
        //     stays fast.
        const ruleRows = await tx<RawMappingRuleRow[]>`
          SELECT id, tenant_id, name, priority, enabled, conditions, action
            FROM mapping_rule
           WHERE tenant_id = ${tenantId} AND enabled = true
           ORDER BY priority ASC, id ASC
        `;
        const rules = ruleRows.map(rowToMappingRule);

        // Step 3: build the engine input + run the engine. Throwing
        // InvalidRuleError surfaces as a 500 via the global error
        // handler — B9's write-time validator should have caught any
        // malformed rule before it landed in the DB, so this would
        // be a real bug. We deliberately do NOT catch + reshape to
        // 400 because that would hide the bug from the caller +
        // logs.
        const expenditure = rowToExpenditureForRules(row);
        const matches: RuleMatch[] = applyRules(rules, expenditure);

        return { matches };
      });
    },
  );

  // -------------------------------------------------------------------
  // POST /v1/claims/:id/preview-rules — admin / consultant (batch)
  // -------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/v1/claims/:id/preview-rules',
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

      return await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;

        // Step 1: confirm the claim exists + is visible. Cross-firm =
        // 404 (info hiding). Pull subject_tenant_id + fiscal_year so
        // we can resolve the expenditure window.
        const claimRows = await tx<
          { id: string; subject_tenant_id: string; fiscal_year: number }[]
        >`
          SELECT id, subject_tenant_id, fiscal_year
            FROM claim
           WHERE id = ${id} AND tenant_id = ${tenantId}
        `;
        const claim = claimRows[0];
        if (!claim) {
          return reply.status(404).send({
            error: 'claim_not_found',
            message: 'No claim with that id in this firm',
            requestId: req.id,
          });
        }

        // Step 2: resolve the fiscal-year window. Australian fiscal
        // years run 1 July → 30 June. `fiscal_year = 2025` covers
        // 2024-07-01 through 2025-06-30.
        const fyStart = `${claim.fiscal_year - 1}-07-01`;
        const fyEnd = `${claim.fiscal_year}-06-30`;

        // Step 3: count total expenditures in the window (for the
        // truncated flag). Cheap because (subject_tenant_id) has its
        // own index.
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

        // Step 4: load capped expenditures + their first lines. ORDER
        // BY expenditure_date DESC, id ASC for stability — the same
        // tie-break pattern mapping-rules.ts uses.
        //
        // voided_at IS NULL filters soft-voided rows (they survive for
        // audit but aren't part of apportionment per expenditure.ts).
        const expenditureRows = await tx<ExpenditureRow[]>`
          SELECT
            e.id,
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

        // Step 5: load rules ONCE and apply across every expenditure.
        // Reusing the rules array across iterations is the whole
        // reason this is a batch endpoint vs. N single calls — the DB
        // round-trip for the rules is the dominant cost at small N.
        const ruleRows = await tx<RawMappingRuleRow[]>`
          SELECT id, tenant_id, name, priority, enabled, conditions, action
            FROM mapping_rule
           WHERE tenant_id = ${tenantId} AND enabled = true
           ORDER BY priority ASC, id ASC
        `;
        const rules = ruleRows.map(rowToMappingRule);

        // Step 6: run the engine per row, accumulating matches +
        // summary counts. Pure CPU loop after the SQL — no async
        // inside, so this keeps the transaction short.
        let withMatches = 0;
        let withoutMatches = 0;
        let totalMatchCount = 0;
        const expenditures = expenditureRows.map((row) => {
          const expenditure = rowToExpenditureForRules(row);
          const matches: RuleMatch[] = applyRules(rules, expenditure);
          if (matches.length > 0) {
            withMatches++;
            totalMatchCount += matches.length;
          } else {
            withoutMatches++;
          }
          return {
            expenditure_id: expenditure.id,
            kind: expenditure.kind,
            amount: expenditure.amount,
            currency: expenditure.currency,
            matches,
          };
        });

        return {
          expenditures,
          summary: {
            total_expenditures: expenditures.length,
            with_matches: withMatches,
            without_matches: withoutMatches,
            total_match_count: totalMatchCount,
          },
          // Always include the flag so consumers don't have to
          // probe — false when the cap wasn't hit.
          truncated,
        };
      });
    },
  );
}
