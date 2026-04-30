# @cpa/db

Drizzle ORM schema, migrations, and the postgres-js client wrapper for the
CPA platform.

## Layering — what may depend on what

```
@cpa/schemas  (leaf — zod + canonical TS types, no @cpa/* deps)
   ^
   |
@cpa/db       (drizzle schema, migrations, sql client)
   ^
   |
@cpa/integrations, @cpa/audit-score, @cpa/agents, @cpa/auth, ...
   ^
   |
apps/api, apps/web, apps/mobile
```

`@cpa/db` may import from `@cpa/schemas` and the surrounding
infrastructure (drizzle-orm, postgres). It must NOT import from
`@cpa/integrations`, `@cpa/auth`, or any consumer further up the stack.

## The mapping-rule type cycle (Task 3.1)

The mapping-rule jsonb columns (`mapping_rule.conditions`,
`mapping_rule.action`) need TypeScript shape annotations via Drizzle's
`$type<T>()`. The same shapes are used by:

- `@cpa/integrations/xero-accounting/mapping-rules` — the runtime engine
  (`evaluateRule`, `applyRules`) consumes them.
- `apps/api/src/routes/mapping-rules.ts` — the CRUD surface validates
  request bodies against them via Zod, then re-emits them on the wire.
- `@cpa/db/schema/mapping_rule` — this package, for ORM-side narrowing.

If the canonical types lived in `@cpa/integrations`, then `@cpa/db`
could not import them: `@cpa/integrations` already depends on
`@cpa/db` (the syncers write through Drizzle), so the reverse import
would close a cycle. Before Task 3.1 the workaround was to redeclare
the shapes inline in `packages/db/src/schema/mapping_rule.ts` — a
hand-maintained byte-for-byte copy with a TODO referring to
`apps/api/src/routes/mapping-rules.ts` for the identity assertion that
caught drift.

Task 3.1 dissolves the cycle by moving the canonical TypeScript types
**down** into `@cpa/schemas` (the leaf package). Both `@cpa/db` and
`@cpa/integrations` depend on `@cpa/schemas`, and `@cpa/schemas`
depends on nothing in `@cpa/*`, so:

- `@cpa/db` imports `RuleCondition` / `RuleAction` from `@cpa/schemas`.
- `@cpa/integrations/xero-accounting/mapping-rules/types.ts` re-exports
  the same names from `@cpa/schemas` for backwards-compatibility with
  call sites that still use the integration-package import path.
- The Zod wire schemas in `@cpa/schemas/mapping-rule.ts` and the
  TypeScript types now live in the same file, with the identity
  assertion in `apps/api/src/routes/mapping-rules.ts` still pinning
  them against B8's runtime `evaluateRule`.

**Constraint going forward**: never put a TypeScript type used by
`@cpa/db` jsonb annotations in a package that depends on `@cpa/db`.
The cycle resurfaces if you do. Put it in `@cpa/schemas` or inline it
here with a written justification.
