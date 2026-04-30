import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  listMappingRulesQuery,
  type MappingRule,
  type RuleAction,
  type RuleCondition,
} from './mapping-rule.js';

// ---------------------------------------------------------------------------
// listMappingRulesQuery.enabled — pinned contract.
//
// The previous implementation used `z.coerce.boolean()`, which calls
// `Boolean(value)` and returns `true` for ANY non-empty string,
// including the literal `'false'`. That meant `?enabled=false` was
// silently rewritten to `enabled=true` and the route filtered for the
// opposite of what the user asked for. These four tests pin the
// value-aware transformer to the only two valid wire values.
// ---------------------------------------------------------------------------

test('listMappingRulesQuery enabled: "false" parses to false', () => {
  const parsed = listMappingRulesQuery.parse({ enabled: 'false' });
  assert.equal(parsed.enabled, false);
});

test('listMappingRulesQuery enabled: "true" parses to true', () => {
  const parsed = listMappingRulesQuery.parse({ enabled: 'true' });
  assert.equal(parsed.enabled, true);
});

test('listMappingRulesQuery enabled: omitted is undefined', () => {
  const parsed = listMappingRulesQuery.parse({});
  assert.equal(parsed.enabled, undefined);
});

test('listMappingRulesQuery enabled: "yes" rejects', () => {
  assert.throws(() => listMappingRulesQuery.parse({ enabled: 'yes' }));
});

// ---------------------------------------------------------------------------
// Canonical type exports (Task 3.1).
//
// MappingRule / RuleCondition / RuleAction are the canonical TypeScript
// types for the mapping rules engine. They live here (the leaf @cpa/schemas
// package) so both @cpa/db (drizzle column annotations) and
// @cpa/integrations (B8's runtime engine) can import them without the
// db -> integrations cycle that drove their previous home in the
// integrations package. See packages/db/README.md for the constraint.
//
// The asserts below are runtime spot-checks that the exports satisfy
// their structural contract. The compile-time guarantee (that these are
// the same shapes B8's engine evaluates) is provided by the identity
// assertion in apps/api/src/routes/mapping-rules.ts.
// ---------------------------------------------------------------------------

test('canonical types: RuleCondition shape accepts representative literal', () => {
  const condition: RuleCondition = {
    field: 'amount',
    op: 'between',
    value: [0, 100],
  };
  assert.equal(condition.field, 'amount');
});

test('canonical types: RuleAction shape accepts representative literal', () => {
  const action: RuleAction = {
    type: 'flag_for_review',
    reason: 'manual review required',
  };
  assert.equal(action.type, 'flag_for_review');
});

test('canonical types: MappingRule shape accepts representative literal', () => {
  const rule: MappingRule = {
    id: '00000000-0000-0000-0000-000000000001',
    tenant_id: '00000000-0000-0000-0000-000000000002',
    name: 'rule-1',
    priority: 10,
    enabled: true,
    conditions: [],
    action: { type: 'flag_for_review', reason: 'noop' },
  };
  assert.equal(rule.priority, 10);
});
