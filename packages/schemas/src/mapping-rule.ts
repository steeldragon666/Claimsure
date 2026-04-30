import { z } from 'zod';
import { Iso8601, Uuid } from './primitives.js';

/**
 * Wire-format Zod schemas + canonical TypeScript types for the
 * mapping_rule REST surface (T-B9 + Task 3.1).
 *
 * **Layering** (post-Task 3.1):
 *
 *   - `@cpa/schemas` is the leaf package. It owns BOTH the Zod wire
 *     schemas AND the canonical TypeScript types `MappingRule`,
 *     `RuleCondition`, `RuleAction`, `RuleMatch`,
 *     `ExpenditureForRules`, `ExpenditureKind`.
 *   - `@cpa/db` and `@cpa/integrations` both depend on `@cpa/schemas`
 *     and import these types directly — no more inline duplicates in
 *     either package.
 *   - The previous arrangement put the canonical types in
 *     `@cpa/integrations/xero-accounting/mapping-rules/types.ts` and
 *     redeclared them inline in `@cpa/db`. That couldn't be fixed by
 *     moving the types to `@cpa/db` (would have given `@cpa/integrations
 *     -> @cpa/db -> ... -> @cpa/integrations` cycles via the schema
 *     re-exports), so the canonical home is here in the leaf package
 *     where every layer can reach them. See `packages/db/README.md`
 *     for the cycle analysis that drove the decision.
 *
 * **Two layers of defence at the API boundary**:
 *
 *   1. Zod (this file) catches malformed request bodies — wrong field
 *      name, wrong op for a field, missing required keys.
 *   2. B8's `evaluateRule` catches semantic violations — apportion sum
 *      != 100, regex compile failure, inverted between range. The route
 *      layer triggers it by calling `evaluateRule(rule, dummy)` against
 *      a synthetic expenditure before the INSERT/UPDATE.
 *
 * The Zod shapes and the TypeScript types are pinned against each other
 * by the identity assertion in `apps/api/src/routes/mapping-rules.ts`,
 * which lives in the API package because that is where both
 * `@cpa/schemas` (for Zod) and `@cpa/integrations` (for B8's runtime
 * engine) are in scope.
 */

// ===========================================================================
// Canonical TypeScript types (Task 3.1).
//
// Moved verbatim from
// packages/integrations/src/xero-accounting/mapping-rules/types.ts —
// byte-identical at move time. The integrations package now re-exports
// these for backwards compatibility with existing call sites.
// ===========================================================================

/**
 * Discriminator on `ExpenditureForRules.kind`. Mirrors the three Xero
 * resources the B-swimlane syncs (Invoices, BankTransactions, Receipts).
 * Add new kinds here only when a new sync resource lands.
 */
export type ExpenditureKind = 'INVOICE' | 'BANK_TX' | 'RECEIPT';

/**
 * Subset of expenditure columns the engine evaluates against. Kept
 * intentionally narrow:
 *
 *   - The engine is a pure function that does NOT need the full
 *     expenditure row; passing only the fields we read keeps test
 *     fixtures lean and the contract honest.
 *   - All free-text fields are nullable because Xero allows them to be
 *     omitted on the wire (e.g. a bank transaction may have no
 *     `Reference`).
 *   - `amount` is always a positive number, expressed in the
 *     expenditure's own currency. Sign normalisation (Xero's negative
 *     credit-note amounts, etc.) is the syncer's job, not the engine's.
 *   - `currency` is ISO 4217 (e.g. `'AUD'`, `'USD'`). The engine treats
 *     it as an opaque string — comparison is case-sensitive against the
 *     value the caller writes.
 *   - `date` is an ISO date string (`YYYY-MM-DD`). Lexicographic string
 *     comparison is correct for the ISO format and avoids dragging in
 *     `Date` parsing (and its timezone footguns) inside the engine.
 */
export type ExpenditureForRules = {
  id: string;
  kind: ExpenditureKind;
  contact_name: string | null;
  reference: string | null;
  account_code: string | null;
  /** Positive number in the expenditure's currency. */
  amount: number;
  /** ISO 4217 currency code (e.g. 'AUD'). */
  currency: string;
  description: string | null;
  /** ISO date string (`YYYY-MM-DD`). */
  date: string;
};

/**
 * A single condition on a rule. Within a rule, ALL conditions must hold
 * (AND semantics — see `evaluateRule`).
 *
 * Field/op pairings are intentionally restricted via the discriminated
 * union: `amount between` is a tuple, `account_code in` accepts a string
 * array, etc. The engine relies on this narrowing — you cannot construct
 * a `{ field: 'amount', op: 'eq', value: 'foo' }` and pass typecheck.
 *
 * `case_insensitive` only applies to string-comparison ops (`eq`,
 * `contains`, `matches` on `contact_name | reference | description`).
 * Setting it on a non-string op is silently ignored — see the README
 * for the rationale and the test that pins this behaviour.
 *
 * `matches` op semantics: `value` is a regex source string (no flags).
 * The engine compiles it with `new RegExp(value, flags)` where `flags`
 * is `'i'` when `case_insensitive: true`, `''` otherwise. An invalid
 * regex throws `InvalidRuleError` at evaluation time — we don't pre-
 * validate at construction because rules may arrive untrusted from the
 * (B9) API layer; the engine is the validation point.
 */
export type RuleCondition =
  | {
      field: 'contact_name';
      op: 'eq' | 'contains' | 'matches';
      value: string;
      case_insensitive?: boolean;
    }
  | {
      field: 'reference';
      op: 'eq' | 'contains' | 'matches';
      value: string;
      case_insensitive?: boolean;
    }
  | {
      field: 'description';
      op: 'eq' | 'contains' | 'matches';
      value: string;
      case_insensitive?: boolean;
    }
  | { field: 'account_code'; op: 'eq'; value: string }
  | { field: 'account_code'; op: 'in'; value: readonly string[] }
  | { field: 'amount'; op: 'gt' | 'gte' | 'lt' | 'lte'; value: number }
  | { field: 'amount'; op: 'between'; value: readonly [number, number] }
  | { field: 'kind'; op: 'eq'; value: ExpenditureKind }
  | { field: 'kind'; op: 'in'; value: readonly ExpenditureKind[] }
  | { field: 'currency'; op: 'eq'; value: string }
  | { field: 'currency'; op: 'in'; value: readonly string[] }
  | { field: 'date'; op: 'before' | 'after'; value: string }
  | { field: 'date'; op: 'between'; value: readonly [string, string] };

/**
 * The action a matching rule prescribes. Three shapes:
 *
 *   - `map_to_activity`: 100% of the expenditure goes to one activity.
 *   - `apportion`: split across N activities; percentages must sum to
 *     100 (±0.001 float tolerance) and every percentage must be > 0.
 *     Validated at evaluation time — `evaluateRule` throws
 *     `InvalidRuleError` on a malformed apportion.
 *   - `flag_for_review`: the engine surfaces a human-readable reason;
 *     B10's job will route these to the operator review queue rather
 *     than emitting `EXPENDITURE_LINE_MAPPED` directly.
 */
export type RuleAction =
  | { type: 'map_to_activity'; activity_id: string }
  | {
      type: 'apportion';
      allocations: ReadonlyArray<{ activity_id: string; percentage: number }>;
    }
  | { type: 'flag_for_review'; reason: string };

/**
 * The full rule. `priority` is ascending — LOWER number = HIGHER
 * priority (matches the convention C5 already uses for sync ordering).
 * Equal priorities are tie-broken by `id` ascending lexicographically;
 * `applyRules` performs that stable sort once at the start of each call.
 *
 * `enabled: false` rules are silently skipped — they are NOT considered
 * for matching at all and produce no `RuleMatch`.
 *
 * `tenant_id` is carried on the rule (vs. enforced by a parameter)
 * because B9 will store rules in a tenant-scoped table and the engine
 * is happiest when each rule is self-describing. B8 itself does NOT do
 * tenant-scoping — `applyRules` evaluates whatever you pass it. The
 * caller (B10's job) is responsible for selecting only the current
 * tenant's rules out of the DB.
 */
export type MappingRule = {
  id: string;
  tenant_id: string;
  name: string;
  /** Lower number = higher priority. */
  priority: number;
  enabled: boolean;
  /** AND semantics — all conditions must hold for the rule to match. */
  conditions: readonly RuleCondition[];
  action: RuleAction;
};

/**
 * A successful match returned from `evaluateRule` / `applyRules`. We
 * surface only the fields B10 will need to emit
 * `EXPENDITURE_LINE_MAPPED` — `rule_id` for traceability, `rule_name`
 * for human readability in audit logs, `priority` so the consumer can
 * tie-break externally if it chooses, and `action` so the consumer can
 * apply the side effect without re-querying the rule.
 *
 * Notably absent: the matched conditions themselves and the
 * expenditure id. The consumer already holds both at call time and
 * including them would balloon the payload for the high-volume B10
 * job. If we need them later for explainability, add a separate
 * `explainRule(rule, expenditure) -> Reason[]` API rather than widen
 * this shape.
 */
export type RuleMatch = {
  rule_id: string;
  rule_name: string;
  priority: number;
  action: RuleAction;
};

// ---------------------------------------------------------------------------
// Condition schemas — one per (field, op) pair B8 accepts. The outer
// discriminated union is on `field`; for fields with multiple ops we
// nest a second `discriminatedUnion` on `op`. Total: 16 leaf shapes
// matching the 16 branches of B8's `RuleCondition` union.
// ---------------------------------------------------------------------------

const stringOpsSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('eq'), value: z.string(), case_insensitive: z.boolean().optional() }),
  z.object({
    op: z.literal('contains'),
    value: z.string(),
    case_insensitive: z.boolean().optional(),
  }),
  z.object({
    op: z.literal('matches'),
    value: z.string(),
    case_insensitive: z.boolean().optional(),
  }),
]);

const contactNameConditionSchema = z
  .object({ field: z.literal('contact_name') })
  .and(stringOpsSchema);
const referenceConditionSchema = z.object({ field: z.literal('reference') }).and(stringOpsSchema);
const descriptionConditionSchema = z
  .object({ field: z.literal('description') })
  .and(stringOpsSchema);

const accountCodeConditionSchema = z.discriminatedUnion('op', [
  z.object({ field: z.literal('account_code'), op: z.literal('eq'), value: z.string() }),
  z.object({
    field: z.literal('account_code'),
    op: z.literal('in'),
    // `readonly string[]` on B8's side — z.array narrows to writable
    // string[]. Both are assignable to `readonly string[]` (the engine
    // never mutates), so the runtime contract holds.
    value: z.array(z.string()).min(1),
  }),
]);

const amountConditionSchema = z.discriminatedUnion('op', [
  z.object({
    field: z.literal('amount'),
    op: z.enum(['gt', 'gte', 'lt', 'lte']),
    value: z.number().finite(),
  }),
  z.object({
    field: z.literal('amount'),
    op: z.literal('between'),
    // [min, max] tuple — B8's engine throws InvalidRuleError if min > max
    // at evaluate time, so we don't pre-validate the order here.
    value: z.tuple([z.number().finite(), z.number().finite()]),
  }),
]);

const expenditureKindLiteral = z.enum(['INVOICE', 'BANK_TX', 'RECEIPT']);

const kindConditionSchema = z.discriminatedUnion('op', [
  z.object({ field: z.literal('kind'), op: z.literal('eq'), value: expenditureKindLiteral }),
  z.object({
    field: z.literal('kind'),
    op: z.literal('in'),
    value: z.array(expenditureKindLiteral).min(1),
  }),
]);

const currencyConditionSchema = z.discriminatedUnion('op', [
  z.object({ field: z.literal('currency'), op: z.literal('eq'), value: z.string() }),
  z.object({
    field: z.literal('currency'),
    op: z.literal('in'),
    value: z.array(z.string()).min(1),
  }),
]);

const dateConditionSchema = z.discriminatedUnion('op', [
  z.object({
    field: z.literal('date'),
    op: z.enum(['before', 'after']),
    // ISO date `YYYY-MM-DD` — lex-comparable, matches B8's contract.
    value: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a YYYY-MM-DD date'),
  }),
  z.object({
    field: z.literal('date'),
    op: z.literal('between'),
    value: z.tuple([
      z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    ]),
  }),
]);

/**
 * Combined condition schema. Discriminated on `field` via a manual
 * `z.union` (Zod's discriminatedUnion can't compose with the
 * `z.object().and(z.discriminatedUnion('op', …))` patterns used above,
 * since `field` carries multiple ops on the string-field side). The
 * leaf type union still matches B8's `RuleCondition` exactly — pinned
 * by the identity assertion at the bottom of this file.
 */
export const ruleConditionSchema = z.union([
  contactNameConditionSchema,
  referenceConditionSchema,
  descriptionConditionSchema,
  accountCodeConditionSchema,
  amountConditionSchema,
  kindConditionSchema,
  currencyConditionSchema,
  dateConditionSchema,
]);

// ---------------------------------------------------------------------------
// Action schemas — one per `type` discriminant in B8's `RuleAction`.
// ---------------------------------------------------------------------------

export const ruleActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('map_to_activity'), activity_id: Uuid }),
  z.object({
    type: z.literal('apportion'),
    allocations: z
      .array(z.object({ activity_id: Uuid, percentage: z.number().positive().finite() }))
      .min(1),
  }),
  z.object({ type: z.literal('flag_for_review'), reason: z.string().min(1) }),
]);

// ---------------------------------------------------------------------------
// Request bodies + list query.
// ---------------------------------------------------------------------------

/**
 * POST /v1/mapping-rules body. `enabled` defaults to `true` server-side
 * if omitted (matches the column default in 0018_mapping_rule.sql).
 * `conditions` may be empty — B8's engine treats `[]` as the catch-all
 * "match everything" rule (vacuous truth), useful at the bottom of the
 * priority stack.
 */
export const createMappingRuleBody = z.object({
  name: z.string().min(1).max(200),
  priority: z.number().int().nonnegative(),
  enabled: z.boolean().optional(),
  conditions: z.array(ruleConditionSchema),
  action: ruleActionSchema,
});
// Type name disambiguated from the legacy `CreateMappingRuleBody` in
// expenditure_mapping_rule.ts (F4/F5 era, different shape) — both
// schemas live until the F4/F5 surface is retired.
export type CreateMappingRuleApiBody = z.infer<typeof createMappingRuleBody>;

/**
 * PATCH /v1/mapping-rules/:id body. All fields optional; the route
 * layer rejects empty patches with a 400 (mirrors brand-config PATCH).
 */
export const updateMappingRuleBody = createMappingRuleBody.partial();
export type UpdateMappingRuleApiBody = z.infer<typeof updateMappingRuleBody>;

/**
 * GET /v1/mapping-rules query. `enabled` filters on the soft-delete /
 * disable flag; omitting it returns both. `cursor` is opaque base64url
 * JSON — clients shouldn't introspect.
 *
 * `enabled` MUST be a value-aware transformer rather than
 * `z.coerce.boolean()` — the latter calls `Boolean(value)`, which
 * returns `true` for ANY non-empty string (including the literal
 * string `'false'`). A naive coerce would silently flip
 * `?enabled=false` into a filter for enabled=true rows. The enum +
 * transform pattern locks the contract to the two valid wire values.
 */
export const listMappingRulesQuery = z.object({
  enabled: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});
export type ListMappingRulesQuery = z.infer<typeof listMappingRulesQuery>;

/**
 * Wire-format response for a single mapping rule. The route's `toApi`
 * helper constructs this from the raw row. Note `tenant_id` is included
 * for the consumer's convenience — it always equals the active firm
 * (RLS guarantees no cross-firm rows escape the query).
 */
export const mappingRuleApi = z.object({
  id: Uuid,
  tenant_id: Uuid,
  name: z.string(),
  priority: z.number().int().nonnegative(),
  enabled: z.boolean(),
  conditions: z.array(ruleConditionSchema),
  action: ruleActionSchema,
  created_at: Iso8601,
  created_by_user_id: Uuid,
  updated_at: Iso8601,
});
export type MappingRuleApi = z.infer<typeof mappingRuleApi>;

// Identity assertions against B8's runtime types live in
// apps/api/src/routes/mapping-rules.ts (the API package depends on both
// @cpa/schemas and @cpa/integrations, so the assertion can be expressed
// there without inverting the schemas-package layering).
