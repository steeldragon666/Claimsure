import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import nock from 'nock';
import { syncAccounts, type SqlClient, type SyncAccountsConnection } from './sync-accounts.js';

/**
 * B5 sync-accounts tests.
 *
 * Approach: pure-function-style tests with mocked DB, mirroring B2/B3/B4
 * and the sibling sync-contacts.test.ts. Notable divergence from
 * sync-contacts: NO pagination (the chart-of-accounts is small and
 * Xero's `/Accounts` endpoint returns it in one response), and NO
 * status filter (we sync ACTIVE + ARCHIVED so the UI can surface
 * archived accounts that older expenditures still reference).
 */

const TENANT_ID = '00000000-0000-4000-8000-0000000000a1';
const CONNECTION_ID = '00000000-0000-4000-8000-0000000000a3';
const XERO_TENANT_ID = '11111111-2222-3333-4444-555555555555';

const XERO_API_HOST = 'https://api.xero.com';
const XERO_API_PATH = '/api.xro/2.0';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(
  here,
  '../../../../tests/fixtures/xero-accounting/accounts-sample.json',
);
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as {
  Accounts: Array<{
    AccountID: string;
    Code: string;
    Name: string;
    Type: string;
    Status: string;
  }>;
};

assert.equal(FIXTURE.Accounts.length, 5, 'fixture must have exactly 5 accounts');
const FIXTURE_ACTIVE = FIXTURE.Accounts.filter((a) => a.Status === 'ACTIVE');
const FIXTURE_ARCHIVED = FIXTURE.Accounts.filter((a) => a.Status === 'ARCHIVED');
assert.equal(FIXTURE_ACTIVE.length, 4);
assert.equal(FIXTURE_ARCHIVED.length, 1);
const FIXTURE_BANK = FIXTURE.Accounts.filter((a) => a.Type === 'BANK');
assert.equal(FIXTURE_BANK.length, 1, 'fixture must include a BANK-type account');

// -- SQL stub --------------------------------------------------------------

type CapturedQuery = { sql: string; params: unknown[] };

interface SqlStub {
  sql: SqlClient;
  queries: CapturedQuery[];
  enqueueUpsertResult: (inserted: boolean) => void;
}

function makeSqlStub(): SqlStub {
  const queries: CapturedQuery[] = [];
  const upsertQ: Array<Array<{ inserted: boolean }>> = [];
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const sqlText = strings.join('?');
    queries.push({ sql: sqlText, params: values });
    if (sqlText.includes('INSERT INTO xero_account')) {
      return Promise.resolve(upsertQ.shift() ?? []);
    }
    return Promise.resolve([]);
  }) as unknown as SqlClient;
  return {
    sql: fn,
    queries,
    enqueueUpsertResult: (inserted) => {
      upsertQ.push([{ inserted }]);
    },
  };
}

const conn = (): SyncAccountsConnection => ({
  id: CONNECTION_ID,
  tenant_id: TENANT_ID,
  xero_tenant_id: XERO_TENANT_ID,
  access_token: 'fake-access-token',
});

beforeEach(() => {
  nock.cleanAll();
});

after(() => {
  nock.cleanAll();
});

// -------------------------------------------------------------------------
// 1. Backfill: single GET (no pagination), all accounts persisted.
// -------------------------------------------------------------------------

test('backfill: single GET (no pagination) — all accounts persisted', async () => {
  // Per Xero contract, /Accounts returns the full chart-of-accounts in
  // one response. The sync function must NOT issue a page=2 request.
  let pageQueryParam: string | null = null;
  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Accounts`)
    .query(true)
    .reply(200, function (uri: string) {
      const u = new URL(`${XERO_API_HOST}${uri}`);
      pageQueryParam = u.searchParams.get('page');
      return FIXTURE;
    });

  const sqlStub = makeSqlStub();
  for (let i = 0; i < FIXTURE.Accounts.length; i++) {
    sqlStub.enqueueUpsertResult(true);
  }

  const result = await syncAccounts(conn(), {
    mode: 'backfill',
    sql_client: sqlStub.sql,
  });

  assert.equal(result.fetched, FIXTURE.Accounts.length);
  assert.equal(result.inserted, FIXTURE.Accounts.length);
  assert.equal(result.updated, 0);
  // Crucially: NO ?page=N param — chart-of-accounts is single-shot.
  assert.equal(pageQueryParam, null, 'page query param must NOT be set on /Accounts');
});

// -------------------------------------------------------------------------
// 2. Incremental mode: If-Modified-Since header set correctly.
// -------------------------------------------------------------------------

test('incremental: sets If-Modified-Since header and forwards `since` correctly', async () => {
  let capturedIfModified: string | undefined;
  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Accounts`)
    .matchHeader('if-modified-since', (val: string | string[]) => {
      capturedIfModified = Array.isArray(val) ? val[0] : val;
      return true;
    })
    .reply(200, FIXTURE);

  const sqlStub = makeSqlStub();
  for (let i = 0; i < FIXTURE.Accounts.length; i++) {
    sqlStub.enqueueUpsertResult(true);
  }

  const since = new Date('2026-04-20T00:00:00Z');
  const result = await syncAccounts(conn(), {
    mode: 'incremental',
    since,
    sql_client: sqlStub.sql,
  });

  assert.equal(capturedIfModified, since.toUTCString());
  assert.equal(result.fetched, FIXTURE.Accounts.length);
});

test('incremental: throws if `since` is missing', async () => {
  const sqlStub = makeSqlStub();
  await assert.rejects(
    syncAccounts(conn(), {
      mode: 'incremental',
      sql_client: sqlStub.sql,
    }),
    /requires `since`/,
  );
});

// -------------------------------------------------------------------------
// 3. Empty response → 0 upserts, no DB calls.
// -------------------------------------------------------------------------

test('empty response → 0 upserts, no DB calls', async () => {
  nock(XERO_API_HOST).get(`${XERO_API_PATH}/Accounts`).reply(200, { Accounts: [] });

  const sqlStub = makeSqlStub();

  const result = await syncAccounts(conn(), {
    mode: 'backfill',
    sql_client: sqlStub.sql,
  });

  assert.deepEqual(result, { fetched: 0, inserted: 0, updated: 0 });
  assert.equal(sqlStub.queries.length, 0);
});

test('Accounts field omitted entirely → treated as empty response', async () => {
  // Defensive: Xero may return `{}` rather than `{ Accounts: [] }`.
  nock(XERO_API_HOST).get(`${XERO_API_PATH}/Accounts`).reply(200, {});

  const sqlStub = makeSqlStub();

  const result = await syncAccounts(conn(), {
    mode: 'backfill',
    sql_client: sqlStub.sql,
  });
  assert.equal(result.fetched, 0);
});

// -------------------------------------------------------------------------
// 4. Idempotent re-sync: existing rows UPDATE without errors.
// -------------------------------------------------------------------------

test('idempotency: re-syncing existing rows UPDATEs and increments updated counter', async () => {
  nock(XERO_API_HOST).get(`${XERO_API_PATH}/Accounts`).reply(200, FIXTURE);

  const sqlStub = makeSqlStub();
  // All 5 rows are existing (UPDATE path) — UPSERT returns inserted=false.
  for (let i = 0; i < FIXTURE.Accounts.length; i++) {
    sqlStub.enqueueUpsertResult(false);
  }

  const result = await syncAccounts(conn(), {
    mode: 'backfill',
    sql_client: sqlStub.sql,
  });

  assert.equal(result.fetched, FIXTURE.Accounts.length);
  assert.equal(result.inserted, 0);
  assert.equal(result.updated, FIXTURE.Accounts.length);

  // UPSERT must use the composite-PK ON CONFLICT clause.
  const upserts = sqlStub.queries.filter((q) => q.sql.includes('INSERT INTO xero_account'));
  assert.equal(upserts.length, FIXTURE.Accounts.length);
  for (const u of upserts) {
    assert.ok(
      u.sql.includes('ON CONFLICT (tenant_id, xero_account_id) DO UPDATE'),
      'UPSERT must use the composite-PK ON CONFLICT clause',
    );
    assert.ok(
      u.sql.includes('synced_at = now()'),
      'UPDATE clause must refresh synced_at on every sync',
    );
  }
});

// -------------------------------------------------------------------------
// 5. ARCHIVED accounts ARE included (no status filter — UI handles it).
// -------------------------------------------------------------------------

test('ARCHIVED accounts are NOT filtered out — sync brings them in too', async () => {
  // Distinct from sync-contacts: chart-of-accounts sync includes
  // ARCHIVED rows so the UI can surface them when older expenditures
  // reference an archived account code.
  nock(XERO_API_HOST).get(`${XERO_API_PATH}/Accounts`).reply(200, FIXTURE);

  const sqlStub = makeSqlStub();
  for (let i = 0; i < FIXTURE.Accounts.length; i++) {
    sqlStub.enqueueUpsertResult(true);
  }

  const result = await syncAccounts(conn(), {
    mode: 'backfill',
    sql_client: sqlStub.sql,
  });

  // The ARCHIVED account must be among the upserted rows.
  assert.equal(result.fetched, FIXTURE.Accounts.length);
  const archivedId = FIXTURE_ARCHIVED[0]!.AccountID;
  const upserts = sqlStub.queries.filter((q) => q.sql.includes('INSERT INTO xero_account'));
  const archivedUpsert = upserts.find((u) => u.params[1] === archivedId);
  assert.ok(archivedUpsert, 'ARCHIVED account must be included in the sync');
  // Status param at position [5] (after tenant_id, account_id, code, name, type).
  assert.equal(archivedUpsert.params[5], 'ARCHIVED');
});

// -------------------------------------------------------------------------
// 6. BANK-type account is included (no type filter on the API call).
// -------------------------------------------------------------------------

test('BANK-type account is included (no type filter on /Accounts call)', async () => {
  nock(XERO_API_HOST).get(`${XERO_API_PATH}/Accounts`).reply(200, FIXTURE);

  const sqlStub = makeSqlStub();
  for (let i = 0; i < FIXTURE.Accounts.length; i++) {
    sqlStub.enqueueUpsertResult(true);
  }

  await syncAccounts(conn(), {
    mode: 'backfill',
    sql_client: sqlStub.sql,
  });

  const bankId = FIXTURE_BANK[0]!.AccountID;
  const upserts = sqlStub.queries.filter((q) => q.sql.includes('INSERT INTO xero_account'));
  const bankUpsert = upserts.find((u) => u.params[1] === bankId);
  assert.ok(bankUpsert, 'BANK-type account must be included');
  // Type param at position [4].
  assert.equal(bankUpsert.params[4], 'BANK');
});

// -------------------------------------------------------------------------
// 7. raw_payload preserved as full Xero account JSON.
// -------------------------------------------------------------------------

test('raw_payload param is the full Xero account JSON (preserved verbatim)', async () => {
  const a = FIXTURE.Accounts[0]!;
  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Accounts`)
    .reply(200, { Accounts: [a] });

  const sqlStub = makeSqlStub();
  sqlStub.enqueueUpsertResult(true);

  await syncAccounts(conn(), {
    mode: 'backfill',
    sql_client: sqlStub.sql,
  });

  const upsert = sqlStub.queries.find((q) => q.sql.includes('INSERT INTO xero_account'));
  assert.ok(upsert);
  // Positional params: tenant_id, account_id, code, name, type, status, raw_payload.
  assert.equal(upsert.params[0], TENANT_ID);
  assert.equal(upsert.params[1], a.AccountID);
  assert.equal(upsert.params[2], a.Code);
  assert.equal(upsert.params[6], JSON.stringify(a));
  // Sanity: round-trip the JSON back and confirm it matches the input.
  // upsert.params[6] is typed `unknown`; narrow via runtime guard.
  const rawJson = upsert.params[6];
  if (typeof rawJson !== 'string') {
    throw new Error('raw_payload param must be a string');
  }
  const reparsed = JSON.parse(rawJson) as unknown;
  assert.deepEqual(reparsed, a);
});

// -------------------------------------------------------------------------
// 8. synced_at is refreshed on UPDATE.
// -------------------------------------------------------------------------

test('synced_at is refreshed on UPDATE: ON CONFLICT clause sets `synced_at = now()`', async () => {
  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Accounts`)
    .reply(200, { Accounts: [FIXTURE.Accounts[0]!] });

  const sqlStub = makeSqlStub();
  sqlStub.enqueueUpsertResult(false); // existing → UPDATE.
  await syncAccounts(conn(), {
    mode: 'backfill',
    sql_client: sqlStub.sql,
  });

  const upsert = sqlStub.queries.find((q) => q.sql.includes('INSERT INTO xero_account'));
  assert.ok(upsert);
  const conflictBlock = upsert.sql.split('ON CONFLICT')[1];
  assert.ok(conflictBlock, 'ON CONFLICT clause must be present');
  assert.ok(
    conflictBlock.includes('synced_at = now()'),
    'DO UPDATE block must refresh synced_at on every sync',
  );
});

// -------------------------------------------------------------------------
// 9. Inserted vs updated counters from xmax = 0 trick.
// -------------------------------------------------------------------------

test('inserted/updated counters are driven by `xmax = 0` UPSERT discrimination', async () => {
  nock(XERO_API_HOST).get(`${XERO_API_PATH}/Accounts`).reply(200, FIXTURE);

  const sqlStub = makeSqlStub();
  // Mixed: 3 new + 2 existing.
  sqlStub.enqueueUpsertResult(true);
  sqlStub.enqueueUpsertResult(false);
  sqlStub.enqueueUpsertResult(true);
  sqlStub.enqueueUpsertResult(false);
  sqlStub.enqueueUpsertResult(true);

  const result = await syncAccounts(conn(), {
    mode: 'backfill',
    sql_client: sqlStub.sql,
  });

  assert.equal(result.fetched, 5);
  assert.equal(result.inserted, 3);
  assert.equal(result.updated, 2);

  const upsert = sqlStub.queries.find((q) => q.sql.includes('INSERT INTO xero_account'));
  assert.ok(upsert);
  assert.ok(
    upsert.sql.includes('RETURNING (xmax = 0) AS inserted'),
    'UPSERT must RETURN the xmax discriminator',
  );
});

// -------------------------------------------------------------------------
// 10. Cross-tenant safety: tenant_id from connection is propagated.
// -------------------------------------------------------------------------

test('cross-tenant safety: UPSERT uses connection.tenant_id verbatim', async () => {
  const a = FIXTURE.Accounts[0]!;
  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Accounts`)
    .reply(200, { Accounts: [a] });

  const sqlStub = makeSqlStub();
  sqlStub.enqueueUpsertResult(true);

  const otherTenant = '00000000-0000-4000-8000-0000000000ff';
  await syncAccounts(
    {
      ...conn(),
      tenant_id: otherTenant,
    },
    { mode: 'backfill', sql_client: sqlStub.sql },
  );

  const upsert = sqlStub.queries.find((q) => q.sql.includes('INSERT INTO xero_account'));
  assert.ok(upsert);
  assert.equal(upsert.params[0], otherTenant);
});

// -------------------------------------------------------------------------
// 11. Code stored as text (e.g. "090" — leading zero preserved).
// -------------------------------------------------------------------------

test('account code with leading zero is preserved as text (e.g. "090")', async () => {
  // Xero account codes are arbitrary text — "090" must NOT be coerced
  // to the number 90. Fixture row 3 (Business Bank Account) is "090".
  const bank = FIXTURE_BANK[0]!;
  assert.equal(bank.Code, '090', 'fixture sanity: bank code is the literal string "090"');

  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Accounts`)
    .reply(200, { Accounts: [bank] });

  const sqlStub = makeSqlStub();
  sqlStub.enqueueUpsertResult(true);

  await syncAccounts(conn(), {
    mode: 'backfill',
    sql_client: sqlStub.sql,
  });

  const upsert = sqlStub.queries.find((q) => q.sql.includes('INSERT INTO xero_account'));
  assert.ok(upsert);
  // Position [2] is the code.
  assert.equal(upsert.params[2], '090');
  assert.equal(typeof upsert.params[2], 'string');
});

// -------------------------------------------------------------------------
// 12. Backfill sends NO If-Modified-Since header.
// -------------------------------------------------------------------------

test('backfill: no If-Modified-Since header is sent', async () => {
  let sawIfModified = false;
  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Accounts`)
    .reply(200, function () {
      const headers = (this as unknown as { req: { headers: Record<string, string> } }).req.headers;
      sawIfModified = 'if-modified-since' in headers;
      return { Accounts: [] };
    });

  const sqlStub = makeSqlStub();
  await syncAccounts(conn(), {
    mode: 'backfill',
    sql_client: sqlStub.sql,
  });

  assert.equal(sawIfModified, false, 'backfill must not send If-Modified-Since');
});
