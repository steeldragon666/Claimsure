import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCORING_RULES, TOTAL_MAX_PTS } from './rules.js';
import type { ScoreRule, SqlClient } from './types.js';

const TENANT = '00000000-0000-4000-8000-0000000d0001';
const SUBJECT = '00000000-0000-4000-8000-0000000d0011';

/**
 * Build a postgres-js-style mock that returns a single scripted result row.
 * The rules each issue exactly one query, so a constant response per rule
 * is sufficient. The mock ignores the template strings + interpolations —
 * the SQL is exercised end-to-end against a real DB by the apps/api recompute
 * job tests in D3.
 *
 * The cast through `unknown` is required: `SqlClient` is generic over `Row`,
 * but the mock fixes one row shape. TS's structural-checker accepts the
 * concrete function shape only after the unknown-bridge — direct
 * `as SqlClient` would surface as a typing mismatch the eslint
 * "unnecessary assertion" rule flags inconsistently.
 */
function mockSql<Row>(row: Row): SqlClient {
  const fn = (..._args: unknown[]): Promise<Row[]> => Promise.resolve([row]);
  return fn as unknown as SqlClient;
}

/** Mock that returns no rows (covers "rule queried, no data" branches). */
function emptyMockSql(): SqlClient {
  const fn = (..._args: unknown[]): Promise<unknown[]> => Promise.resolve([]);
  return fn as unknown as SqlClient;
}

const ruleById = (id: string): ScoreRule => {
  const rule = SCORING_RULES.find((r) => r.id === id);
  if (!rule) throw new Error(`unknown rule: ${id}`);
  return rule;
};

test('rules: SCORING_RULES sums to 100 (TOTAL_MAX_PTS)', () => {
  assert.equal(TOTAL_MAX_PTS, 100);
  const sum = SCORING_RULES.reduce((s, r) => s + r.max_pts, 0);
  assert.equal(sum, 100);
});

test('rules: every rule has a unique id', () => {
  const ids = SCORING_RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('has_recent_capture: 0 events → 0 pts', async () => {
  const rule = ruleById('has_recent_capture');
  const result = await rule.fn({
    tenant_id: TENANT,
    subject_tenant_id: SUBJECT,
    sql_client: mockSql({ n: 0 }),
  });
  assert.equal(result.earned, 0);
  assert.match(result.details ?? '', /0 events/);
});

test('has_recent_capture: 5 events → 10 pts', async () => {
  const rule = ruleById('has_recent_capture');
  const result = await rule.fn({
    tenant_id: TENANT,
    subject_tenant_id: SUBJECT,
    sql_client: mockSql({ n: 5 }),
  });
  assert.equal(result.earned, 10);
});

test('hypothesis_per_core: 0 → 0 pts, 1 → 5, 3 → 15, 5 → 15 (capped)', async () => {
  const rule = ruleById('hypothesis_per_core');
  for (const [n, expected] of [
    [0, 0],
    [1, 5],
    [2, 10],
    [3, 15],
    [5, 15],
  ] as const) {
    const result = await rule.fn({
      tenant_id: TENANT,
      subject_tenant_id: SUBJECT,
      sql_client: mockSql({ n }),
    });
    assert.equal(result.earned, expected, `n=${n}: expected ${expected}, got ${result.earned}`);
  }
});

test('no_30day_gap: max_gap < 30 → 10 pts; ≥ 30 → 0 pts', async () => {
  const rule = ruleById('no_30day_gap');
  const ok = await rule.fn({
    tenant_id: TENANT,
    subject_tenant_id: SUBJECT,
    sql_client: mockSql({ max_gap: 12 }),
  });
  assert.equal(ok.earned, 10);

  const bad = await rule.fn({
    tenant_id: TENANT,
    subject_tenant_id: SUBJECT,
    sql_client: mockSql({ max_gap: 45 }),
  });
  assert.equal(bad.earned, 0);
});

test('no_30day_gap: NULL max_gap (single event) → 10 pts (treated as 0 days)', async () => {
  const rule = ruleById('no_30day_gap');
  const result = await rule.fn({
    tenant_id: TENANT,
    subject_tenant_id: SUBJECT,
    sql_client: mockSql({ max_gap: null }),
  });
  assert.equal(result.earned, 10);
  assert.match(result.details ?? '', /max gap 0/);
});

test('every_event_has_artefact: 0 events → 0 pts; 5/10 → 8 pts; 10/10 → 15 pts', async () => {
  const rule = ruleById('every_event_has_artefact');
  const empty = await rule.fn({
    tenant_id: TENANT,
    subject_tenant_id: SUBJECT,
    sql_client: mockSql({ total: 0, with_artefact: 0 }),
  });
  assert.equal(empty.earned, 0);
  assert.match(empty.details ?? '', /no events/);

  const partial = await rule.fn({
    tenant_id: TENANT,
    subject_tenant_id: SUBJECT,
    sql_client: mockSql({ total: 10, with_artefact: 5 }),
  });
  // Math.round(0.5 * 15) = 8.
  assert.equal(partial.earned, 8);

  const full = await rule.fn({
    tenant_id: TENANT,
    subject_tenant_id: SUBJECT,
    sql_client: mockSql({ total: 10, with_artefact: 10 }),
  });
  assert.equal(full.earned, 15);
});

test('time_tracking_active: payroll integration → 10; manual only → 5; nothing → 0', async () => {
  const rule = ruleById('time_tracking_active');
  const payroll = await rule.fn({
    tenant_id: TENANT,
    subject_tenant_id: SUBJECT,
    sql_client: mockSql({ active_payroll: 1, recent_entries: 0 }),
  });
  assert.equal(payroll.earned, 10);

  const manual = await rule.fn({
    tenant_id: TENANT,
    subject_tenant_id: SUBJECT,
    sql_client: mockSql({ active_payroll: 0, recent_entries: 4 }),
  });
  assert.equal(manual.earned, 5);

  const nothing = await rule.fn({
    tenant_id: TENANT,
    subject_tenant_id: SUBJECT,
    sql_client: mockSql({ active_payroll: 0, recent_entries: 0 }),
  });
  assert.equal(nothing.earned, 0);
});

test('apportionment_complete: 0/0 → 0; 5/10 → 5 pts; 10/10 → 10 pts', async () => {
  const rule = ruleById('apportionment_complete');
  const empty = await rule.fn({
    tenant_id: TENANT,
    subject_tenant_id: SUBJECT,
    sql_client: mockSql({ total: 0, apportioned: 0 }),
  });
  assert.equal(empty.earned, 0);

  const half = await rule.fn({
    tenant_id: TENANT,
    subject_tenant_id: SUBJECT,
    sql_client: mockSql({ total: 10, apportioned: 5 }),
  });
  assert.equal(half.earned, 5);

  const full = await rule.fn({
    tenant_id: TENANT,
    subject_tenant_id: SUBJECT,
    sql_client: mockSql({ total: 10, apportioned: 10 }),
  });
  assert.equal(full.earned, 10);
});

test('engagement_letter_signed: 0 → 0; 1+ → 10', async () => {
  const rule = ruleById('engagement_letter_signed');
  const none = await rule.fn({
    tenant_id: TENANT,
    subject_tenant_id: SUBJECT,
    sql_client: mockSql({ n: 0 }),
  });
  assert.equal(none.earned, 0);
  assert.equal(none.details, 'not signed');

  const signed = await rule.fn({
    tenant_id: TENANT,
    subject_tenant_id: SUBJECT,
    sql_client: mockSql({ n: 1 }),
  });
  assert.equal(signed.earned, 10);
  assert.equal(signed.details, 'signed');
});

test('classifier_avg_confidence: avg 0.85 → 9 pts; 1.0 → 10; null → 0', async () => {
  const rule = ruleById('classifier_avg_confidence');
  const high = await rule.fn({
    tenant_id: TENANT,
    subject_tenant_id: SUBJECT,
    sql_client: mockSql({ avg_conf: 0.85 }),
  });
  // Math.round(0.85 * 10) = 9.
  assert.equal(high.earned, 9);

  const perfect = await rule.fn({
    tenant_id: TENANT,
    subject_tenant_id: SUBJECT,
    sql_client: mockSql({ avg_conf: 1.0 }),
  });
  assert.equal(perfect.earned, 10);

  const empty = await rule.fn({
    tenant_id: TENANT,
    subject_tenant_id: SUBJECT,
    sql_client: mockSql({ avg_conf: null }),
  });
  assert.equal(empty.earned, 0);
});

test('override_rate_low: 0/0 → 0 (no signal); rate < 30% → 5; ≥ 30% → 0', async () => {
  const rule = ruleById('override_rate_low');
  const empty = await rule.fn({
    tenant_id: TENANT,
    subject_tenant_id: SUBJECT,
    sql_client: mockSql({ overrides: 0, non_overrides: 0 }),
  });
  assert.equal(empty.earned, 0);

  const low = await rule.fn({
    tenant_id: TENANT,
    subject_tenant_id: SUBJECT,
    sql_client: mockSql({ overrides: 1, non_overrides: 10 }),
  });
  assert.equal(low.earned, 5);

  const high = await rule.fn({
    tenant_id: TENANT,
    subject_tenant_id: SUBJECT,
    sql_client: mockSql({ overrides: 5, non_overrides: 10 }),
  });
  assert.equal(high.earned, 0);
});

test('evidence_kinds_diverse: 0 → 0; 2 → 2 pts; 4+ → 5 pts (capped)', async () => {
  const rule = ruleById('evidence_kinds_diverse');
  for (const [n, expected] of [
    [0, 0],
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 5],
    [10, 5],
  ] as const) {
    const result = await rule.fn({
      tenant_id: TENANT,
      subject_tenant_id: SUBJECT,
      sql_client: mockSql({ n }),
    });
    assert.equal(result.earned, expected, `n=${n}: expected ${expected}, got ${result.earned}`);
  }
});

test('rules: empty result-set defends every rule (no [0]?.x crash)', async () => {
  // Each rule must tolerate the SQL returning [] without throwing — we hit
  // this in production if a transient connection issue rolls back inside
  // the query. The fallback should return earned: 0 (no signal).
  for (const rule of SCORING_RULES) {
    const result = await rule.fn({
      tenant_id: TENANT,
      subject_tenant_id: SUBJECT,
      sql_client: emptyMockSql(),
    });
    assert.ok(typeof result.earned === 'number', `${rule.id}: earned must be a number`);
    assert.ok(result.earned >= 0, `${rule.id}: earned must be ≥ 0`);
    assert.ok(
      result.earned <= rule.max_pts,
      `${rule.id}: earned ${result.earned} > max_pts ${rule.max_pts}`,
    );
  }
});
