import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import nock from 'nock';
import { syncEmployees, type SqlClient } from './employee-sync.js';

const ORG_ID = 'org-eh-sync';
const TENANT_ID = '00000000-0000-4000-8000-000000000b91';
const SUBJECT_ID = '00000000-0000-4000-8000-000000000b92';
const INVITED_BY = '00000000-0000-4000-8000-000000000b93';

/**
 * Lightweight stub mimicking postgres-js's template-tag callable. We
 * collect every (strings, values) pair so tests can assert how many
 * INSERT vs UPDATE statements ran without round-tripping through real
 * Postgres.
 *
 * The `sql.begin` field is unused by syncEmployees (it issues plain
 * tagged-template calls) so we don't model it.
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

test('syncEmployees: 3 employees on a single page → upserted=3, deactivated=0', async () => {
  nock('https://api.employmenthero.com')
    .get(`/api/v1/organisations/${ORG_ID}/employees`)
    .reply(200, {
      data: [
        {
          id: 'eh-1',
          first_name: 'Alice',
          surname: 'Smith',
          work_email: 'alice@acme.test',
          start_date: '2024-01-15',
          organisation_id: ORG_ID,
          status: 'active',
        },
        {
          id: 'eh-2',
          first_name: 'Bob',
          surname: 'Jones',
          work_email: 'bob@acme.test',
          job_title: 'Engineer',
          start_date: '2024-03-01',
          organisation_id: ORG_ID,
          status: 'active',
        },
        {
          id: 'eh-3',
          first_name: 'Carol',
          surname: 'Lee',
          work_email: 'carol@acme.test',
          start_date: '2024-05-01',
          organisation_id: ORG_ID,
          status: 'pending',
        },
      ],
    });

  const { sql, queries } = makeSqlStub();
  const result = await syncEmployees({
    access_token: 'fake',
    organisation_id: ORG_ID,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    invited_by_user_id: INVITED_BY,
    sql_client: sql,
  });

  assert.equal(result.upserted, 3);
  assert.equal(result.deactivated, 0);
  // 3 INSERT...ON CONFLICT statements, zero UPDATE statements.
  assert.equal(queries.length, 3);
  assert.ok(
    queries.every((q) => q.sql.startsWith('\n        INSERT INTO subject_tenant_employee')),
  );
});

test('syncEmployees: terminated status triggers a follow-up UPDATE deactivating the row', async () => {
  nock('https://api.employmenthero.com')
    .get(`/api/v1/organisations/${ORG_ID}/employees`)
    .reply(200, {
      data: [
        {
          id: 'eh-term-1',
          first_name: 'Diana',
          surname: 'Quit',
          work_email: 'diana@acme.test',
          start_date: '2023-06-01',
          termination_date: '2026-04-01',
          organisation_id: ORG_ID,
          status: 'terminated',
        },
      ],
    });

  const { sql, queries } = makeSqlStub();
  const result = await syncEmployees({
    access_token: 'fake',
    organisation_id: ORG_ID,
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
});

test('syncEmployees: pagination — walks two pages and visits every employee', async () => {
  nock('https://api.employmenthero.com')
    .get(`/api/v1/organisations/${ORG_ID}/employees`)
    .reply(200, {
      data: [
        {
          id: 'eh-p1-1',
          first_name: 'Page',
          surname: 'One',
          work_email: 'p1-1@acme.test',
          start_date: '2024-01-01',
          organisation_id: ORG_ID,
          status: 'active',
        },
        {
          id: 'eh-p1-2',
          first_name: 'Page',
          surname: 'OneTwo',
          work_email: 'p1-2@acme.test',
          start_date: '2024-01-02',
          organisation_id: ORG_ID,
          status: 'active',
        },
      ],
      meta: { next_cursor: 'cur-page-2' },
    });
  nock('https://api.employmenthero.com')
    .get(`/api/v1/organisations/${ORG_ID}/employees`)
    .query({ cursor: 'cur-page-2' })
    .reply(200, {
      data: [
        {
          id: 'eh-p2-1',
          first_name: 'Page',
          surname: 'Two',
          work_email: 'p2-1@acme.test',
          start_date: '2024-02-01',
          organisation_id: ORG_ID,
          status: 'active',
        },
      ],
    });

  const { sql, queries } = makeSqlStub();
  const result = await syncEmployees({
    access_token: 'fake',
    organisation_id: ORG_ID,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    invited_by_user_id: INVITED_BY,
    sql_client: sql,
  });

  assert.equal(result.upserted, 3);
  assert.equal(queries.length, 3);
});

test('syncEmployees: empty page → upserted=0, no error', async () => {
  nock('https://api.employmenthero.com')
    .get(`/api/v1/organisations/${ORG_ID}/employees`)
    .reply(200, { data: [] });

  const { sql, queries } = makeSqlStub();
  const result = await syncEmployees({
    access_token: 'fake',
    organisation_id: ORG_ID,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    invited_by_user_id: INVITED_BY,
    sql_client: sql,
  });

  assert.equal(result.upserted, 0);
  assert.equal(result.deactivated, 0);
  assert.equal(queries.length, 0);
});

test('syncEmployees: skips employees with empty work_email', async () => {
  nock('https://api.employmenthero.com')
    .get(`/api/v1/organisations/${ORG_ID}/employees`)
    .reply(200, {
      data: [
        {
          id: 'eh-no-email',
          first_name: 'NoEmail',
          surname: 'Person',
          work_email: '',
          start_date: '2024-01-01',
          organisation_id: ORG_ID,
          status: 'active',
        },
        {
          id: 'eh-with-email',
          first_name: 'Has',
          surname: 'Email',
          work_email: 'has@acme.test',
          start_date: '2024-01-01',
          organisation_id: ORG_ID,
          status: 'active',
        },
      ],
    });

  const { sql, queries } = makeSqlStub();
  const result = await syncEmployees({
    access_token: 'fake',
    organisation_id: ORG_ID,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    invited_by_user_id: INVITED_BY,
    sql_client: sql,
  });

  assert.equal(result.upserted, 1);
  assert.equal(queries.length, 1);
});

test('syncEmployees: changed_since is forwarded to the EH API', async () => {
  const since = new Date('2026-04-20T00:00:00Z');
  nock('https://api.employmenthero.com')
    .get(`/api/v1/organisations/${ORG_ID}/employees`)
    .query({ updated_after: since.toISOString() })
    .reply(200, { data: [] });

  const { sql } = makeSqlStub();
  const result = await syncEmployees({
    access_token: 'fake',
    organisation_id: ORG_ID,
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    invited_by_user_id: INVITED_BY,
    changed_since: since,
    sql_client: sql,
  });
  assert.equal(result.upserted, 0);
});
