import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import type { RuleAction, RuleCondition } from '@cpa/schemas';
import { tenant } from './tenant.js';
import { user } from './user.js';

/**
 * jsonb shape annotations — pulled from the canonical types in
 * `@cpa/schemas/mapping-rule` (Task 3.1).
 *
 * **History**: prior to Task 3.1, these shapes were inlined in this file
 * because @cpa/db couldn't import from @cpa/integrations (the canonical
 * home at the time) without inverting the dep graph (integrations
 * depends on db). Task 3.1 moved the canonical types down into the leaf
 * package @cpa/schemas, which both db and integrations already depend
 * on, so the cycle dissolves. See `packages/db/README.md` for the
 * cycle analysis.
 *
 * **Why annotate at all?** Drizzle's `$type<T>()` gives narrowing on
 * reads/writes through the ORM. The route layer reads from postgres-js
 * directly (not through the ORM), so the annotation is mostly
 * documentation — but it ensures any future drizzle-orm consumer of
 * this column gets the right shape automatically.
 */

/**
 * Expenditure-to-activity mapping rule (T-B9).
 *
 * Stores rules authored by consultants/admins that auto-map (or flag for
 * review) Xero expenditure lines as they're synced. The runtime engine
 * lives in `@cpa/integrations/xero-accounting/mapping-rules` (T-B8); B9
 * persists the rules + ships the CRUD API; B10 wires them into the
 * background apply-rules job.
 *
 * **Composite primary key**: `(tenant_id, id)`. Tenant-scoped tables use
 * a composite PK so RLS isolation is structural — even if a privileged
 * caller accidentally bypassed the policy, two firms can't collide on
 * the `id` half (each `id` is a v4 UUID, but the PK shape pins the
 * "rule belongs to a tenant" invariant in the schema).
 *
 * **Conditions / action are jsonb**, typed against B8's discriminated
 * unions via `$type<...>()`. The Drizzle column type is `unknown` at
 * runtime (jsonb is opaque to Postgres), but the `$type` annotation
 * gives us TS narrowing on reads/writes through the ORM. Validation
 * at write time is the API layer's job (call B8's `evaluateRule` with
 * a synthetic expenditure to trigger the validator).
 *
 * **`enabled`** defaults to `true` so rules are live the moment they
 * land. `enabled = false` is the soft-disable knob — DELETE on the API
 * sets this rather than removing the row, so audit history survives
 * (the route layer reflects the project.ts soft-delete convention).
 *
 * **`priority`** uses ascending semantics — LOWER number = HIGHER
 * priority. This matches the convention B8's engine sorts on, so rules
 * read out of the DB in priority order need only `ORDER BY priority ASC`.
 * The `(tenant_id, priority)` index is what the B10 apply-rules job will
 * use to scan a firm's rules in order without a sort.
 *
 * **CHECK constraints** are hand-authored in the migration (priority >= 0,
 * name non-empty + 200-char cap). Drizzle-kit can't reliably round-trip
 * CHECK constraints across regenerations, so we keep them out of the
 * schema model and inline them in the migration's DO-NOT-REGENERATE block.
 *
 * RLS-protected (migration hand-authors the policy):
 *   tenant_id = current_setting('app.current_tenant_id', true)::uuid
 *
 * Naming convention: camelCase TS / snake_case SQL (per T5/T6 chain).
 */
export const mappingRule = pgTable(
  'mapping_rule',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    id: uuid('id')
      .notNull()
      .$defaultFn(() => crypto.randomUUID()),
    name: text('name').notNull(),
    // Lower number = higher priority. Mirrors B8's engine sort order.
    priority: integer('priority').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    // jsonb arrays/objects shaped per B8. Empty conditions array is the
    // "match everything" catch-all (vacuous truth — see B8's README).
    conditions: jsonb('conditions').$type<readonly RuleCondition[]>().notNull(),
    action: jsonb('action').$type<RuleAction>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => user.id),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.id] }),
    // Powers the B10 apply-rules job's "scan rules in priority order".
    priorityIdx: index('mapping_rule_priority_idx').on(t.tenantId, t.priority),
  }),
);
