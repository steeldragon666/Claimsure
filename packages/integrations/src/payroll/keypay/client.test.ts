import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import nock from 'nock';
import { listEmployees, listTimesheets } from './client.js';
import { KEYPAY_API_BASE, type KeypayClientOptions } from './types.js';

const BUSINESS_ID = 4242;

const opts = (): KeypayClientOptions => ({
  api_key: 'fake-keypay-key',
  business_id: BUSINESS_ID,
});

beforeEach(() => {
  nock.cleanAll();
});

after(() => {
  nock.cleanAll();
});

// -- listEmployees ------------------------------------------------------

test('listEmployees: happy path parses array + sends api-key header', async () => {
  nock('https://api.yourpayroll.com.au')
    .get(`/api/v2/business/${BUSINESS_ID}/employee`)
    .matchHeader('x-api-key', 'fake-keypay-key')
    .matchHeader('accept', 'application/json')
    .query({ skip: '0', top: '100' })
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
    ]);

  const { employees, next_cursor } = await listEmployees(opts());
  assert.equal(employees.length, 2);
  assert.equal(employees[0]?.id, 1001);
  assert.equal(employees[1]?.jobTitle, 'Engineer');
  // Short page (<100) → no next page.
  assert.equal(next_cursor, null);
});

test('listEmployees: full page (100 results) → next_cursor=2', async () => {
  // Synthesise exactly 100 items to trigger the "full page" pagination signal.
  const data = Array.from({ length: 100 }, (_, i) => ({
    id: 2000 + i,
    firstName: `First${i}`,
    surname: `Last${i}`,
    email: `user${i}@acme.test`,
    startDate: '2024-01-01',
    status: 'Active' as const,
  }));
  nock('https://api.yourpayroll.com.au')
    .get(`/api/v2/business/${BUSINESS_ID}/employee`)
    .query({ skip: '0', top: '100' })
    .reply(200, data);

  const { employees, next_cursor } = await listEmployees(opts());
  assert.equal(employees.length, 100);
  assert.equal(next_cursor, 2);
});

test('listEmployees: cursor=2 sends skip=100', async () => {
  nock('https://api.yourpayroll.com.au')
    .get(`/api/v2/business/${BUSINESS_ID}/employee`)
    .query({ skip: '100', top: '100' })
    .reply(200, [
      {
        id: 3001,
        firstName: 'Carol',
        surname: 'Lee',
        email: 'carol@acme.test',
        startDate: '2024-05-01',
        status: 'Active',
      },
    ]);

  const { employees, next_cursor } = await listEmployees(opts(), { cursor: 2 });
  assert.equal(employees.length, 1);
  // Short page → end of stream.
  assert.equal(next_cursor, null);
});

test('listEmployees: changed_since adds updatedAfter query param', async () => {
  const since = new Date('2026-04-20T00:00:00Z');
  nock('https://api.yourpayroll.com.au')
    .get(`/api/v2/business/${BUSINESS_ID}/employee`)
    .query({
      updatedAfter: since.toISOString(),
      skip: '0',
      top: '100',
    })
    .reply(200, []);

  const { employees } = await listEmployees(opts(), { changed_since: since });
  assert.equal(employees.length, 0);
});

test(
  'listEmployees: 401 invalid API key throws after retry exhaustion',
  { timeout: 60_000 },
  async () => {
    // withRetry retries on any throw; we throw on !res.ok — so 401 burns
    // the full retry budget (default 5) before surfacing as a thrown error.
    nock('https://api.yourpayroll.com.au')
      .get(`/api/v2/business/${BUSINESS_ID}/employee`)
      .times(5)
      .query(true)
      .reply(401, 'invalid api key');

    await assert.rejects(listEmployees(opts()), /keypay list employees: 401/);
  },
);

test('listEmployees: persistent 5xx → throws after retry budget', { timeout: 60_000 }, async () => {
  nock('https://api.yourpayroll.com.au')
    .get(`/api/v2/business/${BUSINESS_ID}/employee`)
    .times(5)
    .query(true)
    .reply(503, 'unavailable');

  await assert.rejects(listEmployees(opts()), /keypay list employees: 503/);
});

// -- listTimesheets ----------------------------------------------------

test('listTimesheets: happy path', async () => {
  nock('https://api.yourpayroll.com.au')
    .get(`/api/v2/business/${BUSINESS_ID}/timesheet`)
    .matchHeader('x-api-key', 'fake-keypay-key')
    .query({ skip: '0', top: '100' })
    .reply(200, [
      {
        id: 9001,
        employeeId: 1001,
        date: '2026-04-25',
        startTime: '09:00',
        endTime: '17:00',
        units: 8,
        status: 'Approved',
        comments: 'R&D experimentation',
      },
    ]);

  const { timesheets, next_cursor } = await listTimesheets(opts());
  assert.equal(timesheets.length, 1);
  assert.equal(timesheets[0]?.units, 8);
  assert.equal(timesheets[0]?.comments, 'R&D experimentation');
  assert.equal(next_cursor, null);
});

test('listTimesheets: from_date / to_date use YYYY-MM-DD format', async () => {
  const from = new Date('2026-04-01T08:30:00Z');
  const to = new Date('2026-04-30T23:59:59Z');
  nock('https://api.yourpayroll.com.au')
    .get(`/api/v2/business/${BUSINESS_ID}/timesheet`)
    .query({
      fromDate: '2026-04-01',
      toDate: '2026-04-30',
      skip: '0',
      top: '100',
    })
    .reply(200, []);

  const { timesheets } = await listTimesheets(opts(), { from_date: from, to_date: to });
  assert.equal(timesheets.length, 0);
});

test('listTimesheets: pagination cursor + changed_since both forwarded', async () => {
  const since = new Date('2026-04-20T00:00:00Z');
  nock('https://api.yourpayroll.com.au')
    .get(`/api/v2/business/${BUSINESS_ID}/timesheet`)
    .query({
      updatedAfter: since.toISOString(),
      skip: '100',
      top: '100',
    })
    .reply(200, []);

  const { next_cursor } = await listTimesheets(opts(), {
    changed_since: since,
    cursor: 2,
  });
  // Short page (0 results) — no further pages.
  assert.equal(next_cursor, null);
});

test('listTimesheets: full page (100 results) → next_cursor=2', async () => {
  const data = Array.from({ length: 100 }, (_, i) => ({
    id: 5000 + i,
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
    .reply(200, data);

  const { timesheets, next_cursor } = await listTimesheets(opts());
  assert.equal(timesheets.length, 100);
  assert.equal(next_cursor, 2);
});

test('client: respects custom base_url override', async () => {
  nock('https://keypay-staging.example')
    .get(`/api/v2/business/${BUSINESS_ID}/employee`)
    .query({ skip: '0', top: '100' })
    .reply(200, []);

  const { employees } = await listEmployees({
    ...opts(),
    base_url: 'https://keypay-staging.example/api/v2',
  });
  assert.equal(employees.length, 0);
  assert.equal(KEYPAY_API_BASE, 'https://api.yourpayroll.com.au/api/v2');
});
