import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import nock from 'nock';
import { syncContacts, type SqlClient, type SyncContactsConnection } from './sync-contacts.js';

/**
 * B5 sync-contacts tests.
 *
 * Approach: pure-function-style tests with mocked DB, mirroring B2/B3/B4.
 * Cache-table sync is simpler than expenditure sync — no event chain,
 * no reimbursee resolution, no AUD currency check. The SQL stub
 * captures every call and returns a single-row UPSERT result; tests
 * pre-load `inserted: true` (new row) or `inserted: false` (existing
 * row) per receipt to drive the inserted/updated counter assertions.
 *
 * The full DB tests (RLS, FK, GIN index) run in CI via the @cpa/db
 * integration suite — Docker isn't running on the Windows author
 * workstation, and pure-function tests give faster feedback regardless.
 */

const TENANT_ID = '00000000-0000-4000-8000-0000000000a1';
const CONNECTION_ID = '00000000-0000-4000-8000-0000000000a3';
const XERO_TENANT_ID = '11111111-2222-3333-4444-555555555555';

const XERO_API_HOST = 'https://api.xero.com';
const XERO_API_PATH = '/api.xro/2.0';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(
  here,
  '../../../../tests/fixtures/xero-accounting/contacts-sample.json',
);
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as {
  Contacts: Array<{
    ContactID: string;
    ContactStatus: string;
    Name: string;
    EmailAddress: string | null;
    IsSupplier: boolean;
    IsCustomer: boolean;
  }>;
};

const FIXTURE_ACTIVE = FIXTURE.Contacts.filter((c) => c.ContactStatus === 'ACTIVE');
const FIXTURE_ARCHIVED = FIXTURE.Contacts.filter((c) => c.ContactStatus === 'ARCHIVED');
assert.equal(FIXTURE_ACTIVE.length, 3, 'fixture must have exactly 3 ACTIVE contacts');
assert.equal(FIXTURE_ARCHIVED.length, 1, 'fixture must have exactly 1 ARCHIVED contact');

// -- SQL stub --------------------------------------------------------------
//
// Each call to `sql` is captured. The stub returns a queued
// `[{ inserted: <bool> }]` row for each UPSERT; tests pre-load whether
// each contact should be treated as a new insert (true) or an update
// (false). FIFO across contacts.

type CapturedQuery = { sql: string; params: unknown[] };

interface SqlStub {
  sql: SqlClient;
  queries: CapturedQuery[];
  /** Queue an UPSERT result (FIFO across contacts). `inserted=true` → INSERT path. */
  enqueueUpsertResult: (inserted: boolean) => void;
}

function makeSqlStub(): SqlStub {
  const queries: CapturedQuery[] = [];
  const upsertQ: Array<Array<{ inserted: boolean }>> = [];
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const sqlText = strings.join('?');
    queries.push({ sql: sqlText, params: values });
    if (sqlText.includes('INSERT INTO xero_contact')) {
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

const conn = (): SyncContactsConnection => ({
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
// 1. Backfill mode: paginated fetch (mock 2 pages), all ACTIVE rows mapped.
// -------------------------------------------------------------------------

test('backfill: paginates until short page; all ACTIVE rows persisted', async () => {
  // Page 1: 100 ACTIVE rows → triggers page=2 follow-up.
  const page1Contacts = Array.from({ length: 100 }, (_, i) => ({
    ContactID: `aaaaaaaa-${String(i).padStart(4, '0')}-4111-8111-aaaaaaaaaaaa`,
    ContactStatus: 'ACTIVE',
    Name: `Vendor ${i}`,
    EmailAddress: `vendor-${i}@example.com`,
    IsSupplier: true,
    IsCustomer: false,
  }));

  // Page 2: short page (< 100), terminates.
  const page2Contacts = FIXTURE_ACTIVE;

  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Contacts`)
    .query({ where: 'ContactStatus=="ACTIVE"', page: '1', pageSize: '100' })
    .reply(200, { Contacts: page1Contacts });

  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Contacts`)
    .query({ where: 'ContactStatus=="ACTIVE"', page: '2', pageSize: '100' })
    .reply(200, { Contacts: page2Contacts });

  const sqlStub = makeSqlStub();
  for (let i = 0; i < 103; i++) {
    sqlStub.enqueueUpsertResult(true); // all new
  }

  const result = await syncContacts(conn(), {
    mode: 'backfill',
    sql_client: sqlStub.sql,
  });

  assert.equal(result.fetched, 103);
  assert.equal(result.inserted, 103);
  assert.equal(result.updated, 0);
});

// -------------------------------------------------------------------------
// 2. Incremental mode: If-Modified-Since header set correctly.
// -------------------------------------------------------------------------

test('incremental: sets If-Modified-Since header and forwards `since` correctly', async () => {
  let capturedIfModified: string | undefined;
  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Contacts`)
    .matchHeader('if-modified-since', (val: string | string[]) => {
      capturedIfModified = Array.isArray(val) ? val[0] : val;
      return true;
    })
    .query({ where: 'ContactStatus=="ACTIVE"', page: '1', pageSize: '100' })
    .reply(200, { Contacts: FIXTURE_ACTIVE });

  const sqlStub = makeSqlStub();
  for (let i = 0; i < FIXTURE_ACTIVE.length; i++) {
    sqlStub.enqueueUpsertResult(true);
  }

  const since = new Date('2026-04-20T00:00:00Z');
  const result = await syncContacts(conn(), {
    mode: 'incremental',
    since,
    sql_client: sqlStub.sql,
  });

  assert.equal(capturedIfModified, since.toUTCString());
  assert.equal(result.fetched, 3);
  assert.equal(result.inserted, 3);
});

test('incremental: throws if `since` is missing', async () => {
  const sqlStub = makeSqlStub();
  await assert.rejects(
    syncContacts(conn(), {
      mode: 'incremental',
      sql_client: sqlStub.sql,
    }),
    /requires `since`/,
  );
});

// -------------------------------------------------------------------------
// 3. Empty page → 0 upserts, no DB calls.
// -------------------------------------------------------------------------

test('empty response → 0 upserts, no DB calls', async () => {
  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Contacts`)
    .query({ where: 'ContactStatus=="ACTIVE"', page: '1', pageSize: '100' })
    .reply(200, { Contacts: [] });

  const sqlStub = makeSqlStub();

  const result = await syncContacts(conn(), {
    mode: 'backfill',
    sql_client: sqlStub.sql,
  });

  assert.deepEqual(result, { fetched: 0, inserted: 0, updated: 0 });
  assert.equal(sqlStub.queries.length, 0);
});

test('Contacts field omitted entirely → treated as empty page', async () => {
  // Defensive: Xero may return `{}` rather than `{ Contacts: [] }`
  // for a 304 / no-content branch.
  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Contacts`)
    .query({ where: 'ContactStatus=="ACTIVE"', page: '1', pageSize: '100' })
    .reply(200, {});

  const sqlStub = makeSqlStub();

  const result = await syncContacts(conn(), {
    mode: 'backfill',
    sql_client: sqlStub.sql,
  });
  assert.equal(result.fetched, 0);
});

// -------------------------------------------------------------------------
// 4. Idempotent re-sync: existing rows UPDATE without errors.
// -------------------------------------------------------------------------

test('idempotency: re-syncing existing rows UPDATEs and increments updated counter', async () => {
  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Contacts`)
    .query({ where: 'ContactStatus=="ACTIVE"', page: '1', pageSize: '100' })
    .reply(200, { Contacts: FIXTURE_ACTIVE });

  const sqlStub = makeSqlStub();
  // All 3 rows are existing (UPDATE path) — UPSERT returns inserted=false.
  for (let i = 0; i < 3; i++) {
    sqlStub.enqueueUpsertResult(false);
  }

  const result = await syncContacts(conn(), {
    mode: 'backfill',
    sql_client: sqlStub.sql,
  });

  assert.equal(result.fetched, 3);
  assert.equal(result.inserted, 0);
  assert.equal(result.updated, 3);

  // Every UPSERT should have used ON CONFLICT DO UPDATE — the SQL must
  // contain `ON CONFLICT (tenant_id, xero_contact_id) DO UPDATE`.
  const upserts = sqlStub.queries.filter((q) => q.sql.includes('INSERT INTO xero_contact'));
  assert.equal(upserts.length, 3);
  for (const u of upserts) {
    assert.ok(
      u.sql.includes('ON CONFLICT (tenant_id, xero_contact_id) DO UPDATE'),
      'UPSERT must use the composite-PK ON CONFLICT clause',
    );
    assert.ok(
      u.sql.includes('synced_at = now()'),
      'UPDATE clause must refresh synced_at on every sync',
    );
  }
});

// -------------------------------------------------------------------------
// 5. ARCHIVED rows filtered out (defensive guard).
// -------------------------------------------------------------------------

test('non-ACTIVE rows filtered out (defensive guard) — only ACTIVE persisted', async () => {
  // Even if the API filter ever drops, the local
  // `c.ContactStatus !== 'ACTIVE'` guard keeps ARCHIVED contacts out
  // of xero_contact. This test sends the FULL fixture (incl. the
  // ARCHIVED row) and asserts only 3 are persisted.
  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Contacts`)
    .query({ where: 'ContactStatus=="ACTIVE"', page: '1', pageSize: '100' })
    .reply(200, { Contacts: FIXTURE.Contacts });

  const sqlStub = makeSqlStub();
  for (let i = 0; i < 3; i++) {
    sqlStub.enqueueUpsertResult(true);
  }

  const result = await syncContacts(conn(), {
    mode: 'backfill',
    sql_client: sqlStub.sql,
  });

  assert.equal(result.fetched, 3, 'ARCHIVED must not count toward fetched');
  assert.equal(result.inserted, 3);
  assert.equal(result.updated, 0);

  // No UPSERT should have run for the ARCHIVED contact's ContactID.
  const upserts = sqlStub.queries.filter((q) => q.sql.includes('INSERT INTO xero_contact'));
  assert.equal(upserts.length, 3);
  for (const u of upserts) {
    assert.notEqual(
      u.params[1],
      'dddddddd-4444-4444-8444-dddddddddddd',
      'ARCHIVED contact id must not appear in any UPSERT',
    );
  }
});

// -------------------------------------------------------------------------
// 6. raw_payload preserved as full Xero contact JSON.
// -------------------------------------------------------------------------

test('raw_payload param is the full Xero contact JSON (preserved verbatim)', async () => {
  const c = FIXTURE_ACTIVE[0]!;
  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Contacts`)
    .query({ where: 'ContactStatus=="ACTIVE"', page: '1', pageSize: '100' })
    .reply(200, { Contacts: [c] });

  const sqlStub = makeSqlStub();
  sqlStub.enqueueUpsertResult(true);

  await syncContacts(conn(), {
    mode: 'backfill',
    sql_client: sqlStub.sql,
  });

  const upsert = sqlStub.queries.find((q) => q.sql.includes('INSERT INTO xero_contact'));
  assert.ok(upsert);
  // Positional params order:
  //   tenant_id, xero_contact_id, name, email,
  //   is_supplier, is_customer, contact_status, raw_payload.
  assert.equal(upsert.params[0], TENANT_ID);
  assert.equal(upsert.params[1], c.ContactID);
  assert.equal(upsert.params[2], c.Name);
  assert.equal(upsert.params[7], JSON.stringify(c));
  // Sanity: round-trip the JSON back and confirm it matches the input.
  // upsert.params[7] is typed `unknown`; narrow via runtime guard.
  const rawJson = upsert.params[7];
  if (typeof rawJson !== 'string') {
    throw new Error('raw_payload param must be a string');
  }
  const reparsed = JSON.parse(rawJson) as unknown;
  assert.deepEqual(reparsed, c);
});

// -------------------------------------------------------------------------
// 7. synced_at is refreshed on UPDATE (set to now() in the ON CONFLICT clause).
// -------------------------------------------------------------------------

test('synced_at is refreshed on UPDATE: ON CONFLICT clause sets `synced_at = now()`', async () => {
  // This is a SQL-shape test: the contract is that the UPSERT's
  // ON CONFLICT DO UPDATE block ALWAYS sets synced_at = now(), so a
  // re-sync of an unchanged row still ticks the cache freshness.
  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Contacts`)
    .query({ where: 'ContactStatus=="ACTIVE"', page: '1', pageSize: '100' })
    .reply(200, { Contacts: [FIXTURE_ACTIVE[0]!] });

  const sqlStub = makeSqlStub();
  sqlStub.enqueueUpsertResult(false); // existing row → UPDATE path.
  await syncContacts(conn(), {
    mode: 'backfill',
    sql_client: sqlStub.sql,
  });

  const upsert = sqlStub.queries.find((q) => q.sql.includes('INSERT INTO xero_contact'));
  assert.ok(upsert);
  // The DO UPDATE SET block must include `synced_at = now()`.
  const conflictBlock = upsert.sql.split('ON CONFLICT')[1];
  assert.ok(conflictBlock, 'ON CONFLICT clause must be present');
  assert.ok(
    conflictBlock.includes('synced_at = now()'),
    'DO UPDATE block must refresh synced_at on every sync',
  );
});

// -------------------------------------------------------------------------
// 8. Inserted vs updated counters from xmax = 0 trick.
// -------------------------------------------------------------------------

test('inserted/updated counters are driven by `xmax = 0` UPSERT discrimination', async () => {
  // Mixed: 2 new rows (xmax=0 → inserted=true) and 1 existing
  // (inserted=false). The counters must reflect the per-row signal
  // returned by the UPSERT.
  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Contacts`)
    .query({ where: 'ContactStatus=="ACTIVE"', page: '1', pageSize: '100' })
    .reply(200, { Contacts: FIXTURE_ACTIVE });

  const sqlStub = makeSqlStub();
  sqlStub.enqueueUpsertResult(true); // new
  sqlStub.enqueueUpsertResult(false); // existing
  sqlStub.enqueueUpsertResult(true); // new

  const result = await syncContacts(conn(), {
    mode: 'backfill',
    sql_client: sqlStub.sql,
  });

  assert.equal(result.fetched, 3);
  assert.equal(result.inserted, 2);
  assert.equal(result.updated, 1);

  // Confirm the SQL asks for `(xmax = 0) AS inserted` so the
  // discrimination contract is authentic.
  const upsert = sqlStub.queries.find((q) => q.sql.includes('INSERT INTO xero_contact'));
  assert.ok(upsert);
  assert.ok(
    upsert.sql.includes('RETURNING (xmax = 0) AS inserted'),
    'UPSERT must RETURN the xmax discriminator',
  );
});

// -------------------------------------------------------------------------
// 9. Cross-tenant safety: tenant_id from connection is propagated to UPSERT.
// -------------------------------------------------------------------------

test('cross-tenant safety: UPSERT uses connection.tenant_id verbatim', async () => {
  const c = FIXTURE_ACTIVE[0]!;
  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Contacts`)
    .query({ where: 'ContactStatus=="ACTIVE"', page: '1', pageSize: '100' })
    .reply(200, { Contacts: [c] });

  const sqlStub = makeSqlStub();
  sqlStub.enqueueUpsertResult(true);

  // Use a DIFFERENT tenant id than the global TENANT_ID constant — we
  // want to prove the UPSERT carries whatever tenant_id the connection
  // says, not a hard-coded module value.
  const otherTenant = '00000000-0000-4000-8000-0000000000ff';
  await syncContacts(
    {
      ...conn(),
      tenant_id: otherTenant,
    },
    { mode: 'backfill', sql_client: sqlStub.sql },
  );

  const upsert = sqlStub.queries.find((q) => q.sql.includes('INSERT INTO xero_contact'));
  assert.ok(upsert);
  assert.equal(upsert.params[0], otherTenant, 'UPSERT must carry the connection tenant_id');
});

// -------------------------------------------------------------------------
// 10. Contact with no email → email param is null (nullable column).
// -------------------------------------------------------------------------

test('contact without email → email param is null on UPSERT', async () => {
  // Fixture row 1 (Conference Catering) has EmailAddress: null.
  const c = FIXTURE_ACTIVE[1]!;
  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Contacts`)
    .query({ where: 'ContactStatus=="ACTIVE"', page: '1', pageSize: '100' })
    .reply(200, { Contacts: [c] });

  const sqlStub = makeSqlStub();
  sqlStub.enqueueUpsertResult(true);

  await syncContacts(conn(), {
    mode: 'backfill',
    sql_client: sqlStub.sql,
  });

  const upsert = sqlStub.queries.find((q) => q.sql.includes('INSERT INTO xero_contact'));
  assert.ok(upsert);
  // Position [3] is the email param.
  assert.equal(upsert.params[3], null);
});

// -------------------------------------------------------------------------
// 11. is_supplier / is_customer flags propagated correctly.
// -------------------------------------------------------------------------

test('IsSupplier / IsCustomer flags propagate to is_supplier / is_customer params', async () => {
  // Fixture row 2 (Office Supplies Plus) is BOTH supplier and customer.
  const c = FIXTURE_ACTIVE[2]!;
  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Contacts`)
    .query({ where: 'ContactStatus=="ACTIVE"', page: '1', pageSize: '100' })
    .reply(200, { Contacts: [c] });

  const sqlStub = makeSqlStub();
  sqlStub.enqueueUpsertResult(true);

  await syncContacts(conn(), {
    mode: 'backfill',
    sql_client: sqlStub.sql,
  });

  const upsert = sqlStub.queries.find((q) => q.sql.includes('INSERT INTO xero_contact'));
  assert.ok(upsert);
  // Positions: tenant_id, xero_contact_id, name, email,
  //            is_supplier (4), is_customer (5), contact_status, raw_payload.
  assert.equal(upsert.params[4], true);
  assert.equal(upsert.params[5], true);
});

// -------------------------------------------------------------------------
// 12. AUTHORISED filter applied via the `where` query parameter.
// -------------------------------------------------------------------------

test('uses Xero `where` parameter to filter ACTIVE at the API layer', async () => {
  let capturedQuery: URLSearchParams | undefined;
  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Contacts`)
    .query(true)
    .reply(200, function (uri: string) {
      const u = new URL(`${XERO_API_HOST}${uri}`);
      capturedQuery = u.searchParams;
      return { Contacts: [] };
    });

  const sqlStub = makeSqlStub();
  await syncContacts(conn(), {
    mode: 'backfill',
    sql_client: sqlStub.sql,
  });

  assert.ok(capturedQuery, 'query captured');
  assert.equal(capturedQuery.get('where'), 'ContactStatus=="ACTIVE"');
  assert.equal(capturedQuery.get('page'), '1');
  assert.equal(capturedQuery.get('pageSize'), '100');
});

// -------------------------------------------------------------------------
// 13. Backfill sends NO If-Modified-Since header.
// -------------------------------------------------------------------------

test('backfill: no If-Modified-Since header is sent', async () => {
  let sawIfModified = false;
  nock(XERO_API_HOST)
    .get(`${XERO_API_PATH}/Contacts`)
    .query({ where: 'ContactStatus=="ACTIVE"', page: '1', pageSize: '100' })
    .reply(200, function () {
      const headers = (this as unknown as { req: { headers: Record<string, string> } }).req.headers;
      sawIfModified = 'if-modified-since' in headers;
      return { Contacts: [] };
    });

  const sqlStub = makeSqlStub();
  await syncContacts(conn(), {
    mode: 'backfill',
    sql_client: sqlStub.sql,
  });

  assert.equal(sawIfModified, false, 'backfill must not send If-Modified-Since');
});
