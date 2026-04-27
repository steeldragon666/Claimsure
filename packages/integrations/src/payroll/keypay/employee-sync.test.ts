import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import nock from 'nock';
import { syncEmployees, type SqlClient } from './employee-sync.js';

const BUSINESS_ID = 7777;
const TENANT_ID = '00000000-0000-4000-8000-000000000c91';
const SUBJECT_ID = '00000000-0000-4000-8000-000000000c92';
const INVITED_BY = '00000000-0000-4000-8000-000000000c93';

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
  nock('https://api.yourpayroll.com.au')
    .get(`/api/v2/business/${BUSINESS_ID}/employee`)
    .query(true)
    .reply(200, [
      {
        id: 1001,
        firstName: 'Alice',
        surname: 'Smith',
        email: 'alice@acme.test',
        startDate: '2024-01-15',
        status: 'Active',
      },
      {
        id: 1002,
        firstName: 'Bob',
        surname: 'Jones',
        email: 'bob@acme.test',
        jobTitle: 'Engineer',
        startDate: '2024-03-01',
        status: 'Active',
      },
      {
        id: 1003,
        firstName: 'Carol',
        surname: 'Lee',
        email: 'carol@acme.test',
        startDate: '2024-05-01',
        status: 'Active',
      },
    ]);

  const { sql, queries } = makeSqlStub();
  const result = await syncEmployees({
    api_key: 'fake',
    business_id: BUSINESS_ID,
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
  // Verify numeric id is coerced to string for payroll_external_id (param index 5).
  assert.equal(queries[0]?.params[5], '1001');
  assert.equal(queries[1]?.params[5], '1002');
});

test('syncEmployees: Terminated status triggers a follow-up UPDATE', async () => {
  nock('https://api.yourpayroll.com.au')
    .get(`/api/v2/business/${BUSINESS_ID}/employee`)
    .query(true)
    .reply(200, [
      {
        id: 2001,
        firstName: 'Diana',
        surname: 'Quit',
        email: 'diana@acme.test',
        startDate: '2023-06-01',
        endDate: '2026-04-01',
        status: 'Terminated',
      },
    ]);

  const { sql, queries } = makeSqlStub();
  const result = await syncEmployees({
    api_key: 'fake',
    business_id: BUSINESS_ID,
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
  // The deactivation UPDATE should target the stringified KeyPay id.
  assert.equal(queries[1]?.params[1], '2001');
});

test('syncEmployees: skips employees with null or empty email', async () => {
  nock('https://api.yourpayroll.com.au')
    .get(`/api/v2/business/${BUSINESS_ID}/employee`)
    .query(true)
    .reply(200, [
      {
        id: 3001,
        firstName: 'NoEmail',
        surname: 'Person',
        email: null,
        startDate: '2024-01-01',
        status: 'Active',
      },
      {
        id: 3002,
        firstName: 'Empty',
        surname: 'Email',
        email: '',
        startDate: '2024-01-01',
        status: 'Active',
      },
      {
        id: 3003,
        firstName: 'Has',
        surname: 'Email',
        email: 'has@acme.test',
        startDate: '2024-01-01',
        status: 'Active',
      },
    ]);

  const { sql, queries } = makeSqlStub();
  const result = await syncEmployees({
    api_key: 'fake',
    business_id: BUSINESS_ID,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    invited_by_user_id: INVITED_BY,
    sql_client: sql,
  });

  assert.equal(result.upserted, 1);
  assert.equal(queries.length, 1);
});

test('syncEmployees: pagination — 100-item page triggers cursor=2 follow-up', async () => {
  // Page 1: 100 items (signals more pages).
  const page1 = Array.from({ length: 100 }, (_, i) => ({
    id: 4000 + i,
    firstName: `First${i}`,
    surname: `Last${i}`,
    email: `user${i}@acme.test`,
    startDate: '2024-01-01',
    status: 'Active' as const,
  }));
  nock('https://api.yourpayroll.com.au')
    .get(`/api/v2/business/${BUSINESS_ID}/employee`)
    .query({ skip: '0', top: '100' })
    .reply(200, page1);
  // Page 2: short page — ends iteration.
  nock('https://api.yourpayroll.com.au')
    .get(`/api/v2/business/${BUSINESS_ID}/employee`)
    .query({ skip: '100', top: '100' })
    .reply(200, [
      {
        id: 4100,
        firstName: 'Final',
        surname: 'Employee',
        email: 'final@acme.test',
        startDate: '2024-02-01',
        status: 'Active',
      },
    ]);

  const { sql, queries } = makeSqlStub();
  const result = await syncEmployees({
    api_key: 'fake',
    business_id: BUSINESS_ID,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    invited_by_user_id: INVITED_BY,
    sql_client: sql,
  });

  assert.equal(result.upserted, 101);
  assert.equal(queries.length, 101);
});

test('syncEmployees: empty page → upserted=0, no queries issued', async () => {
  nock('https://api.yourpayroll.com.au')
    .get(`/api/v2/business/${BUSINESS_ID}/employee`)
    .query(true)
    .reply(200, []);

  const { sql, queries } = makeSqlStub();
  const result = await syncEmployees({
    api_key: 'fake',
    business_id: BUSINESS_ID,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    invited_by_user_id: INVITED_BY,
    sql_client: sql,
  });

  assert.equal(result.upserted, 0);
  assert.equal(result.deactivated, 0);
  assert.equal(queries.length, 0);
});

test('syncEmployees: payroll_provider value in INSERT is keypay', async () => {
  nock('https://api.yourpayroll.com.au')
    .get(`/api/v2/business/${BUSINESS_ID}/employee`)
    .query(true)
    .reply(200, [
      {
        id: 5001,
        firstName: 'Sole',
        surname: 'Employee',
        email: 'sole@acme.test',
        startDate: '2024-01-01',
        status: 'Active',
      },
    ]);

  const { sql, queries } = makeSqlStub();
  await syncEmployees({
    api_key: 'fake',
    business_id: BUSINESS_ID,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    invited_by_user_id: INVITED_BY,
    sql_client: sql,
  });

  // The 'keypay' literal is in the SQL string, not in the parameter list.
  assert.equal(queries.length, 1);
  assert.ok(queries[0]?.sql.includes("'keypay'"));
});
