/**
 * Mapping rules engine — type contracts (T-B8).
 *
 * **Post-Task 3.1**: the canonical types now live in `@cpa/schemas`
 * (`packages/schemas/src/mapping-rule.ts`). This file is a thin
 * re-export so existing call sites (`./evaluate.ts`, `./index.ts`,
 * external consumers via `@cpa/integrations/xero-accounting`) keep
 * compiling unchanged.
 *
 * **Why the move?**
 *
 *   - `@cpa/db` needs the same shapes for its `mapping_rule` jsonb
 *     column annotations. It cannot import from `@cpa/integrations`
 *     because integrations depends on db (sync writers / queue
 *     writers), so the import would cycle.
 *   - Putting the types in `@cpa/schemas` (the leaf package) breaks
 *     that cycle: both db and integrations depend on schemas, and
 *     schemas depends on neither.
 *   - The Zod wire schemas in `@cpa/schemas` (created in T-B9) already
 *     lived in the same file, so the types and the Zod sit alongside
 *     each other and the identity assertion in
 *     `apps/api/src/routes/mapping-rules.ts` continues to pin them
 *     together.
 *
 * The previous version of this file housed the canonical types directly.
 * It also held a long design-intent docblock; that prose is now
 * inlined in `packages/schemas/src/mapping-rule.ts` next to the type
 * declarations, plus the cycle analysis is captured in
 * `packages/db/README.md`.
 */
export type {
  ExpenditureForRules,
  ExpenditureKind,
  MappingRule,
  RuleAction,
  RuleCondition,
  RuleMatch,
} from '@cpa/schemas';
