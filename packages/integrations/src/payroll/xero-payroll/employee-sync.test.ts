import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import nock from 'nock';
import { syncEmployees, type SqlClient } from './employee-sync.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000e91';
const SUBJECT_ID = '00000000-0000-4000-8000-000000000e92';
const INVITED_BY = '00000000-0000-4000-8000-000000000e93';
const XERO_TENANT_ID = '11111111-2222-3333-4444-555555555555';

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
  nock('https://api.xero.com')
    .get('/payroll.xro/1.0/Employees')
    .query({ page: '1' })
    .reply(200, {
      Employees: [
        {
          EmployeeID: '00000000-0000-0000-0000-000000000a01',
          FirstName: 'Alice',
          LastName: 'Smith',
          Email: 'alice@acme.test',
          Status: 'ACTIVE',
        },
        {
          EmployeeID: '00000000-0000-0000-0000-000000000a02',
          FirstName: 'Bob',
          LastName: 'Jones',
          Email: 'bob@acme.test',
          Status: 'ACTIVE',
          JobTitle: 'Engineer',
        },
        {
          EmployeeID: '00000000-0000-0000-0000-000000000a03',
          FirstName: 'Carol',
          LastName: 'Lee',
          Email: 'carol@acme.test',
          Status: 'ACTIVE',
        },
      ],
    });

  const { sql, queries } = makeSqlStub();
  const result = await syncEmployees({
    access_token: 'fake',
    xero_tenant_id: XERO_TENANT_ID,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    invited_by_user_id: INVITED_BY,
    sql_client: sql,
  });

  assert.equal(result.upserted, 3);
  assert.equal(result.deactivated, 0);
  assert.equal(queries.length, 3);
  assert.ok(queries.every((q) => q.sql.includes('INSERT INTO subject_tenant_employee')));
  // Verify the GUID is forwarded as-is to payroll_external_id (param index 5).
  assert.equal(queries[0]?.params[5], '00000000-0000-0000-0000-000000000a01');
  assert.equal(queries[1]?.params[5], '00000000-0000-0000-0000-000000000a02');
});

test('syncEmployees: TERMINATED status triggers a follow-up UPDATE deactivating the row', async () => {
  nock('https://api.xero.com')
    .get('/payroll.xro/1.0/Employees')
    .query({ page: '1' })
    .reply(200, {
      Employees: [
        {
          EmployeeID: '00000000-0000-0000-0000-000000000b01',
          FirstName: 'Diana',
          LastName: 'Quit',
          Email: 'diana@acme.test',
          Status: 'TERMINATED',
          EndDate: '/Date(1745539200000+0000)/',
        },
      ],
    });

  const { sql, queries } = makeSqlStub();
  const result = await syncEmployees({
    access_token: 'fake',
    xero_tenant_id: XERO_TENANT_ID,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    invited_by_user_id: INVITED_BY,
    sql_client: sql,
  });

  assert.equal(result.upserted, 1);
  assert.equal(result.deactivated, 1);
  assert.equal(queries.length, 2);
  assert.ok(queries[0]?.sql.includes('INSERT INTO subject_tenant_employee'));
  assert.ok(queries[1]?.sql.includes('UPDATE subject_tenant_employee'));
  assert.ok(queries[1]?.sql.includes('deactivated_at = NOW()'));
  assert.equal(queries[1]?.params[1], '00000000-0000-0000-0000-000000000b01');
});

test('syncEmployees: INACTIVE status also deactivates', async () => {
  nock('https://api.xero.com')
    .get('/payroll.xro/1.0/Employees')
    .query({ page: '1' })
    .reply(200, {
      Employees: [
        {
          EmployeeID: '00000000-0000-0000-0000-000000000b02',
          FirstName: 'Inactive',
          LastName: 'Person',
          Email: 'inactive@acme.test',
          Status: 'INACTIVE',
        },
      ],
    });

  const { sql, queries } = makeSqlStub();
  const result = await syncEmployees({
    access_token: 'fake',
    xero_tenant_id: XERO_TENANT_ID,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    invited_by_user_id: INVITED_BY,
    sql_client: sql,
  });

  assert.equal(result.upserted, 1);
  assert.equal(result.deactivated, 1);
  // 1 INSERT + 1 deactivation UPDATE.
  assert.equal(queries.length, 2);
  assert.ok(queries[1]?.sql.includes('UPDATE subject_tenant_employee'));
});

test('syncEmployees: skips employees with null or empty Email', async () => {
  nock('https://api.xero.com')
    .get('/payroll.xro/1.0/Employees')
    .query({ page: '1' })
    .reply(200, {
      Employees: [
        {
          EmployeeID: '00000000-0000-0000-0000-000000000c01',
          FirstName: 'NoEmail',
          LastName: 'Person',
          Email: null,
          Status: 'ACTIVE',
        },
        {
          EmployeeID: '00000000-0000-0000-0000-000000000c02',
          FirstName: 'Empty',
          LastName: 'Email',
          Email: '',
          Status: 'ACTIVE',
        },
        {
          EmployeeID: '00000000-0000-0000-0000-000000000c03',
          FirstName: 'Has',
          LastName: 'Email',
          Email: 'has@acme.test',
          Status: 'ACTIVE',
        },
      ],
    });

  const { sql, queries } = makeSqlStub();
  const result = await syncEmployees({
    access_token: 'fake',
    xero_tenant_id: XERO_TENANT_ID,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    invited_by_user_id: INVITED_BY,
    sql_client: sql,
  });

  assert.equal(result.upserted, 1);
  assert.equal(queries.length, 1);
});

test('syncEmployees: pagination — 100-item page triggers page=2 follow-up', async () => {
  // Page 1: 100 items (signals more pages).
  const page1 = Array.from({ length: 100 }, (_, i) => ({
    EmployeeID: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
    FirstName: `First${i}`,
    LastName: `Last${i}`,
    Email: `user${i}@acme.test`,
    Status: 'ACTIVE' as const,
  }));
  nock('https://api.xero.com')
    .get('/payroll.xro/1.0/Employees')
    .query({ page: '1' })
    .reply(200, { Employees: page1 });
  // Page 2: short page — ends iteration.
  nock('https://api.xero.com')
    .get('/payroll.xro/1.0/Employees')
    .query({ page: '2' })
    .reply(200, {
      Employees: [
        {
          EmployeeID: 'final-guid',
          FirstName: 'Final',
          LastName: 'Employee',
          Email: 'final@acme.test',
          Status: 'ACTIVE',
        },
      ],
    });

  const { sql, queries } = makeSqlStub();
  const result = await syncEmployees({
    access_token: 'fake',
    xero_tenant_id: XERO_TENANT_ID,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    invited_by_user_id: INVITED_BY,
    sql_client: sql,
  });

  assert.equal(result.upserted, 101);
  assert.equal(queries.length, 101);
});

test('syncEmployees: payroll_provider value in INSERT is xero_payroll + JobTitle maps to job_title', async () => {
  nock('https://api.xero.com')
    .get('/payroll.xro/1.0/Employees')
    .query({ page: '1' })
    .reply(200, {
      Employees: [
        {
          EmployeeID: '00000000-0000-0000-0000-000000000d01',
          FirstName: 'Title',
          LastName: 'Holder',
          Email: 'title@acme.test',
          Status: 'ACTIVE',
          JobTitle: 'Senior Researcher',
        },
      ],
    });

  const { sql, queries } = makeSqlStub();
  await syncEmployees({
    access_token: 'fake',
    xero_tenant_id: XERO_TENANT_ID,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    invited_by_user_id: INVITED_BY,
    sql_client: sql,
  });

  assert.equal(queries.length, 1);
  // The 'xero_payroll' literal is in the SQL string, not in the parameter list.
  assert.ok(queries[0]?.sql.includes("'xero_payroll'"));
  // params: [subject_tenant_id, tenant_id, email, name, job_title, payroll_external_id, invited_by_user_id]
  assert.equal(queries[0]?.params[4], 'Senior Researcher');
  assert.equal(queries[0]?.params[3], 'Title Holder'); // FirstName + ' ' + LastName
});
