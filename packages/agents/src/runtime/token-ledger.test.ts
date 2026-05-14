/**
 * Unit tests for the per-claim LLM token ledger.
 *
 * Strategy: mock the postgres-js tag function so the tests run with no
 * DB. The mock records every SQL call (template + values) so we can
 * assert both the budget-decision logic AND the actual SQL the ledger
 * emits. Each test wires the mock to a fresh in-memory total so we can
 * exercise free-tier / threshold-straddle / over-quota independently.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BILLABLE_MARKUP,
  costAudCents,
  DEFAULT_CLAIM_BUDGET_AUD_CENTS,
  getClaimBudgetStatus,
  recordUsage,
  USD_TO_AUD,
  type TaggedSql,
} from './token-ledger.js';

// --- mock harness ------------------------------------------------------------

type SqlCall = { strings: readonly string[]; values: unknown[] };

interface MockSqlState {
  /** in-memory "ledger total" returned by the SELECT total query. */
  currentTotal: number;
  /** every SQL call the test made, in order. */
  calls: SqlCall[];
  /** count of INSERT statements seen. */
  insertCount: number;
  /** count of SELECT statements seen. */
  selectCount: number;
}

function makeMockSql(initialTotal: number): {
  sql: TaggedSql;
  state: MockSqlState;
} {
  const state: MockSqlState = {
    currentTotal: initialTotal,
    calls: [],
    insertCount: 0,
    selectCount: 0,
  };
  const sql: TaggedSql = <T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> => {
    state.calls.push({ strings: [...strings], values });
    const sqlText = strings.join('?');
    if (/SELECT[\s\S]+SUM\(cost_aud_cents\)/i.test(sqlText)) {
      state.selectCount += 1;
      const rows = [{ total: String(state.currentTotal), n: String(state.calls.length) }];
      return Promise.resolve(rows as unknown as T);
    }
    if (/INSERT\s+INTO\s+llm_token_usage/i.test(sqlText)) {
      state.insertCount += 1;
      // Pull cost_aud_cents from the values array — it's the 8th param
      // (0-indexed: 0 tenant, 1 claim, 2 subj, 3 agent, 4 model,
      // 5 tokens_in, 6 tokens_out, 7 cost_aud_cents, 8 status).
      const cost = values[7] as number;
      state.currentTotal += cost;
      return Promise.resolve(undefined as unknown as T);
    }
    return Promise.resolve(undefined as unknown as T);
  };
  return { sql, state };
}

// --- costAudCents ------------------------------------------------------------

test('costAudCents: haiku at 100/50 tokens -> ~0.014 AUD cents -> 0 rounded', () => {
  // 100 in * 0.25/Mtok + 50 out * 1.25/Mtok = $0.0000875 USD
  // -> 0.0000875 * 1.55 = $0.000135625 AUD -> 0.0135625 cents -> rounds to 0
  assert.equal(costAudCents('claude-haiku-4-5', 100, 50), 0);
});

test('costAudCents: sonnet at 10k/5k tokens (typical drafter slice) -> AUD cents', () => {
  // 10_000 in * 3/Mtok + 5_000 out * 15/Mtok = $0.105 USD
  // -> 0.105 * 1.55 = $0.16275 AUD -> 16.275 cents -> rounds to 16
  assert.equal(costAudCents('claude-sonnet-4-5', 10_000, 5_000), 16);
});

test('costAudCents: sonnet full drafter call (30k in / 25k out) ~ A$0.80', () => {
  // 30_000 * 3 + 25_000 * 15 = 90_000 + 375_000 = 465_000 millicents-USD
  // = $0.465 USD * 1.55 = $0.72075 AUD = 72.075 cents -> 72
  assert.equal(costAudCents('claude-sonnet-4-5', 30_000, 25_000), 72);
});

test('costAudCents: unknown model returns 0', () => {
  assert.equal(costAudCents('unknown-3', 1_000_000, 1_000_000), 0);
});

test('USD_TO_AUD constant is 1.55 (matches FY25/26 banding)', () => {
  assert.equal(USD_TO_AUD, 1.55);
});

test('BILLABLE_MARKUP constant is 1.5 (cost+50%)', () => {
  assert.equal(BILLABLE_MARKUP, 1.5);
});

test('DEFAULT_CLAIM_BUDGET_AUD_CENTS is 5000 (A$50)', () => {
  assert.equal(DEFAULT_CLAIM_BUDGET_AUD_CENTS, 5000);
});

// --- recordUsage: budget decision logic --------------------------------------

test('recordUsage: fresh claim (total=0) -> free_tier, base cost recorded', async () => {
  const { sql, state } = makeMockSql(0);
  const res = await recordUsage(sql, {
    tenant_id: 'T1',
    claim_id: 'C1',
    subject_tenant_id: 'S1',
    agent_name: 'document-analyzer',
    model: 'claude-sonnet-4-5',
    tokens_in: 10_000,
    tokens_out: 5_000,
  });
  assert.equal(res.status, 'free_tier');
  assert.equal(res.cost_aud_cents, 16); // matches costAudCents above
  assert.equal(res.claim_total_before_cents, 0);
  assert.equal(res.claim_total_after_cents, 16);
  assert.equal(res.remaining_aud_cents, 5000 - 16);
  assert.equal(state.selectCount, 1);
  assert.equal(state.insertCount, 1);
});

test('recordUsage: at threshold (total=4999) -> still free_tier on this call', async () => {
  const { sql, state } = makeMockSql(4999);
  const res = await recordUsage(sql, {
    tenant_id: 'T1',
    claim_id: 'C1',
    subject_tenant_id: 'S1',
    agent_name: 'application-drafter',
    model: 'claude-sonnet-4-5',
    tokens_in: 30_000,
    tokens_out: 25_000,
  });
  // totalBefore (4999) < budget (5000) -> free_tier, no markup
  assert.equal(res.status, 'free_tier');
  assert.equal(res.cost_aud_cents, 72); // base, not 72*1.5
  assert.equal(res.claim_total_before_cents, 4999);
  assert.equal(res.claim_total_after_cents, 4999 + 72);
  assert.ok(res.remaining_aud_cents < 0, 'should be negative after going over');
  assert.equal(state.insertCount, 1);
});

test('recordUsage: just over threshold (total=5000) -> billable, markup applied', async () => {
  const { sql } = makeMockSql(5000);
  const res = await recordUsage(sql, {
    tenant_id: 'T1',
    claim_id: 'C1',
    subject_tenant_id: 'S1',
    agent_name: 'application-drafter',
    model: 'claude-sonnet-4-5',
    tokens_in: 30_000,
    tokens_out: 25_000,
  });
  // totalBefore (5000) >= budget (5000) -> billable, cost *1.5
  assert.equal(res.status, 'billable');
  assert.equal(res.cost_aud_cents, Math.round(72 * 1.5)); // 108
  assert.equal(res.claim_total_before_cents, 5000);
  assert.equal(res.claim_total_after_cents, 5000 + 108);
});

test('recordUsage: well over threshold -> billable; markup applies to whole call', async () => {
  const { sql } = makeMockSql(10_000);
  const res = await recordUsage(sql, {
    tenant_id: 'T1',
    claim_id: 'C1',
    subject_tenant_id: 'S1',
    agent_name: 'insights-generator',
    model: 'claude-sonnet-4-5',
    tokens_in: 1_000,
    tokens_out: 500,
  });
  // 1000 * 3 + 500 * 15 = 10500 millicents-USD = $0.0105 USD = $0.016275 AUD = 1.6275 cents -> 2
  // * 1.5 = 3
  assert.equal(res.status, 'billable');
  assert.equal(res.cost_aud_cents, 3);
});

test('recordUsage: claim_id=null bypasses SELECT (tenant-wide; no budget check)', async () => {
  const { sql, state } = makeMockSql(0);
  const res = await recordUsage(sql, {
    tenant_id: 'T1',
    claim_id: null,
    subject_tenant_id: 'S1',
    agent_name: 'document-analyzer',
    model: 'claude-haiku-4-5',
    tokens_in: 1000,
    tokens_out: 500,
  });
  // No SELECT — claim_id is null. Status defaults to free_tier (totalBefore=0).
  assert.equal(state.selectCount, 0);
  assert.equal(state.insertCount, 1);
  assert.equal(res.status, 'free_tier');
  assert.equal(res.claim_total_before_cents, 0);
});

test('recordUsage: custom budget override propagates through decision', async () => {
  const { sql } = makeMockSql(200);
  const res = await recordUsage(
    sql,
    {
      tenant_id: 'T1',
      claim_id: 'C1',
      subject_tenant_id: 'S1',
      agent_name: 'a',
      model: 'claude-haiku-4-5',
      tokens_in: 100,
      tokens_out: 50,
    },
    { budget_aud_cents: 100 }, // tiny budget — already over
  );
  assert.equal(res.status, 'billable');
});

test('recordUsage: unknown model -> cost=0 -> row still recorded for forensics', async () => {
  const { sql, state } = makeMockSql(0);
  const res = await recordUsage(sql, {
    tenant_id: 'T1',
    claim_id: 'C1',
    subject_tenant_id: 'S1',
    agent_name: 'classifier',
    model: 'claude-opus-99-unreleased',
    tokens_in: 5000,
    tokens_out: 2000,
  });
  assert.equal(res.cost_aud_cents, 0);
  assert.equal(res.status, 'free_tier');
  assert.equal(state.insertCount, 1); // ROW STILL WRITTEN
});

test('recordUsage: ledger insert failure does not throw', async () => {
  const failSql: TaggedSql = <T>(strings: TemplateStringsArray): Promise<T> => {
    const sqlText = strings.join('?');
    if (/SELECT/i.test(sqlText)) {
      return Promise.resolve([{ total: '0' }] as unknown as T);
    }
    return Promise.reject(new Error('simulated DB error'));
  };

  const originalConsoleError = console.error;
  console.error = () => {}; // swallow expected log

  try {
    const res = await recordUsage(failSql, {
      tenant_id: 'T1',
      claim_id: 'C1',
      subject_tenant_id: 'S1',
      agent_name: 'a',
      model: 'claude-haiku-4-5',
      tokens_in: 1000,
      tokens_out: 500,
    });
    // Even though insert failed, the function returns the COMPUTED record.
    // Caller can still proceed; the missing row just means slight under-billing.
    assert.equal(res.status, 'free_tier');
    assert.ok(res.cost_aud_cents >= 0);
  } finally {
    console.error = originalConsoleError;
  }
});

test('recordUsage: SELECT and INSERT happen in correct order', async () => {
  const { sql, state } = makeMockSql(2000);
  await recordUsage(sql, {
    tenant_id: 'T1',
    claim_id: 'C1',
    subject_tenant_id: 'S1',
    agent_name: 'a',
    model: 'claude-haiku-4-5',
    tokens_in: 1000,
    tokens_out: 500,
  });
  // 2 calls total. Call 0 = SELECT, call 1 = INSERT.
  assert.equal(state.calls.length, 2);
  const firstSql = state.calls[0]!.strings.join('?');
  const secondSql = state.calls[1]!.strings.join('?');
  assert.match(firstSql, /SELECT/i);
  assert.match(secondSql, /INSERT/i);
});

test('recordUsage: parameter order in INSERT matches the column order in SQL', async () => {
  const { sql, state } = makeMockSql(0);
  await recordUsage(sql, {
    tenant_id: 'T-tenant',
    claim_id: 'C-claim',
    subject_tenant_id: 'S-subj',
    agent_name: 'NAME',
    model: 'claude-sonnet-4-5',
    tokens_in: 111,
    tokens_out: 222,
  });
  const insertCall = state.calls[1]!;
  assert.deepEqual(insertCall.values.slice(0, 7), [
    'T-tenant',
    'C-claim',
    'S-subj',
    'NAME',
    'claude-sonnet-4-5',
    111,
    222,
  ]);
});

// --- getClaimBudgetStatus ----------------------------------------------------

test('getClaimBudgetStatus: under budget -> status=free_tier', async () => {
  const sql: TaggedSql = <T>(): Promise<T> => {
    return Promise.resolve([{ total: '1234', n: '5' }] as unknown as T);
  };
  const status = await getClaimBudgetStatus(sql, 'C1');
  assert.equal(status.used_aud_cents, 1234);
  assert.equal(status.remaining_aud_cents, 5000 - 1234);
  assert.equal(status.budget_aud_cents, 5000);
  assert.equal(status.status, 'free_tier');
  assert.equal(status.call_count, 5);
});

test('getClaimBudgetStatus: exactly at budget -> status=over_quota', async () => {
  const sql: TaggedSql = <T>(): Promise<T> => {
    return Promise.resolve([{ total: '5000', n: '12' }] as unknown as T);
  };
  const status = await getClaimBudgetStatus(sql, 'C1');
  assert.equal(status.used_aud_cents, 5000);
  assert.equal(status.remaining_aud_cents, 0);
  assert.equal(status.status, 'over_quota');
});

test('getClaimBudgetStatus: well over budget -> status=over_quota, negative remaining', async () => {
  const sql: TaggedSql = <T>(): Promise<T> => {
    return Promise.resolve([{ total: '8000', n: '40' }] as unknown as T);
  };
  const status = await getClaimBudgetStatus(sql, 'C1');
  assert.equal(status.used_aud_cents, 8000);
  assert.equal(status.remaining_aud_cents, -3000);
  assert.equal(status.status, 'over_quota');
});

test('getClaimBudgetStatus: empty ledger -> 0 used, full remaining', async () => {
  const sql: TaggedSql = <T>(): Promise<T> => {
    return Promise.resolve([{ total: '0', n: '0' }] as unknown as T);
  };
  const status = await getClaimBudgetStatus(sql, 'C1');
  assert.equal(status.used_aud_cents, 0);
  assert.equal(status.remaining_aud_cents, 5000);
  assert.equal(status.call_count, 0);
});

test('getClaimBudgetStatus: custom budget overrides the default', async () => {
  const sql: TaggedSql = <T>(): Promise<T> => {
    return Promise.resolve([{ total: '300', n: '2' }] as unknown as T);
  };
  const status = await getClaimBudgetStatus(sql, 'C1', 1000);
  assert.equal(status.budget_aud_cents, 1000);
  assert.equal(status.remaining_aud_cents, 700);
});

// --- threshold-straddle invariant -------------------------------------------

test('threshold-straddle: 4500 cents used, A$50 budget, big drafter call -> free_tier', async () => {
  // A typical drafter call (~A$0.78) lands a claim near A$5.23 used, NOT
  // 4500 + 78 -> 4578 still under. Test that the "WHOLE call is free if
  // we started under" property holds even when the call crosses the line.
  const { sql } = makeMockSql(4500);
  const res = await recordUsage(sql, {
    tenant_id: 'T1',
    claim_id: 'C1',
    subject_tenant_id: 'S1',
    agent_name: 'application-drafter',
    model: 'claude-sonnet-4-5',
    tokens_in: 30_000,
    tokens_out: 25_000,
  });
  // 4500 < 5000 -> free_tier, base 72 cents (not 72*1.5)
  assert.equal(res.status, 'free_tier');
  assert.equal(res.cost_aud_cents, 72);
  // After this call: 4572 still under budget; remaining 428.
  assert.equal(res.claim_total_after_cents, 4572);
  assert.equal(res.remaining_aud_cents, 428);
});

test('threshold-straddle: 4500 cents used, two drafter calls in sequence', async () => {
  // First call lands free at 4500+72=4572. Second call starts at 4572 < 5000
  // so STILL free_tier (the whole-call rule means we don't split). Only the
  // THIRD call (starting at 4572+72=4644 < 5000) would be the same again.
  // The 70th call eventually pushes over.
  const { sql, state } = makeMockSql(4500);

  const r1 = await recordUsage(sql, {
    tenant_id: 'T1',
    claim_id: 'C1',
    subject_tenant_id: 'S1',
    agent_name: 'a',
    model: 'claude-sonnet-4-5',
    tokens_in: 30_000,
    tokens_out: 25_000,
  });
  assert.equal(r1.status, 'free_tier');
  assert.equal(state.currentTotal, 4572);

  const r2 = await recordUsage(sql, {
    tenant_id: 'T1',
    claim_id: 'C1',
    subject_tenant_id: 'S1',
    agent_name: 'a',
    model: 'claude-sonnet-4-5',
    tokens_in: 30_000,
    tokens_out: 25_000,
  });
  // Started at 4572 < 5000 -> still free_tier
  assert.equal(r2.status, 'free_tier');
  assert.equal(r2.claim_total_before_cents, 4572);
  // After this call: 4644 still under budget; one more call still free.
});

test('threshold-straddle: many small calls eventually flip status to billable', async () => {
  const { sql, state } = makeMockSql(0);
  let firstBillableAt: number | null = null;
  for (let i = 0; i < 100; i += 1) {
    const r = await recordUsage(sql, {
      tenant_id: 'T1',
      claim_id: 'C1',
      subject_tenant_id: 'S1',
      agent_name: 'a',
      model: 'claude-sonnet-4-5',
      tokens_in: 30_000,
      tokens_out: 25_000,
    });
    if (r.status === 'billable' && firstBillableAt === null) {
      firstBillableAt = i;
      break;
    }
  }
  // Each call is 72 cents free. 5000/72 ≈ 69.4. So call 70 (i=69)
  // STARTS at 70*72=5040 which is >=5000 -> first billable.
  assert.ok(firstBillableAt !== null, 'should eventually flip to billable');
  assert.ok(firstBillableAt >= 69 && firstBillableAt <= 71, `expected ~70, got ${firstBillableAt}`);
  assert.equal(state.calls.length, (firstBillableAt + 1) * 2); // SELECT + INSERT per call
});
