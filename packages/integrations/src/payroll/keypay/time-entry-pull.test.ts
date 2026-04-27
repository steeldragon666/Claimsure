import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import nock from 'nock';
import { pullTimesheets } from './time-entry-pull.js';
import type { SqlClient } from './employee-sync.js';

const BUSINESS_ID = 8888;
const TENANT_ID = '00000000-0000-4000-8000-000000000ca1';
const SUBJECT_ID = '00000000-0000-4000-8000-000000000ca2';

/**
 * pullTimesheets issues three query shapes per timesheet (since T-B21):
 *   1. SELECT id FROM subject_tenant_employee … → returns a row when
 *      the employee is known, empty when unmatched.
 *   2. INSERT … ON CONFLICT … RETURNING (xmax = 0) AS inserted →
 *      returns `[{ inserted: true }]` for new rows, `[{ inserted: false }]`
 *      for conflict-driven updates.
 *   3. UPDATE time_entry SET flagged_at = NOW() … → conflict resolution
 *      (T-B21): flags overlapping manual entries.
 */
type StubConfig = {
  /** Map of stringified KeyPay employeeId → local subject_tenant_employee.id. */
  employee_lookup: Record<string, string>;
  /** Map of stringified KeyPay timesheet id → whether the upsert reports inserted=true. */
  upsert_inserted: Record<string, boolean>;
  /** Optional: map of local employee_id → manual ids the flag UPDATE should report. */
  flagged_manual_ids?: Record<string, string[]>;
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
      // The 'keypay' source literal is in the SQL string. Tagged-template
      // values: [tenant_id, subject_tenant_id, employee_id, external_id,
      // started_at, ended_at, duration_minutes, is_rd, notes].
      const externalId = values[3] as string;
      const inserted = cfg.upsert_inserted[externalId] ?? true;
      return Promise.resolve([{ inserted }]);
    }
    if (rendered.includes('UPDATE time_entry') && rendered.includes('flagged_at')) {
      // T-B21 flag UPDATE. Params: [subject_tenant_id, employee_id,
      // period_start, period_end].
      const localEmpId = values[1] as string;
      const ids = cfg.flagged_manual_ids?.[localEmpId] ?? [];
      return Promise.resolve(ids.map((id) => ({ id })));
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
  nock('https://api.yourpayroll.com.au')
    .get(`/api/v2/business/${BUSINESS_ID}/timesheet`)
    .query(true)
    .reply(200, [
      {
        id: 9001,
        employeeId: 1001,
        date: '2026-04-25',
        startTime: '09:00',
        endTime: '17:00',
        units: 8,
        status: 'Approved',
      },
      {
        id: 9002,
        employeeId: 1001,
        date: '2026-04-26',
        startTime: '09:00',
        endTime: '17:00',
        units: 8,
        status: 'Approved',
      },
      {
        id: 9003,
        employeeId: 1002,
        date: '2026-04-25',
        startTime: '10:00',
        endTime: '16:00',
        units: 6,
        status: 'Submitted',
        comments: 'lab work',
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
    api_key: 'fake',
    business_id: BUSINESS_ID,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    sql_client: sql,
  });

  assert.equal(result.inserted, 3);
  assert.equal(result.updated, 0);
  assert.equal(result.skipped_unmatched, 0);
  // 3 SELECTs + 3 INSERTs + 3 flag-UPDATEs (T-B21).
  assert.equal(queries.length, 9);
});

test('pullTimesheets: composes ISO timestamps from date + HH:MM and converts units→minutes', async () => {
  nock('https://api.yourpayroll.com.au')
    .get(`/api/v2/business/${BUSINESS_ID}/timesheet`)
    .query(true)
    .reply(200, [
      {
        id: 9100,
        employeeId: 1001,
        date: '2026-04-25',
        startTime: '08:30',
        endTime: '12:45',
        units: 4.25,
        status: 'Approved',
      },
    ]);

  const { sql, queries } = makeSqlStub({
    employee_lookup: { '1001': 'local-emp-1' },
    upsert_inserted: { '9100': true },
  });

  await pullTimesheets({
    api_key: 'fake',
    business_id: BUSINESS_ID,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    sql_client: sql,
  });

  // Last query is the INSERT. Verify the composed timestamps + minutes.
  const insertQuery = queries[1];
  assert.ok(insertQuery);
  // params: [tenant_id, subject_tenant_id, employee_id, external_id,
  //          started_at, ended_at, duration_minutes, is_rd, notes]
  assert.equal(insertQuery.params[3], '9100');
  assert.equal(insertQuery.params[4], '2026-04-25T08:30:00Z');
  assert.equal(insertQuery.params[5], '2026-04-25T12:45:00Z');
  // 4.25 hours × 60 = 255 minutes.
  assert.equal(insertQuery.params[6], 255);
  assert.equal(insertQuery.params[7], true);
});

test('pullTimesheets: existing row → updated=1', async () => {
  nock('https://api.yourpayroll.com.au')
    .get(`/api/v2/business/${BUSINESS_ID}/timesheet`)
    .query(true)
    .reply(200, [
      {
        id: 9200,
        employeeId: 1001,
        date: '2026-04-25',
        startTime: '09:00',
        endTime: '17:00',
        units: 8,
        status: 'Approved',
      },
    ]);

  const { sql } = makeSqlStub({
    employee_lookup: { '1001': 'local-emp-1' },
    upsert_inserted: { '9200': false },
  });

  const result = await pullTimesheets({
    api_key: 'fake',
    business_id: BUSINESS_ID,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    sql_client: sql,
  });

  assert.equal(result.inserted, 0);
  assert.equal(result.updated, 1);
  assert.equal(result.skipped_unmatched, 0);
});

test('pullTimesheets: unknown employee → skipped_unmatched, no INSERT', async () => {
  nock('https://api.yourpayroll.com.au')
    .get(`/api/v2/business/${BUSINESS_ID}/timesheet`)
    .query(true)
    .reply(200, [
      {
        id: 9300,
        employeeId: 9999,
        date: '2026-04-25',
        startTime: '09:00',
        endTime: '17:00',
        units: 8,
        status: 'Approved',
      },
    ]);

  const { sql, queries } = makeSqlStub({
    employee_lookup: {},
    upsert_inserted: {},
  });

  const result = await pullTimesheets({
    api_key: 'fake',
    business_id: BUSINESS_ID,
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
  // Confirm the keypay provider filter is in the SQL.
  assert.ok(queries[0]?.sql.includes("'keypay'"));
});

test('pullTimesheets: mixed — 1 new + 1 existing + 1 orphan', async () => {
  nock('https://api.yourpayroll.com.au')
    .get(`/api/v2/business/${BUSINESS_ID}/timesheet`)
    .query(true)
    .reply(200, [
      {
        id: 9400,
        employeeId: 1001,
        date: '2026-04-25',
        startTime: '09:00',
        endTime: '17:00',
        units: 8,
        status: 'Approved',
      },
      {
        id: 9401,
        employeeId: 1001,
        date: '2026-04-26',
        startTime: '09:00',
        endTime: '17:00',
        units: 8,
        status: 'Approved',
      },
      {
        id: 9402,
        employeeId: 9999,
        date: '2026-04-25',
        startTime: '09:00',
        endTime: '17:00',
        units: 8,
        status: 'Approved',
      },
    ]);

  const { sql } = makeSqlStub({
    employee_lookup: { '1001': 'local-emp-1' },
    upsert_inserted: { '9400': true, '9401': false },
  });

  const result = await pullTimesheets({
    api_key: 'fake',
    business_id: BUSINESS_ID,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    sql_client: sql,
  });

  assert.equal(result.inserted, 1);
  assert.equal(result.updated, 1);
  assert.equal(result.skipped_unmatched, 1);
});

test('pullTimesheets: pagination — 100-item page triggers next page', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({
    id: 10000 + i,
    employeeId: 1001,
    date: '2026-04-25',
    startTime: '09:00',
    endTime: '17:00',
    units: 8,
    status: 'Approved' as const,
  }));
  nock('https://api.yourpayroll.com.au')
    .get(`/api/v2/business/${BUSINESS_ID}/timesheet`)
    .query({ skip: '0', top: '100' })
    .reply(200, page1);
  nock('https://api.yourpayroll.com.au')
    .get(`/api/v2/business/${BUSINESS_ID}/timesheet`)
    .query({ skip: '100', top: '100' })
    .reply(200, [
      {
        id: 10100,
        employeeId: 1001,
        date: '2026-04-26',
        startTime: '09:00',
        endTime: '17:00',
        units: 8,
        status: 'Approved',
      },
    ]);

  const lookup: Record<string, string> = { '1001': 'local-emp-1' };
  const upsert: Record<string, boolean> = {};
  for (let i = 0; i < 100; i++) upsert[String(10000 + i)] = true;
  upsert['10100'] = true;

  const { sql } = makeSqlStub({ employee_lookup: lookup, upsert_inserted: upsert });

  const result = await pullTimesheets({
    api_key: 'fake',
    business_id: BUSINESS_ID,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    sql_client: sql,
  });

  assert.equal(result.inserted, 101);
});

test('pullTimesheets: comments field maps to time_entry.notes', async () => {
  nock('https://api.yourpayroll.com.au')
    .get(`/api/v2/business/${BUSINESS_ID}/timesheet`)
    .query(true)
    .reply(200, [
      {
        id: 9500,
        employeeId: 1001,
        date: '2026-04-25',
        startTime: '09:00',
        endTime: '17:00',
        units: 8,
        status: 'Approved',
        comments: 'detailed lab notes',
      },
    ]);

  const { sql, queries } = makeSqlStub({
    employee_lookup: { '1001': 'local-emp-1' },
    upsert_inserted: { '9500': true },
  });

  await pullTimesheets({
    api_key: 'fake',
    business_id: BUSINESS_ID,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    sql_client: sql,
  });

  const insertQuery = queries[1];
  assert.ok(insertQuery);
  // notes is the last param in the INSERT.
  assert.equal(insertQuery.params[8], 'detailed lab notes');
});

test('pullTimesheets: T-B21 — manual entry overlapping payroll → flag UPDATE fires for the inserted row', async () => {
  nock('https://api.yourpayroll.com.au')
    .get(`/api/v2/business/${BUSINESS_ID}/timesheet`)
    .query(true)
    .reply(200, [
      {
        id: 9600,
        employeeId: 1001,
        date: '2026-04-25',
        startTime: '09:00',
        endTime: '17:00',
        units: 8,
        status: 'Approved',
      },
    ]);

  const { sql, queries } = makeSqlStub({
    employee_lookup: { '1001': 'local-emp-1' },
    upsert_inserted: { '9600': true },
    flagged_manual_ids: { 'local-emp-1': ['manual-overlap-1'] },
  });

  await pullTimesheets({
    api_key: 'fake',
    business_id: BUSINESS_ID,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    sql_client: sql,
  });

  // 1 SELECT + 1 INSERT + 1 flag-UPDATE.
  assert.equal(queries.length, 3);
  const flagQuery = queries[2];
  assert.ok(flagQuery);
  assert.ok(flagQuery.sql.includes('UPDATE time_entry'));
  assert.ok(flagQuery.sql.includes('flagged_at'));
  // Params: [subject_tenant_id, employee_id, period_start, period_end].
  // KeyPay composes ISO timestamps from date + HH:MM strings.
  assert.equal(flagQuery.params[1], 'local-emp-1');
  assert.equal(flagQuery.params[2], '2026-04-25T09:00:00Z');
  assert.equal(flagQuery.params[3], '2026-04-25T17:00:00Z');
});

test('pullTimesheets: forwards changed_since + date filters to KeyPay', async () => {
  const since = new Date('2026-04-20T00:00:00Z');
  const from = new Date('2026-04-01T00:00:00Z');
  const to = new Date('2026-04-30T23:59:59Z');
  nock('https://api.yourpayroll.com.au')
    .get(`/api/v2/business/${BUSINESS_ID}/timesheet`)
    .query({
      fromDate: '2026-04-01',
      toDate: '2026-04-30',
      updatedAfter: since.toISOString(),
      skip: '0',
      top: '100',
    })
    .reply(200, []);

  const { sql } = makeSqlStub({ employee_lookup: {}, upsert_inserted: {} });
  const result = await pullTimesheets({
    api_key: 'fake',
    business_id: BUSINESS_ID,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    changed_since: since,
    from_date: from,
    to_date: to,
    sql_client: sql,
  });
  assert.equal(result.inserted, 0);
});
