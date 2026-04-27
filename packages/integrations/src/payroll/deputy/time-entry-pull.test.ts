import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import nock from 'nock';
import { pullTimesheets } from './time-entry-pull.js';
import type { SqlClient } from './employee-sync.js';

const INSTALL_URL = 'https://acme.deputy.com';
const TENANT_ID = '00000000-0000-4000-8000-000000000da1';
const SUBJECT_ID = '00000000-0000-4000-8000-000000000da2';

/**
 * pullTimesheets issues two query shapes per non-discarded timesheet:
 *   1. SELECT id FROM subject_tenant_employee … → returns a row when
 *      the employee is known, empty when unmatched.
 *   2. INSERT … ON CONFLICT … RETURNING (xmax = 0) AS inserted →
 *      returns `[{ inserted: true }]` for new rows, `[{ inserted: false }]`
 *      for conflict-driven updates.
 *
 * Discarded timesheets (Discarded === 1) are skipped before either
 * query runs.
 */
type StubConfig = {
  /** Map of stringified Deputy Employee → local subject_tenant_employee.id. */
  employee_lookup: Record<string, string>;
  /** Map of stringified Deputy timesheet Id → whether the upsert reports inserted=true. */
  upsert_inserted: Record<string, boolean>;
};

type CapturedQuery = { sql: string; params: unknown[] };

function makeSqlStub(cfg: StubConfig): { sql: SqlClient; queries: CapturedQuery[] } {
  const queries: CapturedQuery[] = [];
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const rendered = strings.join('?');
    queries.push({ sql: rendered, params: values });
    if (rendered.includes('SELECT id FROM subject_tenant_employee')) {
      // params: [subject_tenant_id, payroll_external_id]
      const ehId = values[1] as string;
      const localId = cfg.employee_lookup[ehId];
      return Promise.resolve(localId ? [{ id: localId }] : []);
    }
    if (rendered.includes('INSERT INTO time_entry')) {
      // The 'deputy' source literal is in the SQL string. Tagged-template
      // values: [tenant_id, subject_tenant_id, employee_id, external_id,
      // started_at, ended_at, duration_minutes, is_rd, notes].
      const externalId = values[3] as string;
      const inserted = cfg.upsert_inserted[externalId] ?? true;
      return Promise.resolve([{ inserted }]);
    }
    return Promise.resolve([]);
  }) as unknown as SqlClient;
  return { sql: fn, queries };
}

beforeEach(() => {
  nock.cleanAll();
});

after(() => {
  nock.cleanAll();
});

test('pullTimesheets: 3 new timesheets → inserted=3, updated=0, skipped=0', async () => {
  nock(INSTALL_URL)
    .post('/api/v1/resource/Timesheet/QUERY')
    .reply(200, [
      {
        Id: 9001,
        Employee: 1001,
        Date: '2026-04-25',
        StartTime: 1745571600,
        EndTime: 1745600400,
        TotalTime: 8,
        Cost: 0,
        Discarded: 0,
      },
      {
        Id: 9002,
        Employee: 1001,
        Date: '2026-04-26',
        StartTime: 1745658000,
        EndTime: 1745686800,
        TotalTime: 8,
        Cost: 0,
        Discarded: 0,
      },
      {
        Id: 9003,
        Employee: 1002,
        Date: '2026-04-25',
        StartTime: 1745575200,
        EndTime: 1745596800,
        TotalTime: 6,
        Cost: 0,
        Comment: 'lab work',
        Discarded: 0,
      },
    ]);

  const { sql, queries } = makeSqlStub({
    employee_lookup: {
      '1001': 'local-emp-1',
      '1002': 'local-emp-2',
    },
    upsert_inserted: { '9001': true, '9002': true, '9003': true },
  });

  const result = await pullTimesheets({
    access_token: 'fake',
    install_url: INSTALL_URL,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    sql_client: sql,
  });

  assert.equal(result.inserted, 3);
  assert.equal(result.updated, 0);
  assert.equal(result.skipped_unmatched, 0);
  assert.equal(result.skipped_discarded, 0);
  // 3 SELECTs + 3 INSERTs.
  assert.equal(queries.length, 6);
});

test('pullTimesheets: composes ISO timestamps from unix seconds and converts TotalTime→minutes', async () => {
  // 2026-04-25T09:00:00Z = unix 1777107600
  // 2026-04-25T13:15:00Z = unix 1777122900 (4h 15min later)
  nock(INSTALL_URL)
    .post('/api/v1/resource/Timesheet/QUERY')
    .reply(200, [
      {
        Id: 9100,
        Employee: 1001,
        Date: '2026-04-25',
        StartTime: 1777107600,
        EndTime: 1777122900,
        TotalTime: 4.25,
        Cost: 0,
        Discarded: 0,
      },
    ]);

  const { sql, queries } = makeSqlStub({
    employee_lookup: { '1001': 'local-emp-1' },
    upsert_inserted: { '9100': true },
  });

  await pullTimesheets({
    access_token: 'fake',
    install_url: INSTALL_URL,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    sql_client: sql,
  });

  // Last query is the INSERT.
  const insertQuery = queries[1];
  assert.ok(insertQuery);
  // params: [tenant_id, subject_tenant_id, employee_id, external_id,
  //          started_at, ended_at, duration_minutes, is_rd, notes]
  assert.equal(insertQuery.params[3], '9100');
  assert.equal(insertQuery.params[4], '2026-04-25T09:00:00.000Z');
  assert.equal(insertQuery.params[5], '2026-04-25T13:15:00.000Z');
  // 4.25 hours × 60 = 255 minutes.
  assert.equal(insertQuery.params[6], 255);
  assert.equal(insertQuery.params[7], true);
});

test('pullTimesheets: existing row → updated=1', async () => {
  nock(INSTALL_URL)
    .post('/api/v1/resource/Timesheet/QUERY')
    .reply(200, [
      {
        Id: 9200,
        Employee: 1001,
        Date: '2026-04-25',
        StartTime: 1745571600,
        EndTime: 1745600400,
        TotalTime: 8,
        Cost: 0,
        Discarded: 0,
      },
    ]);

  const { sql } = makeSqlStub({
    employee_lookup: { '1001': 'local-emp-1' },
    upsert_inserted: { '9200': false },
  });

  const result = await pullTimesheets({
    access_token: 'fake',
    install_url: INSTALL_URL,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    sql_client: sql,
  });

  assert.equal(result.inserted, 0);
  assert.equal(result.updated, 1);
  assert.equal(result.skipped_unmatched, 0);
  assert.equal(result.skipped_discarded, 0);
});

test('pullTimesheets: Discarded === 1 → skipped_discarded, no DB calls', async () => {
  nock(INSTALL_URL)
    .post('/api/v1/resource/Timesheet/QUERY')
    .reply(200, [
      {
        Id: 9300,
        Employee: 1001,
        Date: '2026-04-25',
        StartTime: 1745571600,
        EndTime: 1745600400,
        TotalTime: 8,
        Cost: 0,
        Discarded: 1,
      },
      {
        Id: 9301,
        Employee: 1001,
        Date: '2026-04-26',
        StartTime: 1745658000,
        EndTime: 1745686800,
        TotalTime: 8,
        Cost: 0,
        Discarded: 0,
      },
    ]);

  const { sql, queries } = makeSqlStub({
    employee_lookup: { '1001': 'local-emp-1' },
    upsert_inserted: { '9301': true },
  });

  const result = await pullTimesheets({
    access_token: 'fake',
    install_url: INSTALL_URL,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    sql_client: sql,
  });

  assert.equal(result.inserted, 1);
  assert.equal(result.updated, 0);
  assert.equal(result.skipped_unmatched, 0);
  assert.equal(result.skipped_discarded, 1);
  // Only 2 queries (SELECT + INSERT) for the live row — no queries
  // for the discarded one.
  assert.equal(queries.length, 2);
});

test('pullTimesheets: unknown employee → skipped_unmatched, no INSERT', async () => {
  nock(INSTALL_URL)
    .post('/api/v1/resource/Timesheet/QUERY')
    .reply(200, [
      {
        Id: 9400,
        Employee: 9999,
        Date: '2026-04-25',
        StartTime: 1745571600,
        EndTime: 1745600400,
        TotalTime: 8,
        Cost: 0,
        Discarded: 0,
      },
    ]);

  const { sql, queries } = makeSqlStub({
    employee_lookup: {},
    upsert_inserted: {},
  });

  const result = await pullTimesheets({
    access_token: 'fake',
    install_url: INSTALL_URL,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    sql_client: sql,
  });

  assert.equal(result.inserted, 0);
  assert.equal(result.updated, 0);
  assert.equal(result.skipped_unmatched, 1);
  // Only the SELECT — no INSERT for the orphan.
  assert.equal(queries.length, 1);
  assert.ok(queries[0]?.sql.includes('SELECT id FROM subject_tenant_employee'));
  // Verify the lookup uses the stringified numeric id.
  assert.equal(queries[0]?.params[1], '9999');
  // Confirm the deputy provider filter is in the SQL.
  assert.ok(queries[0]?.sql.includes("'deputy'"));
});

test('pullTimesheets: mixed — 1 new + 1 existing + 1 discarded + 1 orphan', async () => {
  nock(INSTALL_URL)
    .post('/api/v1/resource/Timesheet/QUERY')
    .reply(200, [
      {
        Id: 9500,
        Employee: 1001,
        Date: '2026-04-25',
        StartTime: 1745571600,
        EndTime: 1745600400,
        TotalTime: 8,
        Cost: 0,
        Discarded: 0,
      },
      {
        Id: 9501,
        Employee: 1001,
        Date: '2026-04-26',
        StartTime: 1745658000,
        EndTime: 1745686800,
        TotalTime: 8,
        Cost: 0,
        Discarded: 0,
      },
      {
        Id: 9502,
        Employee: 1001,
        Date: '2026-04-27',
        StartTime: 1745744400,
        EndTime: 1745773200,
        TotalTime: 8,
        Cost: 0,
        Discarded: 1,
      },
      {
        Id: 9503,
        Employee: 9999,
        Date: '2026-04-28',
        StartTime: 1745830800,
        EndTime: 1745859600,
        TotalTime: 8,
        Cost: 0,
        Discarded: 0,
      },
    ]);

  const { sql } = makeSqlStub({
    employee_lookup: { '1001': 'local-emp-1' },
    upsert_inserted: { '9500': true, '9501': false },
  });

  const result = await pullTimesheets({
    access_token: 'fake',
    install_url: INSTALL_URL,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    sql_client: sql,
  });

  assert.equal(result.inserted, 1);
  assert.equal(result.updated, 1);
  assert.equal(result.skipped_unmatched, 1);
  assert.equal(result.skipped_discarded, 1);
});

test('pullTimesheets: pagination — 500-item page triggers next page', async () => {
  const page1 = Array.from({ length: 500 }, (_, i) => ({
    Id: 10000 + i,
    Employee: 1001,
    Date: '2026-04-25',
    StartTime: 1745571600,
    EndTime: 1745600400,
    TotalTime: 8,
    Cost: 0,
    Discarded: 0,
  }));
  nock(INSTALL_URL).post('/api/v1/resource/Timesheet/QUERY').reply(200, page1);
  nock(INSTALL_URL)
    .post('/api/v1/resource/Timesheet/QUERY')
    .reply(200, [
      {
        Id: 10500,
        Employee: 1001,
        Date: '2026-04-26',
        StartTime: 1745658000,
        EndTime: 1745686800,
        TotalTime: 8,
        Cost: 0,
        Discarded: 0,
      },
    ]);

  const lookup: Record<string, string> = { '1001': 'local-emp-1' };
  const upsert: Record<string, boolean> = {};
  for (let i = 0; i < 500; i++) upsert[String(10000 + i)] = true;
  upsert['10500'] = true;

  const { sql } = makeSqlStub({ employee_lookup: lookup, upsert_inserted: upsert });

  const result = await pullTimesheets({
    access_token: 'fake',
    install_url: INSTALL_URL,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    sql_client: sql,
  });

  assert.equal(result.inserted, 501);
});

test('pullTimesheets: Comment field maps to time_entry.notes', async () => {
  nock(INSTALL_URL)
    .post('/api/v1/resource/Timesheet/QUERY')
    .reply(200, [
      {
        Id: 9600,
        Employee: 1001,
        Date: '2026-04-25',
        StartTime: 1745571600,
        EndTime: 1745600400,
        TotalTime: 8,
        Cost: 0,
        Comment: 'detailed lab notes',
        Discarded: 0,
      },
    ]);

  const { sql, queries } = makeSqlStub({
    employee_lookup: { '1001': 'local-emp-1' },
    upsert_inserted: { '9600': true },
  });

  await pullTimesheets({
    access_token: 'fake',
    install_url: INSTALL_URL,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    sql_client: sql,
  });

  const insertQuery = queries[1];
  assert.ok(insertQuery);
  // notes is the last param in the INSERT.
  assert.equal(insertQuery.params[8], 'detailed lab notes');
});
