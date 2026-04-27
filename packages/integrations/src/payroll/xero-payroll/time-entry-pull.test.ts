import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import nock from 'nock';
import { pullTimesheets } from './time-entry-pull.js';
import type { SqlClient } from './employee-sync.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000ea1';
const SUBJECT_ID = '00000000-0000-4000-8000-000000000ea2';
const XERO_TENANT_ID = '11111111-2222-3333-4444-555555555555';

/**
 * pullTimesheets issues three query shapes per non-rejected timesheet
 * (since T-B21):
 *   1. SELECT id FROM subject_tenant_employee … (once per timesheet) →
 *      returns a row when the employee is known, empty otherwise.
 *   2. INSERT … ON CONFLICT … RETURNING (xmax = 0) AS inserted
 *      (once per timesheet line) → returns `[{ inserted: true }]`
 *      for new rows, `[{ inserted: false }]` for conflict-driven
 *      updates.
 *   3. UPDATE time_entry SET flagged_at = NOW() … (once per timesheet
 *      line) → conflict resolution (T-B21): flags overlapping manual
 *      entries.
 *
 * Rejected timesheets (Status === 'REJECTED') are skipped before any
 * query runs.
 */
type StubConfig = {
  /** Map of Xero EmployeeID → local subject_tenant_employee.id. */
  employee_lookup: Record<string, string>;
  /** Map of `${TimesheetID}:${rawDate}` → whether the upsert reports inserted=true. */
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
      const xeroEmployeeId = values[1] as string;
      const localId = cfg.employee_lookup[xeroEmployeeId];
      return Promise.resolve(localId ? [{ id: localId }] : []);
    }
    if (rendered.includes('INSERT INTO time_entry')) {
      // The 'xero_payroll' source literal is in the SQL string. Tagged-template
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

test('pullTimesheets: 1 timesheet with 2 lines → 2 inserts (one per day)', async () => {
  // Two daily lines on consecutive days.
  // 2026-04-25 = 1777075200000 ms.
  // 2026-04-26 = 1777161600000 ms.
  nock('https://api.xero.com')
    .get('/payroll.xro/1.0/Timesheets')
    .query({ page: '1' })
    .reply(200, {
      Timesheets: [
        {
          TimesheetID: 'ts-1',
          EmployeeID: 'emp-guid-1',
          StartDate: '/Date(1777075200000+0000)/',
          EndDate: '/Date(1777161600000+0000)/',
          Status: 'APPROVED',
          TimesheetLines: [
            { Date: '/Date(1777075200000+0000)/', NumberOfUnits: 8 },
            { Date: '/Date(1777161600000+0000)/', NumberOfUnits: 7.5 },
          ],
        },
      ],
    });

  const { sql, queries } = makeSqlStub({
    employee_lookup: { 'emp-guid-1': 'local-emp-1' },
    upsert_inserted: {
      'ts-1:/Date(1777075200000+0000)/': true,
      'ts-1:/Date(1777161600000+0000)/': true,
    },
  });

  const result = await pullTimesheets({
    access_token: 'fake',
    xero_tenant_id: XERO_TENANT_ID,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    sql_client: sql,
  });

  assert.equal(result.inserted, 2);
  assert.equal(result.updated, 0);
  assert.equal(result.skipped_unmatched, 0);
  assert.equal(result.skipped_rejected, 0);
  // 1 SELECT + 2 INSERTs + 2 flag-UPDATEs (T-B21, one per line).
  assert.equal(queries.length, 5);
  assert.ok(queries[0]?.sql.includes('SELECT id FROM subject_tenant_employee'));
  assert.ok(queries[1]?.sql.includes('INSERT INTO time_entry'));
  assert.ok(queries[2]?.sql.includes('UPDATE time_entry'));
  assert.ok(queries[3]?.sql.includes('INSERT INTO time_entry'));
  assert.ok(queries[4]?.sql.includes('UPDATE time_entry'));
});

test('pullTimesheets: composes ISO timestamps + converts NumberOfUnits→minutes', async () => {
  // 2026-04-25T00:00:00Z = 1777075200000 ms.
  nock('https://api.xero.com')
    .get('/payroll.xro/1.0/Timesheets')
    .query({ page: '1' })
    .reply(200, {
      Timesheets: [
        {
          TimesheetID: 'ts-100',
          EmployeeID: 'emp-guid-1',
          StartDate: '/Date(1777075200000+0000)/',
          EndDate: '/Date(1777075200000+0000)/',
          Status: 'APPROVED',
          TimesheetLines: [{ Date: '/Date(1777075200000+0000)/', NumberOfUnits: 4.25 }],
        },
      ],
    });

  const { sql, queries } = makeSqlStub({
    employee_lookup: { 'emp-guid-1': 'local-emp-1' },
    upsert_inserted: {},
  });

  await pullTimesheets({
    access_token: 'fake',
    xero_tenant_id: XERO_TENANT_ID,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    sql_client: sql,
  });

  const insertQuery = queries[1];
  assert.ok(insertQuery);
  // params: [tenant_id, subject_tenant_id, employee_id, external_id,
  //          started_at, ended_at, duration_minutes, is_rd, notes]
  assert.equal(insertQuery.params[3], 'ts-100:/Date(1777075200000+0000)/');
  // Started at 00:00 UTC of the day.
  assert.equal(insertQuery.params[4], '2026-04-25T00:00:00.000Z');
  // 4.25h = 255 min → ended at 04:15 UTC the same day.
  assert.equal(insertQuery.params[5], '2026-04-25T04:15:00.000Z');
  assert.equal(insertQuery.params[6], 255);
  assert.equal(insertQuery.params[7], true);
  // notes is left null on Xero (no comment field on lines).
  assert.equal(insertQuery.params[8], null);
});

test('pullTimesheets: REJECTED timesheet skipped wholesale (no DB calls)', async () => {
  nock('https://api.xero.com')
    .get('/payroll.xro/1.0/Timesheets')
    .query({ page: '1' })
    .reply(200, {
      Timesheets: [
        {
          TimesheetID: 'ts-rejected',
          EmployeeID: 'emp-guid-1',
          StartDate: '/Date(1777075200000+0000)/',
          EndDate: '/Date(1777161600000+0000)/',
          Status: 'REJECTED',
          TimesheetLines: [{ Date: '/Date(1777075200000+0000)/', NumberOfUnits: 8 }],
        },
        {
          TimesheetID: 'ts-good',
          EmployeeID: 'emp-guid-1',
          StartDate: '/Date(1777075200000+0000)/',
          EndDate: '/Date(1777075200000+0000)/',
          Status: 'APPROVED',
          TimesheetLines: [{ Date: '/Date(1777075200000+0000)/', NumberOfUnits: 8 }],
        },
      ],
    });

  const { sql, queries } = makeSqlStub({
    employee_lookup: { 'emp-guid-1': 'local-emp-1' },
    upsert_inserted: {},
  });

  const result = await pullTimesheets({
    access_token: 'fake',
    xero_tenant_id: XERO_TENANT_ID,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    sql_client: sql,
  });

  assert.equal(result.inserted, 1);
  assert.equal(result.skipped_rejected, 1);
  // No queries for the rejected one — only the good one (SELECT +
  // INSERT + flag-UPDATE = 3).
  assert.equal(queries.length, 3);
  // Verify queries belong to the live one.
  assert.equal(queries[1]?.params[3], 'ts-good:/Date(1777075200000+0000)/');
});

test('pullTimesheets: existing row → updated=1', async () => {
  nock('https://api.xero.com')
    .get('/payroll.xro/1.0/Timesheets')
    .query({ page: '1' })
    .reply(200, {
      Timesheets: [
        {
          TimesheetID: 'ts-200',
          EmployeeID: 'emp-guid-1',
          StartDate: '/Date(1777075200000+0000)/',
          EndDate: '/Date(1777075200000+0000)/',
          Status: 'APPROVED',
          TimesheetLines: [{ Date: '/Date(1777075200000+0000)/', NumberOfUnits: 8 }],
        },
      ],
    });

  const { sql } = makeSqlStub({
    employee_lookup: { 'emp-guid-1': 'local-emp-1' },
    upsert_inserted: { 'ts-200:/Date(1777075200000+0000)/': false },
  });

  const result = await pullTimesheets({
    access_token: 'fake',
    xero_tenant_id: XERO_TENANT_ID,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    sql_client: sql,
  });

  assert.equal(result.inserted, 0);
  assert.equal(result.updated, 1);
});

test('pullTimesheets: unknown employee → skipped_unmatched, no INSERT', async () => {
  nock('https://api.xero.com')
    .get('/payroll.xro/1.0/Timesheets')
    .query({ page: '1' })
    .reply(200, {
      Timesheets: [
        {
          TimesheetID: 'ts-orphan',
          EmployeeID: 'emp-guid-unknown',
          StartDate: '/Date(1777075200000+0000)/',
          EndDate: '/Date(1777075200000+0000)/',
          Status: 'APPROVED',
          TimesheetLines: [
            { Date: '/Date(1777075200000+0000)/', NumberOfUnits: 8 },
            { Date: '/Date(1777161600000+0000)/', NumberOfUnits: 8 },
          ],
        },
      ],
    });

  const { sql, queries } = makeSqlStub({
    employee_lookup: {},
    upsert_inserted: {},
  });

  const result = await pullTimesheets({
    access_token: 'fake',
    xero_tenant_id: XERO_TENANT_ID,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    sql_client: sql,
  });

  assert.equal(result.inserted, 0);
  assert.equal(result.updated, 0);
  // The orphan increments skipped_unmatched once at the timesheet
  // level — even though it had two lines, the lookup short-circuits
  // before iterating lines.
  assert.equal(result.skipped_unmatched, 1);
  // Only the one SELECT — no INSERT.
  assert.equal(queries.length, 1);
  assert.ok(queries[0]?.sql.includes("'xero_payroll'"));
  assert.equal(queries[0]?.params[1], 'emp-guid-unknown');
});

test('pullTimesheets: unparseable Date in TimesheetLine is skipped, others continue', async () => {
  nock('https://api.xero.com')
    .get('/payroll.xro/1.0/Timesheets')
    .query({ page: '1' })
    .reply(200, {
      Timesheets: [
        {
          TimesheetID: 'ts-mixed',
          EmployeeID: 'emp-guid-1',
          StartDate: '/Date(1777075200000+0000)/',
          EndDate: '/Date(1777161600000+0000)/',
          Status: 'APPROVED',
          TimesheetLines: [
            { Date: 'not-a-date', NumberOfUnits: 8 },
            { Date: '/Date(1777161600000+0000)/', NumberOfUnits: 8 },
          ],
        },
      ],
    });

  const { sql, queries } = makeSqlStub({
    employee_lookup: { 'emp-guid-1': 'local-emp-1' },
    upsert_inserted: {},
  });

  const result = await pullTimesheets({
    access_token: 'fake',
    xero_tenant_id: XERO_TENANT_ID,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    sql_client: sql,
  });

  // Only the parseable line was inserted.
  assert.equal(result.inserted, 1);
  // 1 SELECT + 1 INSERT + 1 flag-UPDATE (the bad line is silently
  // skipped before either of those run).
  assert.equal(queries.length, 3);
});

test('pullTimesheets: TimesheetLines absent → 0 inserts but timesheet still resolved', async () => {
  nock('https://api.xero.com')
    .get('/payroll.xro/1.0/Timesheets')
    .query({ page: '1' })
    .reply(200, {
      Timesheets: [
        {
          TimesheetID: 'ts-empty',
          EmployeeID: 'emp-guid-1',
          StartDate: '/Date(1777075200000+0000)/',
          EndDate: '/Date(1777075200000+0000)/',
          Status: 'APPROVED',
          // TimesheetLines deliberately omitted.
        },
      ],
    });

  const { sql, queries } = makeSqlStub({
    employee_lookup: { 'emp-guid-1': 'local-emp-1' },
    upsert_inserted: {},
  });

  const result = await pullTimesheets({
    access_token: 'fake',
    xero_tenant_id: XERO_TENANT_ID,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    sql_client: sql,
  });

  assert.equal(result.inserted, 0);
  assert.equal(result.updated, 0);
  assert.equal(result.skipped_unmatched, 0);
  // Only the SELECT — nothing to insert.
  assert.equal(queries.length, 1);
});

test('pullTimesheets: pagination — 100-item page triggers page=2', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({
    TimesheetID: `ts-p1-${i}`,
    EmployeeID: 'emp-guid-1',
    StartDate: '/Date(1777075200000+0000)/',
    EndDate: '/Date(1777075200000+0000)/',
    Status: 'APPROVED' as const,
    TimesheetLines: [{ Date: '/Date(1777075200000+0000)/', NumberOfUnits: 8 }],
  }));
  nock('https://api.xero.com')
    .get('/payroll.xro/1.0/Timesheets')
    .query({ page: '1' })
    .reply(200, { Timesheets: page1 });
  nock('https://api.xero.com')
    .get('/payroll.xro/1.0/Timesheets')
    .query({ page: '2' })
    .reply(200, {
      Timesheets: [
        {
          TimesheetID: 'ts-p2-0',
          EmployeeID: 'emp-guid-1',
          StartDate: '/Date(1777161600000+0000)/',
          EndDate: '/Date(1777161600000+0000)/',
          Status: 'APPROVED',
          TimesheetLines: [{ Date: '/Date(1777161600000+0000)/', NumberOfUnits: 8 }],
        },
      ],
    });

  const { sql } = makeSqlStub({
    employee_lookup: { 'emp-guid-1': 'local-emp-1' },
    upsert_inserted: {},
  });

  const result = await pullTimesheets({
    access_token: 'fake',
    xero_tenant_id: XERO_TENANT_ID,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    sql_client: sql,
  });

  // 100 timesheets x 1 line each + 1 follow-up timesheet x 1 line.
  assert.equal(result.inserted, 101);
});

test('pullTimesheets: T-B21 — manual entry overlapping payroll → flag UPDATE fires per inserted line', async () => {
  // Single timesheet with one line. 2026-04-25 = 1777075200000 ms.
  // Synthesised window is 00:00 + 8h = 08:00 UTC.
  nock('https://api.xero.com')
    .get('/payroll.xro/1.0/Timesheets')
    .query({ page: '1' })
    .reply(200, {
      Timesheets: [
        {
          TimesheetID: 'ts-conflict',
          EmployeeID: 'emp-guid-1',
          StartDate: '/Date(1777075200000+0000)/',
          EndDate: '/Date(1777075200000+0000)/',
          Status: 'APPROVED',
          TimesheetLines: [{ Date: '/Date(1777075200000+0000)/', NumberOfUnits: 8 }],
        },
      ],
    });

  const { sql, queries } = makeSqlStub({
    employee_lookup: { 'emp-guid-1': 'local-emp-1' },
    upsert_inserted: { 'ts-conflict:/Date(1777075200000+0000)/': true },
    flagged_manual_ids: { 'local-emp-1': ['manual-overlap-1'] },
  });

  await pullTimesheets({
    access_token: 'fake',
    xero_tenant_id: XERO_TENANT_ID,
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
  // Xero synthesises 00:00 UTC start + duration-based end.
  assert.equal(flagQuery.params[1], 'local-emp-1');
  assert.equal(flagQuery.params[2], '2026-04-25T00:00:00.000Z');
  assert.equal(flagQuery.params[3], '2026-04-25T08:00:00.000Z');
});
