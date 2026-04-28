import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import nock from 'nock';
import {
  syncReceipts,
  type SqlClient,
  type ChainInserter,
  type SyncReceiptsConnection,
} from './sync-receipts.js';

/**
 * B4 sync-receipts tests.
 *
 * Approach: pure-function-style tests with mocked DB, mirroring B2/B3.
 * The real DB tests (insert chain extension, RLS) are exercised in CI
 * via the @cpa/db integration suite — Docker isn't running on the
 * Windows author workstation, and pure-function tests give faster
 * feedback regardless.
 *
 * The SQL stub mirrors the postgres-js template-tag interface (see the
 * sibling `sync-bank-tx.test.ts` for the same pattern). Each call
 * captures the joined SQL string + parameter list, plus an optional
 * row-set the test pre-loads to simulate SELECT/RETURNING results.
 *
 * Beyond the standard 13 scenarios from B2/B3, B4 adds three
 * reimbursee-mapping tests covering email-match, no-match, and
 * cross-tenant safety. The reimbursee resolver joins through
 * tenant_user, so the lookup is firm-scoped — a user with the same
 * email in a different firm will NOT match.
 */

const TENANT_ID = '00000000-0000-4000-8000-0000000000a1';
const SUBJECT_TENANT_ID = '00000000-0000-4000-8000-0000000000a2';
const CONNECTION_ID = '00000000-0000-4000-8000-0000000000a3';
const XERO_TENANT_ID = '11111111-2222-3333-4444-555555555555';

const XERO_API_HOST = 'https://api.xero.com';
const XERO_API_PATH = '/api.xro/2.0';

// Resolve the fixture file relative to this test (tests/fixtures/...
// at the repo root). __dirname is unavailable in ESM so derive from
// import.meta.url.
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(
  here,
  '../../../../tests/fixtures/xero-accounting/receipts-sample.json',
);
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as {
  Receipts: Array<{
    ReceiptID: string;
    Status: string;
    LineItems: unknown[];
    User?: { Email?: string };
  }>;
};

// Sanity: the fixture has the shape the suite assumes.
const FIXTURE_AUTHORISED = FIXTURE.Receipts.filter((r) => r.Status === 'AUTHORISED');
const FIXTURE_DRAFT = FIXTURE.Receipts.filter((r) => r.Status === 'DRAFT');
assert.equal(FIXTURE_AUTHORISED.length, 3, 'fixture must have exactly 3 AUTHORISED receipts');
assert.equal(FIXTURE_DRAFT.length, 1, 'fixture must have exactly 1 DRAFT receipt');

/**
 * Stable, deterministic UUID-v4-shaped ids for test fixtures. The
 * EXPENDITURE_INGESTED payload is now Zod-parsed at the boundary
 * (B2 follow-up — A1 fix #5 pattern), and `Uuid` rejects anything
 * that isn't a v4. The third group must start with `4`, the fourth
 * with `8|9|a|b`. Pad-from-the-end so `expUuid(0)` and `expUuid(99)`
 * both yield distinct, valid UUIDs.
 */
function expUuid(i: number): string {
  return `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
}

// -- SQL stub --------------------------------------------------------------
//
// Each call to `sql` is captured. The stub is "smart": it returns rows
// only for read-shaped queries (SELECT * / INSERT ... RETURNING). Per-row
// FIFO queues are scoped by call kind:
//   - `reimbursee`: returns the next pre-queued row-set on a
//     `SELECT u.id FROM "user" u JOIN tenant_user ...` query.
//   - `existing`: returns the next pre-queued row-set on a
//     `SELECT id FROM expenditure WHERE ...` query.
//   - `subjectTenant`: returns the next pre-queued row-set on a
//     `SELECT id FROM subject_tenant ...` query.
//   - `inserted`: returns the next pre-queued row-set on an
//     `INSERT INTO expenditure ... RETURNING` query.
// All other queries (UPDATE, DELETE, INSERT line) return `[]` and don't
// consume any queue. This keeps the test scaffolding simple — tests
// pre-load only the values that *matter* for the path they exercise.

type CapturedQuery = { sql: string; params: unknown[] };

interface SqlStub {
  sql: SqlClient;
  queries: CapturedQuery[];
  /** Queue a SELECT reimbursee row-set (FIFO across receipts). */
  enqueueReimbursee: (rows: Array<{ id: string }>) => void;
  /** Queue a SELECT-existing-expenditure row-set (FIFO across receipts). */
  enqueueExisting: (rows: Array<{ id: string }>) => void;
  /** Queue a SELECT subject_tenant row-set. */
  enqueueSubjectTenant: (rows: Array<{ id: string }>) => void;
  /** Queue an INSERT...RETURNING row-set for the new expenditure. */
  enqueueInsertedExpenditure: (rows: Array<{ id: string }>) => void;
}

function makeSqlStub(): SqlStub {
  const queries: CapturedQuery[] = [];
  const reimburseeQ: Array<Array<{ id: string }>> = [];
  const existingQ: Array<Array<{ id: string }>> = [];
  const subjectQ: Array<Array<{ id: string }>> = [];
  const insertedQ: Array<Array<{ id: string }>> = [];
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const sqlText = strings.join('?');
    queries.push({ sql: sqlText, params: values });
    if (sqlText.includes('JOIN tenant_user')) {
      return Promise.resolve(reimburseeQ.shift() ?? []);
    }
    if (sqlText.includes('SELECT id FROM expenditure')) {
      return Promise.resolve(existingQ.shift() ?? []);
    }
    if (sqlText.includes('SELECT id FROM subject_tenant')) {
      return Promise.resolve(subjectQ.shift() ?? []);
    }
    if (sqlText.includes('INSERT INTO expenditure (') && sqlText.includes('RETURNING id')) {
      return Promise.resolve(insertedQ.shift() ?? []);
    }
    return Promise.resolve([]);
  }) as unknown as SqlClient;
  return {
    sql: fn,
    queries,
    enqueueReimbursee: (rows) => {
      reimburseeQ.push(rows);
    },
    enqueueExisting: (rows) => {
      existingQ.push(rows);
    },
    enqueueSubjectTenant: (rows) => {
      subjectQ.push(rows);
    },
    enqueueInsertedExpenditure: (rows) => {
      insertedQ.push(rows);
    },
  };
}

// -- chain stub ------------------------------------------------------------

interface ChainStub {
  insert: ChainInserter;
  calls: Array<{
    tenant_id: string;
    subject_tenant_id: string;
    kind: string;
    payload: unknown;
    captured_by_user_id: string | null;
  }>;
}

function makeChainStub(): ChainStub {
  const calls: ChainStub['calls'] = [];
  // Function returns a Promise but performs no async work — wrapped via
  // Promise.resolve to satisfy the lint rule and the ChainInserter type.
  const insert = ((input: Parameters<ChainInserter>[0]) => {
    calls.push({
      tenant_id: input.tenant_id,
      subject_tenant_id: input.subject_tenant_id,
      kind: input.kind,
      payload: input.payload,
      captured_by_user_id: input.captured_by_user_id,
    });
    return Promise.resolve({
      id: '00000000-0000-4000-8000-eeeeeeeeeeee',
      prev_hash: null,
      hash: 'fakehash',
    });
  }) as ChainInserter;
  return { insert, calls };
}

const conn = (): SyncReceiptsConnection => ({
  id: CONNECTION_ID,
  tenant_id: TENANT_ID,
  xero_tenant_id: XERO_TENANT_ID,
  access_token: 'fake-access-token',
});

/**
 * Pre-load row-sets for an INSERT-path receipt with NO reimbursee match.
 * The sync function:
 *   1. SELECTs reimbursee (user JOIN tenant_user) — return [] for no match.
 *   2. SELECTs `expenditure` by (tenant, source, source_external_id)
 *      — when treating as NEW, return [].
 *   3. SELECTs `subject_tenant` by tenant_id — return [{ id }].
 *   4. INSERTs into expenditure RETURNING id — return [{ id }].
 */
function queueNewReceiptRowsNoReimbursee(stub: SqlStub, expenditureId: string): void {
  stub.enqueueReimbursee([]); // 1. SELECT reimbursee → no match.
  stub.enqueueExisting([]); // 2. SELECT existing expenditure → empty.
  stub.enqueueSubjectTenant([{ id: SUBJECT_TENANT_ID }]); // 3. SELECT subject_tenant.
  stub.enqueueInsertedExpenditure([{ id: expenditureId }]); // 4. INSERT RETURNING id.
}

/**
 * Pre-load row-sets for an INSERT-path receipt WITH a reimbursee match.
 */
function queueNewReceiptRowsWithReimbursee(
  stub: SqlStub,
  expenditureId: string,
  userId: string,
): void {
  stub.enqueueReimbursee([{ id: userId }]); // 1. SELECT reimbursee → match.
  stub.enqueueExisting([]);
  stub.enqueueSubjectTenant([{ id: SUBJECT_TENANT_ID }]);
  stub.enqueueInsertedExpenditure([{ id: expenditureId }]);
}

function queueExistingReceiptRows(stub: SqlStub, expenditureId: string): void {
  // SELECT reimbursee → no match (test default — UPDATE path tests
  // override when needed).
  stub.enqueueReimbursee([]);
  // SELECT existing expenditure → match (UPDATE path; no INSERT/no
  // subject_tenant lookup needed).
  stub.enqueueExisting([{ id: expenditureId }]);
}

beforeEach(() => {
  nock.cleanAll();
});

after(() => {
  nock.cleanAll();
});

// -------------------------------------------------------------------------
// 1. Backfill mode: paginated fetch (mock 2 pages), all AUTHORISED rows mapped.
// -------------------------------------------------------------------------

test('backfill: paginates until short page; all AUTHORISED rows persisted', async () => {
  // Page 1: 100 AUTHORISED rows → triggers page=2 follow-up.
  const page1Receipts = Array.from({ length: 100 }, (_, i) => ({
    ReceiptID: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    Status: 'AUTHORISED',
    Date: '/Date(1640995200000+0000)/',
    Contact: { Name: `Vendor ${i}` },
    User: { UserID: `xero-user-${i}`, Email: `submitter-${i}@example.com` },
    Reference: `RCT-${i}`,
    CurrencyCode: 'AUD',
    Total: '100.00',
    LineItems: [
      { LineItemID: `line-${i}`, Description: 'Item', LineAmount: '100.00', AccountCode: '400' },
    ],
  }));

  // Page 2: short page (< 100), terminates.
  const page2Receipts = FIXTURE_AUTHORISED;

  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Receipts`)
    .query({ where: 'Status=="AUTHORISED"', page: '1', pageSize: '100' })
    .reply(200, { Receipts: page1Receipts });

  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Receipts`)
    .query({ where: 'Status=="AUTHORISED"', page: '2', pageSize: '100' })
    .reply(200, { Receipts: page2Receipts });

  const sqlStub = makeSqlStub();
  const chainStub = makeChainStub();
  // 100 page-1 + 3 page-2 = 103 AUTHORISED rows; all new, no reimbursee match.
  for (let i = 0; i < 100; i++) {
    queueNewReceiptRowsNoReimbursee(sqlStub, expUuid(i));
  }
  for (let i = 0; i < 3; i++) {
    queueNewReceiptRowsNoReimbursee(sqlStub, expUuid(100 + i));
  }

  const result = await syncReceipts(conn(), {
    mode: 'backfill',
    sql_client: sqlStub.sql,
    chain_insert: chainStub.insert,
  });

  assert.equal(result.fetched, 103);
  assert.equal(result.inserted, 103);
  assert.equal(result.updated, 0);
  // page1: 100 receipts × 1 line. page2: Cab Co 1 + Catering 1 + Office 2 = 4 lines.
  assert.equal(result.lines, 100 + 4);
  assert.equal(result.events_written, 103);
  assert.equal(chainStub.calls.length, 103);
  assert.ok(chainStub.calls.every((c) => c.kind === 'EXPENDITURE_INGESTED'));
});

// -------------------------------------------------------------------------
// 2. Incremental mode: If-Modified-Since header set correctly.
// -------------------------------------------------------------------------

test('incremental: sets If-Modified-Since header and forwards `since` correctly', async () => {
  let capturedIfModified: string | undefined;
  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Receipts`)
    .matchHeader('if-modified-since', (val: string | string[]) => {
      capturedIfModified = Array.isArray(val) ? val[0] : val;
      return true;
    })
    .query({ where: 'Status=="AUTHORISED"', page: '1', pageSize: '100' })
    .reply(200, { Receipts: FIXTURE_AUTHORISED });

  const sqlStub = makeSqlStub();
  for (let i = 0; i < FIXTURE_AUTHORISED.length; i++) {
    queueNewReceiptRowsNoReimbursee(sqlStub, expUuid(i));
  }
  const chainStub = makeChainStub();

  const since = new Date('2026-04-20T00:00:00Z');
  const result = await syncReceipts(conn(), {
    mode: 'incremental',
    since,
    sql_client: sqlStub.sql,
    chain_insert: chainStub.insert,
  });

  assert.equal(capturedIfModified, since.toUTCString());
  assert.equal(result.fetched, 3);
  assert.equal(result.inserted, 3);
});

test('incremental: throws if `since` is missing', async () => {
  const sqlStub = makeSqlStub();
  const chainStub = makeChainStub();
  await assert.rejects(
    syncReceipts(conn(), {
      mode: 'incremental',
      sql_client: sqlStub.sql,
      chain_insert: chainStub.insert,
    }),
    /requires `since`/,
  );
});

// -------------------------------------------------------------------------
// 3. Non-AUTHORISED rows filtered out — neither persisted nor counted.
// -------------------------------------------------------------------------

test('non-AUTHORISED rows are filtered out (defensive guard) — only AUTHORISED persisted', async () => {
  // Even if the API filter ever drops, the local
  // `r.Status !== 'AUTHORISED'` guard keeps DRAFT receipts out of
  // expenditure. This test sends the FULL fixture (incl. the DRAFT row)
  // and asserts only 3 are persisted.
  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Receipts`)
    .query({ where: 'Status=="AUTHORISED"', page: '1', pageSize: '100' })
    .reply(200, { Receipts: FIXTURE.Receipts });

  const sqlStub = makeSqlStub();
  for (let i = 0; i < 3; i++) {
    queueNewReceiptRowsNoReimbursee(sqlStub, expUuid(i));
  }
  const chainStub = makeChainStub();

  const result = await syncReceipts(conn(), {
    mode: 'backfill',
    sql_client: sqlStub.sql,
    chain_insert: chainStub.insert,
  });

  assert.equal(result.fetched, 3, 'DRAFT must not count toward fetched');
  assert.equal(result.inserted, 3);
  assert.equal(result.events_written, 3);
  // No EXPENDITURE_INGESTED for the DRAFT row.
  assert.ok(
    chainStub.calls.every((c) => {
      const p = c.payload as { vendor_name: string };
      return p.vendor_name !== 'Pending Coffee';
    }),
    'DRAFT receipt vendor must not appear in any event payload',
  );
});

// -------------------------------------------------------------------------
// 4. Idempotency: re-syncing matches existing rows → 0 new events.
// -------------------------------------------------------------------------

test('idempotency: existing rows UPDATE without writing EXPENDITURE_INGESTED', async () => {
  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Receipts`)
    .query({ where: 'Status=="AUTHORISED"', page: '1', pageSize: '100' })
    .reply(200, { Receipts: FIXTURE_AUTHORISED });

  const sqlStub = makeSqlStub();
  // Pre-queue: each receipt's reimbursee → no match, then existing → match
  // (UPDATE path).
  for (let i = 0; i < 3; i++) {
    queueExistingReceiptRows(sqlStub, `existing-exp-${i}`);
  }
  const chainStub = makeChainStub();

  const result = await syncReceipts(conn(), {
    mode: 'backfill',
    sql_client: sqlStub.sql,
    chain_insert: chainStub.insert,
  });

  assert.equal(result.fetched, 3);
  assert.equal(result.inserted, 0, 'no new inserts on re-sync');
  assert.equal(result.updated, 3, '3 UPDATEs');
  assert.equal(result.events_written, 0, 'no chain events on re-sync');
  assert.equal(chainStub.calls.length, 0);

  const updates = sqlStub.queries.filter((q) => q.sql.includes('UPDATE expenditure'));
  assert.equal(updates.length, 3);
  const deletes = sqlStub.queries.filter((q) => q.sql.includes('DELETE FROM expenditure_line'));
  assert.equal(deletes.length, 3, 'lines are full-replaced on update');
});

// -------------------------------------------------------------------------
// 5. Non-AUD receipt throws a descriptive error.
// -------------------------------------------------------------------------

test('non-AUD receipt throws descriptive error before INSERT', async () => {
  const usdReceipt = {
    ReceiptID: 'usd-receipt-1',
    Status: 'AUTHORISED',
    Date: '/Date(1640995200000+0000)/',
    Contact: { Name: 'US Vendor' },
    User: { UserID: 'u1', Email: 'someone@example.com' },
    CurrencyCode: 'USD',
    Total: '100.00',
    LineItems: [],
  };
  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Receipts`)
    .query({ where: 'Status=="AUTHORISED"', page: '1', pageSize: '100' })
    .reply(200, { Receipts: [usdReceipt] });

  const sqlStub = makeSqlStub();
  const chainStub = makeChainStub();

  await assert.rejects(
    syncReceipts(conn(), {
      mode: 'backfill',
      sql_client: sqlStub.sql,
      chain_insert: chainStub.insert,
    }),
    /Non-AUD receipt unsupported in P4: tenant=.* receipt=usd-receipt-1 currency=USD/,
  );
});

// -------------------------------------------------------------------------
// 6. Empty page completes cleanly with 0 inserts.
// -------------------------------------------------------------------------

test('empty response → 0 inserts, 0 events, 0 lines, no DB calls', async () => {
  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Receipts`)
    .query({ where: 'Status=="AUTHORISED"', page: '1', pageSize: '100' })
    .reply(200, { Receipts: [] });

  const sqlStub = makeSqlStub();
  const chainStub = makeChainStub();

  const result = await syncReceipts(conn(), {
    mode: 'backfill',
    sql_client: sqlStub.sql,
    chain_insert: chainStub.insert,
  });

  assert.deepEqual(result, {
    fetched: 0,
    inserted: 0,
    updated: 0,
    lines: 0,
    events_written: 0,
    reimbursee_matched: 0,
  });
  assert.equal(sqlStub.queries.length, 0);
  assert.equal(chainStub.calls.length, 0);
});

test('Receipts field omitted entirely → treated as empty page', async () => {
  // Defensive: Xero may return `{}` rather than `{ Receipts: [] }`
  // for a 304 / no-content branch (the response we treat as "no changes").
  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Receipts`)
    .query({ where: 'Status=="AUTHORISED"', page: '1', pageSize: '100' })
    .reply(200, {});

  const sqlStub = makeSqlStub();
  const chainStub = makeChainStub();

  const result = await syncReceipts(conn(), {
    mode: 'backfill',
    sql_client: sqlStub.sql,
    chain_insert: chainStub.insert,
  });
  assert.equal(result.fetched, 0);
});

// -------------------------------------------------------------------------
// 7. EXPENDITURE_INGESTED event payload shape matches the schema.
// -------------------------------------------------------------------------

test('EXPENDITURE_INGESTED payload matches ExpenditureIngestedPayload', async () => {
  // Only one fixture receipt — easier to assert on the exact payload.
  const r = FIXTURE_AUTHORISED[0]!;
  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Receipts`)
    .query({ where: 'Status=="AUTHORISED"', page: '1', pageSize: '100' })
    .reply(200, { Receipts: [r] });

  const sqlStub = makeSqlStub();
  const onlyExpId = expUuid(0);
  queueNewReceiptRowsNoReimbursee(sqlStub, onlyExpId);
  const chainStub = makeChainStub();

  await syncReceipts(conn(), {
    mode: 'backfill',
    sql_client: sqlStub.sql,
    chain_insert: chainStub.insert,
  });

  assert.equal(chainStub.calls.length, 1);
  const call = chainStub.calls[0]!;
  assert.equal(call.kind, 'EXPENDITURE_INGESTED');
  assert.equal(call.tenant_id, TENANT_ID);
  assert.equal(call.subject_tenant_id, SUBJECT_TENANT_ID);
  // Sync worker — no human captured.
  assert.equal(call.captured_by_user_id, null);
  assert.deepEqual(call.payload, {
    expenditure_id: onlyExpId,
    source: 'xero_receipt',
    vendor_name: 'Cab Co',
    line_count: 1, // Taxi to airport
  });
});

// -------------------------------------------------------------------------
// 8. AUTHORISED filter applied via the `where` query parameter.
// -------------------------------------------------------------------------

test('uses Xero `where` parameter to filter AUTHORISED at the API layer', async () => {
  let capturedQuery: URLSearchParams | undefined;
  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Receipts`)
    .query(true)
    .reply(200, function (uri: string) {
      const u = new URL(`${XERO_API_HOST}${uri}`);
      capturedQuery = u.searchParams;
      return { Receipts: [] };
    });

  const sqlStub = makeSqlStub();
  const chainStub = makeChainStub();
  await syncReceipts(conn(), {
    mode: 'backfill',
    sql_client: sqlStub.sql,
    chain_insert: chainStub.insert,
  });

  assert.ok(capturedQuery, 'query captured');
  assert.equal(capturedQuery.get('where'), 'Status=="AUTHORISED"');
  assert.equal(capturedQuery.get('page'), '1');
  assert.equal(capturedQuery.get('pageSize'), '100');
});

// -------------------------------------------------------------------------
// 9. Lines are full-replaced on UPDATE (no orphan lines from prior sync).
// -------------------------------------------------------------------------

test('lines are full-replaced on UPDATE: DELETE then INSERTs', async () => {
  // Pick the third fixture row (Office Supplies Plus, 2 lines).
  const r = FIXTURE_AUTHORISED[2]!;
  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Receipts`)
    .query({ where: 'Status=="AUTHORISED"', page: '1', pageSize: '100' })
    .reply(200, { Receipts: [r] });

  const sqlStub = makeSqlStub();
  queueExistingReceiptRows(sqlStub, 'existing-office');
  const chainStub = makeChainStub();

  const result = await syncReceipts(conn(), {
    mode: 'backfill',
    sql_client: sqlStub.sql,
    chain_insert: chainStub.insert,
  });

  assert.equal(result.updated, 1);
  assert.equal(result.lines, 2);

  // Order: SELECT reimbursee, SELECT existing, UPDATE, DELETE,
  // INSERT line × 2.
  assert.equal(sqlStub.queries.length, 6);
  assert.ok(sqlStub.queries[0]?.sql.includes('JOIN tenant_user'));
  assert.ok(sqlStub.queries[1]?.sql.includes('SELECT id FROM expenditure'));
  assert.ok(sqlStub.queries[2]?.sql.includes('UPDATE expenditure'));
  assert.ok(sqlStub.queries[3]?.sql.includes('DELETE FROM expenditure_line'));
  assert.ok(sqlStub.queries[4]?.sql.includes('INSERT INTO expenditure_line'));
  assert.ok(sqlStub.queries[5]?.sql.includes('INSERT INTO expenditure_line'));
});

// -------------------------------------------------------------------------
// 10. Source-external-id matching uses the Xero ReceiptID verbatim.
// -------------------------------------------------------------------------

test('source_external_id is the Xero ReceiptID (forwarded as-is)', async () => {
  const r = FIXTURE_AUTHORISED[1]!; // Catering, ReceiptID '22222222-...'
  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Receipts`)
    .query({ where: 'Status=="AUTHORISED"', page: '1', pageSize: '100' })
    .reply(200, { Receipts: [r] });

  const sqlStub = makeSqlStub();
  queueNewReceiptRowsNoReimbursee(sqlStub, expUuid(1));
  const chainStub = makeChainStub();
  await syncReceipts(conn(), {
    mode: 'backfill',
    sql_client: sqlStub.sql,
    chain_insert: chainStub.insert,
  });

  // SELECT existing expenditure params: [tenant_id, source_external_id]
  // — not the first query (reimbursee comes first), so look it up by SQL.
  const selectQ = sqlStub.queries.find((q) => q.sql.includes('SELECT id FROM expenditure'));
  assert.ok(selectQ);
  assert.equal(selectQ.params[0], TENANT_ID);
  assert.equal(selectQ.params[1], '22222222-2222-4222-8222-222222222222');

  // INSERT params include the same ID at position [3] (after tenant_id,
  // subject_tenant_id are positional in the values clause).
  const insertQ = sqlStub.queries.find((q) => q.sql.includes('INSERT INTO expenditure'));
  assert.ok(insertQ);
  assert.equal(insertQ.params[0], TENANT_ID);
  assert.equal(insertQ.params[1], SUBJECT_TENANT_ID);
  assert.equal(insertQ.params[2], '22222222-2222-4222-8222-222222222222');
});

// -------------------------------------------------------------------------
// 11. Backfill sends NO If-Modified-Since header.
// -------------------------------------------------------------------------

test('backfill: no If-Modified-Since header is sent', async () => {
  let sawIfModified = false;
  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Receipts`)
    .query({ where: 'Status=="AUTHORISED"', page: '1', pageSize: '100' })
    .reply(200, function () {
      // `this.req.headers` exists on the nock `this` context; fall back
      // to a header-matcher style by checking the request rather than
      // the matchHeader negation (nock has no matchHeader.absent helper).
      const headers = (this as unknown as { req: { headers: Record<string, string> } }).req.headers;
      sawIfModified = 'if-modified-since' in headers;
      return { Receipts: [] };
    });

  const sqlStub = makeSqlStub();
  const chainStub = makeChainStub();
  await syncReceipts(conn(), {
    mode: 'backfill',
    sql_client: sqlStub.sql,
    chain_insert: chainStub.insert,
  });

  assert.equal(sawIfModified, false, 'backfill must not send If-Modified-Since');
});

// -------------------------------------------------------------------------
// 12-14. Reimbursee email mapping — the B4-specific feature.
// -------------------------------------------------------------------------

test('reimbursee match: submitter email matches a tenant user → reimbursed_to_user_id set on INSERT', async () => {
  const r = FIXTURE_AUTHORISED[0]!; // consultant@firm-a.example.com
  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Receipts`)
    .query({ where: 'Status=="AUTHORISED"', page: '1', pageSize: '100' })
    .reply(200, { Receipts: [r] });

  const sqlStub = makeSqlStub();
  const matchedUserId = '00000000-0000-4000-8000-fedcba000000';
  const expId = expUuid(0);
  queueNewReceiptRowsWithReimbursee(sqlStub, expId, matchedUserId);
  const chainStub = makeChainStub();

  const result = await syncReceipts(conn(), {
    mode: 'backfill',
    sql_client: sqlStub.sql,
    chain_insert: chainStub.insert,
  });

  assert.equal(result.inserted, 1);
  assert.equal(result.reimbursee_matched, 1);

  // Reimbursee SELECT: parameters are [email, tenant_id].
  const reimburseeQ = sqlStub.queries.find((q) => q.sql.includes('JOIN tenant_user'));
  assert.ok(reimburseeQ, 'reimbursee SELECT must run');
  assert.equal(reimburseeQ.params[0], 'consultant@firm-a.example.com');
  assert.equal(reimburseeQ.params[1], TENANT_ID);

  // INSERT must include the matched user id in its params.
  const insertQ = sqlStub.queries.find((q) => q.sql.includes('INSERT INTO expenditure'));
  assert.ok(insertQ);
  // Positional: tenant_id, subject_tenant_id, source_external_id,
  // vendor_name, reference, expenditure_date, total_amount, currency,
  // reimbursed_to_user_id, raw_payload.
  assert.equal(insertQ.params[8], matchedUserId, 'reimbursed_to_user_id is the matched user id');
});

test('reimbursee no-match: submitter email not in firm → reimbursed_to_user_id null on INSERT', async () => {
  const r = FIXTURE_AUTHORISED[1]!; // external-stranger@other-firm.example.com
  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Receipts`)
    .query({ where: 'Status=="AUTHORISED"', page: '1', pageSize: '100' })
    .reply(200, { Receipts: [r] });

  const sqlStub = makeSqlStub();
  queueNewReceiptRowsNoReimbursee(sqlStub, expUuid(1));
  const chainStub = makeChainStub();

  const result = await syncReceipts(conn(), {
    mode: 'backfill',
    sql_client: sqlStub.sql,
    chain_insert: chainStub.insert,
  });

  assert.equal(result.inserted, 1);
  assert.equal(result.reimbursee_matched, 0);

  const insertQ = sqlStub.queries.find((q) => q.sql.includes('INSERT INTO expenditure'));
  assert.ok(insertQ);
  assert.equal(insertQ.params[8], null, 'reimbursed_to_user_id is null when no firm match');
});

test('reimbursee cross-tenant safety: tenant_user JOIN keeps lookup firm-scoped', async () => {
  // The `consultant-other-tenant@firm-b.example.com` row has a real
  // user globally but not in this firm. Our SQL stub returns [] for
  // the reimbursee query — which is exactly the contract we expect
  // from the JOIN-through-tenant_user query when the user belongs to
  // a different tenant. We assert (a) the resolver received both the
  // email AND the tenant_id (so it CAN do the scoping), and (b) the
  // expenditure ends up with reimbursed_to_user_id = null.
  const r = FIXTURE_AUTHORISED[2]!;
  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Receipts`)
    .query({ where: 'Status=="AUTHORISED"', page: '1', pageSize: '100' })
    .reply(200, { Receipts: [r] });

  const sqlStub = makeSqlStub();
  queueNewReceiptRowsNoReimbursee(sqlStub, expUuid(2));
  const chainStub = makeChainStub();

  const result = await syncReceipts(conn(), {
    mode: 'backfill',
    sql_client: sqlStub.sql,
    chain_insert: chainStub.insert,
  });

  assert.equal(result.reimbursee_matched, 0);

  const reimburseeQ = sqlStub.queries.find((q) => q.sql.includes('JOIN tenant_user'));
  assert.ok(reimburseeQ, 'reimbursee SELECT must run');
  assert.equal(reimburseeQ.params[0], 'consultant-other-tenant@firm-b.example.com');
  assert.equal(reimburseeQ.params[1], TENANT_ID);
  // Confirm the SQL text includes the tenant_id WHERE clause (defence in
  // depth — the params alone don't prove the SQL applies them).
  assert.ok(reimburseeQ.sql.includes('tu.tenant_id ='));
  assert.ok(reimburseeQ.sql.includes('u.email ='));

  const insertQ = sqlStub.queries.find((q) => q.sql.includes('INSERT INTO expenditure'));
  assert.ok(insertQ);
  assert.equal(insertQ.params[8], null);
});

// -------------------------------------------------------------------------
// 15. Reimbursee re-resolved on UPDATE (email lookup runs every sync).
// -------------------------------------------------------------------------

test('reimbursee is re-resolved on UPDATE so email changes propagate', async () => {
  const r = FIXTURE_AUTHORISED[0]!;
  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Receipts`)
    .query({ where: 'Status=="AUTHORISED"', page: '1', pageSize: '100' })
    .reply(200, { Receipts: [r] });

  const sqlStub = makeSqlStub();
  // UPDATE path: reimbursee NOW resolves to a user (e.g. they were
  // added to the firm since the last sync), and the existing
  // expenditure row already exists.
  const newlyMatchedUserId = '00000000-0000-4000-8000-fedcba000001';
  sqlStub.enqueueReimbursee([{ id: newlyMatchedUserId }]);
  sqlStub.enqueueExisting([{ id: 'existing-receipt-1' }]);
  const chainStub = makeChainStub();

  const result = await syncReceipts(conn(), {
    mode: 'backfill',
    sql_client: sqlStub.sql,
    chain_insert: chainStub.insert,
  });

  assert.equal(result.updated, 1);
  assert.equal(result.reimbursee_matched, 1);
  // No EXPENDITURE_INGESTED on UPDATE.
  assert.equal(chainStub.calls.length, 0);

  // The UPDATE statement must carry the new reimbursed_to_user_id.
  const updateQ = sqlStub.queries.find((q) => q.sql.includes('UPDATE expenditure'));
  assert.ok(updateQ);
  // Positional UPDATE params (in order they appear in the SQL):
  //   vendor_name, reference, expenditure_date, total_amount,
  //   currency, reimbursed_to_user_id, raw_payload, id.
  assert.equal(updateQ.params[5], newlyMatchedUserId);
});
