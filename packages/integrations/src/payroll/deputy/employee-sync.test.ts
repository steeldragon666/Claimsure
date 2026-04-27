import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import nock from 'nock';
import { syncEmployees, type SqlClient } from './employee-sync.js';

const INSTALL_URL = 'https://acme.deputy.com';
const TENANT_ID = '00000000-0000-4000-8000-000000000d91';
const SUBJECT_ID = '00000000-0000-4000-8000-000000000d92';
const INVITED_BY = '00000000-0000-4000-8000-000000000d93';

/**
 * Stub mirrors the postgres-js template-tag callable. We collect every
 * (strings, values) pair so tests can assert the shape of each query
 * without round-tripping through real Postgres.
 */
type CapturedQuery = { sql: string; params: unknown[] };

function makeSqlStub(): { sql: SqlClient; queries: CapturedQuery[] } {
  const queries: CapturedQuery[] = [];
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    queries.push({ sql: strings.join('?'), params: values });
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

test('syncEmployees: 3 active employees → upserted=3, deactivated=0', async () => {
  nock(INSTALL_URL)
    .post('/api/v1/resource/Employee/QUERY')
    .reply(200, [
      {
        Id: 1001,
        DisplayName: 'Alice Smith',
        FirstName: 'Alice',
        LastName: 'Smith',
        Email: 'alice@acme.test',
        EmployeeStartDate: '2024-01-15',
        Active: 1,
      },
      {
        Id: 1002,
        DisplayName: 'Bob Jones',
        FirstName: 'Bob',
        LastName: 'Jones',
        Email: 'bob@acme.test',
        Position: 'Engineer',
        EmployeeStartDate: '2024-03-01',
        Active: 1,
      },
      {
        Id: 1003,
        DisplayName: 'Carol Lee',
        FirstName: 'Carol',
        LastName: 'Lee',
        Email: 'carol@acme.test',
        EmployeeStartDate: '2024-05-01',
        Active: 1,
      },
    ]);

  const { sql, queries } = makeSqlStub();
  const result = await syncEmployees({
    access_token: 'fake',
    install_url: INSTALL_URL,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    invited_by_user_id: INVITED_BY,
    sql_client: sql,
  });

  assert.equal(result.upserted, 3);
  assert.equal(result.deactivated, 0);
  // 3 INSERT statements, no UPDATE.
  assert.equal(queries.length, 3);
  assert.ok(queries.every((q) => q.sql.includes('INSERT INTO subject_tenant_employee')));
  // Verify numeric Id is coerced to string for payroll_external_id (param index 5).
  assert.equal(queries[0]?.params[5], '1001');
  assert.equal(queries[1]?.params[5], '1002');
});

test('syncEmployees: Active === 0 triggers a follow-up UPDATE deactivating the row', async () => {
  nock(INSTALL_URL)
    .post('/api/v1/resource/Employee/QUERY')
    .reply(200, [
      {
        Id: 2001,
        DisplayName: 'Diana Quit',
        FirstName: 'Diana',
        LastName: 'Quit',
        Email: 'diana@acme.test',
        EmployeeStartDate: '2023-06-01',
        EmployeeTerminationDate: '2026-04-01',
        Active: 0,
      },
    ]);

  const { sql, queries } = makeSqlStub();
  const result = await syncEmployees({
    access_token: 'fake',
    install_url: INSTALL_URL,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    invited_by_user_id: INVITED_BY,
    sql_client: sql,
  });

  assert.equal(result.upserted, 1);
  assert.equal(result.deactivated, 1);
  // 1 INSERT + 1 UPDATE (deactivation).
  assert.equal(queries.length, 2);
  assert.ok(queries[0]?.sql.includes('INSERT INTO subject_tenant_employee'));
  assert.ok(queries[1]?.sql.includes('UPDATE subject_tenant_employee'));
  assert.ok(queries[1]?.sql.includes('deactivated_at = NOW()'));
  // The deactivation UPDATE should target the stringified Deputy id.
  assert.equal(queries[1]?.params[1], '2001');
});

test('syncEmployees: skips employees with null or empty Email', async () => {
  nock(INSTALL_URL)
    .post('/api/v1/resource/Employee/QUERY')
    .reply(200, [
      {
        Id: 3001,
        DisplayName: 'NoEmail Person',
        FirstName: 'NoEmail',
        LastName: 'Person',
        Email: null,
        EmployeeStartDate: '2024-01-01',
        Active: 1,
      },
      {
        Id: 3002,
        DisplayName: 'Empty Email',
        FirstName: 'Empty',
        LastName: 'Email',
        Email: '',
        EmployeeStartDate: '2024-01-01',
        Active: 1,
      },
      {
        Id: 3003,
        DisplayName: 'Has Email',
        FirstName: 'Has',
        LastName: 'Email',
        Email: 'has@acme.test',
        EmployeeStartDate: '2024-01-01',
        Active: 1,
      },
    ]);

  const { sql, queries } = makeSqlStub();
  const result = await syncEmployees({
    access_token: 'fake',
    install_url: INSTALL_URL,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    invited_by_user_id: INVITED_BY,
    sql_client: sql,
  });

  assert.equal(result.upserted, 1);
  assert.equal(queries.length, 1);
});

test('syncEmployees: pagination — 500-item page triggers cursor=500 follow-up', async () => {
  // Page 1: 500 items (signals more pages).
  const page1 = Array.from({ length: 500 }, (_, i) => ({
    Id: 4000 + i,
    DisplayName: `User ${i}`,
    FirstName: `First${i}`,
    LastName: `Last${i}`,
    Email: `user${i}@acme.test`,
    EmployeeStartDate: '2024-01-01',
    Active: 1,
  }));
  nock(INSTALL_URL).post('/api/v1/resource/Employee/QUERY').reply(200, page1);
  // Page 2: short page — ends iteration.
  nock(INSTALL_URL)
    .post('/api/v1/resource/Employee/QUERY')
    .reply(200, [
      {
        Id: 4500,
        DisplayName: 'Final Employee',
        FirstName: 'Final',
        LastName: 'Employee',
        Email: 'final@acme.test',
        EmployeeStartDate: '2024-02-01',
        Active: 1,
      },
    ]);

  const { sql, queries } = makeSqlStub();
  const result = await syncEmployees({
    access_token: 'fake',
    install_url: INSTALL_URL,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    invited_by_user_id: INVITED_BY,
    sql_client: sql,
  });

  assert.equal(result.upserted, 501);
  assert.equal(queries.length, 501);
});

test('syncEmployees: empty page → upserted=0, no queries issued', async () => {
  nock(INSTALL_URL).post('/api/v1/resource/Employee/QUERY').reply(200, []);

  const { sql, queries } = makeSqlStub();
  const result = await syncEmployees({
    access_token: 'fake',
    install_url: INSTALL_URL,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    invited_by_user_id: INVITED_BY,
    sql_client: sql,
  });

  assert.equal(result.upserted, 0);
  assert.equal(result.deactivated, 0);
  assert.equal(queries.length, 0);
});

test('syncEmployees: payroll_provider value in INSERT is deputy', async () => {
  nock(INSTALL_URL)
    .post('/api/v1/resource/Employee/QUERY')
    .reply(200, [
      {
        Id: 5001,
        DisplayName: 'Sole Employee',
        FirstName: 'Sole',
        LastName: 'Employee',
        Email: 'sole@acme.test',
        EmployeeStartDate: '2024-01-01',
        Active: 1,
      },
    ]);

  const { sql, queries } = makeSqlStub();
  await syncEmployees({
    access_token: 'fake',
    install_url: INSTALL_URL,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    invited_by_user_id: INVITED_BY,
    sql_client: sql,
  });

  // The 'deputy' literal is in the SQL string, not in the parameter list.
  assert.equal(queries.length, 1);
  assert.ok(queries[0]?.sql.includes("'deputy'"));
});

test('syncEmployees: Position field maps to job_title (4th INSERT param)', async () => {
  nock(INSTALL_URL)
    .post('/api/v1/resource/Employee/QUERY')
    .reply(200, [
      {
        Id: 6001,
        DisplayName: 'Title Holder',
        FirstName: 'Title',
        LastName: 'Holder',
        Email: 'title@acme.test',
        EmployeeStartDate: '2024-01-01',
        Active: 1,
        Position: 'Senior Researcher',
      },
    ]);

  const { sql, queries } = makeSqlStub();
  await syncEmployees({
    access_token: 'fake',
    install_url: INSTALL_URL,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    invited_by_user_id: INVITED_BY,
    sql_client: sql,
  });

  // params: [subject_tenant_id, tenant_id, email, name, job_title, payroll_external_id, invited_by_user_id]
  assert.equal(queries[0]?.params[4], 'Senior Researcher');
});
