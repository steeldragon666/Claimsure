import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nock from 'nock';
import { buildAuthUrl, exchangeCode, refreshAccessToken, listConnections } from './oauth.js';
import {
  listEmployees,
  listTimesheets,
  parseXeroDate,
  type XeroPayrollClientOptions,
} from './client.js';
import { XERO_OAUTH_AUTHORIZE_URL, XERO_PAYROLL_SCOPES } from './types.js';

const TENANT_ID = '11111111-2222-3333-4444-555555555555';

const opts = (): XeroPayrollClientOptions => ({
  access_token: 'fake-xero-access',
  xero_tenant_id: TENANT_ID,
});

beforeEach(() => {
  nock.cleanAll();
});

after(() => {
  nock.cleanAll();
});

// -- OAuth: buildAuthUrl ------------------------------------------------

test('buildAuthUrl: returns authorize URL with PKCE challenge + state', () => {
  const url = buildAuthUrl({
    client_id: 'cid',
    client_secret: 'csecret',
    redirect_uri: 'https://app.example/cb',
    state: 'csrf-token-xyz',
    pkce_challenge: 'fake-challenge-base64url',
  });
  const u = new URL(url);
  assert.equal(`${u.origin}${u.pathname}`, XERO_OAUTH_AUTHORIZE_URL);
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('client_id'), 'cid');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://app.example/cb');
  assert.equal(u.searchParams.get('state'), 'csrf-token-xyz');
  assert.equal(u.searchParams.get('scope'), XERO_PAYROLL_SCOPES.join(' '));
  // PKCE: challenge present + S256 method.
  assert.equal(u.searchParams.get('code_challenge'), 'fake-challenge-base64url');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
});

test('buildAuthUrl: no client_secret leak — secret is not appended to authorize URL', () => {
  const url = buildAuthUrl({
    client_id: 'cid',
    client_secret: 'super-secret-do-not-leak',
    redirect_uri: 'https://app.example/cb',
    state: 's',
    pkce_challenge: 'c',
  });
  assert.ok(!url.includes('super-secret-do-not-leak'));
});

// -- OAuth: exchangeCode -----------------------------------------------

test('exchangeCode: happy path includes code_verifier in form body', async () => {
  let capturedBody: string | null = null;
  nock('https://identity.xero.com')
    .post('/connect/token', (body: string) => {
      capturedBody = body;
      return true;
    })
    .reply(200, {
      access_token: 'xero-access-1',
      refresh_token: 'xero-refresh-1',
      expires_in: 1800,
      scope: 'offline_access payroll.employees payroll.timesheets',
      token_type: 'Bearer',
    });

  const before = Date.now();
  const tokens = await exchangeCode({
    client_id: 'cid',
    client_secret: 'csecret',
    redirect_uri: 'https://app.example/cb',
    code: 'auth-code-xyz',
    pkce_verifier: 'verifier-abc-43-chars-or-more-padded-out-here',
  });
  const afterTs = Date.now();

  assert.equal(tokens.access_token, 'xero-access-1');
  assert.equal(tokens.refresh_token, 'xero-refresh-1');
  assert.deepEqual(tokens.scopes, ['offline_access', 'payroll.employees', 'payroll.timesheets']);
  // expires_at ~= now + 1800s
  const expiresMs = tokens.expires_at.getTime();
  assert.ok(expiresMs >= before + 1800 * 1000 - 50);
  assert.ok(expiresMs <= afterTs + 1800 * 1000 + 50);

  assert.ok(capturedBody, 'body captured');
  const parsed = new URLSearchParams(capturedBody);
  assert.equal(parsed.get('grant_type'), 'authorization_code');
  assert.equal(parsed.get('client_id'), 'cid');
  assert.equal(parsed.get('client_secret'), 'csecret');
  assert.equal(parsed.get('code'), 'auth-code-xyz');
  assert.equal(parsed.get('redirect_uri'), 'https://app.example/cb');
  // PKCE verifier MUST be in the body — Xero rejects the exchange without it.
  assert.equal(parsed.get('code_verifier'), 'verifier-abc-43-chars-or-more-padded-out-here');
});

test('exchangeCode: omits client_secret when absent (public-client PKCE-only flow)', async () => {
  let capturedBody: string | null = null;
  nock('https://identity.xero.com')
    .post('/connect/token', (body: string) => {
      capturedBody = body;
      return true;
    })
    .reply(200, {
      access_token: 'AT',
      expires_in: 1800,
    });

  await exchangeCode({
    client_id: 'cid-public',
    redirect_uri: 'https://app.example/cb',
    code: 'auth-code',
    pkce_verifier: 'verifier',
  });
  assert.ok(capturedBody);
  const parsed = new URLSearchParams(capturedBody);
  assert.equal(parsed.get('client_secret'), null);
  assert.equal(parsed.get('code_verifier'), 'verifier');
});

test('exchangeCode: 400 throws with descriptive message', async () => {
  nock('https://identity.xero.com').post('/connect/token').reply(400, 'invalid_grant');

  await assert.rejects(
    exchangeCode({
      client_id: 'cid',
      client_secret: 'csecret',
      redirect_uri: 'https://app.example/cb',
      code: 'bad',
      pkce_verifier: 'verifier',
    }),
    /xero oauth exchange: 400 invalid_grant/,
  );
});

// -- OAuth: refreshAccessToken -----------------------------------------

test('refreshAccessToken: rotates tokens — new refresh_token returned', async () => {
  let capturedBody: string | null = null;
  nock('https://identity.xero.com')
    .post('/connect/token', (body: string) => {
      capturedBody = body;
      return true;
    })
    .reply(200, {
      access_token: 'xero-access-new',
      // Xero rotates refresh tokens on every refresh.
      refresh_token: 'xero-refresh-new',
      expires_in: 1800,
    });

  const tokens = await refreshAccessToken({
    client_id: 'cid',
    client_secret: 'csecret',
    redirect_uri: 'https://app.example/cb',
    refresh_token: 'xero-refresh-old',
  });

  assert.equal(tokens.access_token, 'xero-access-new');
  assert.equal(tokens.refresh_token, 'xero-refresh-new');

  assert.ok(capturedBody);
  const parsed = new URLSearchParams(capturedBody);
  assert.equal(parsed.get('grant_type'), 'refresh_token');
  assert.equal(parsed.get('refresh_token'), 'xero-refresh-old');
  assert.equal(parsed.get('client_id'), 'cid');
});

test('refreshAccessToken: 401 throws', async () => {
  nock('https://identity.xero.com').post('/connect/token').reply(401, 'invalid refresh token');

  await assert.rejects(
    refreshAccessToken({
      client_id: 'cid',
      client_secret: 'csecret',
      redirect_uri: 'https://app.example/cb',
      refresh_token: 'expired',
    }),
    /xero oauth refresh: 401/,
  );
});

// -- listConnections ----------------------------------------------------

test('listConnections: returns tenantId array + sends bearer token', async () => {
  nock('https://api.xero.com')
    .get('/connections')
    .matchHeader('authorization', 'Bearer access-xyz')
    .reply(200, [
      {
        id: 'conn-1',
        tenantId: TENANT_ID,
        tenantType: 'ORGANISATION',
        tenantName: 'Acme R&D Pty Ltd',
        createdDateUtc: '2026-04-01T00:00:00Z',
      },
      {
        id: 'conn-2',
        tenantId: '99999999-2222-3333-4444-555555555555',
        tenantType: 'ORGANISATION',
        tenantName: 'Other Org',
        createdDateUtc: '2026-04-15T00:00:00Z',
      },
    ]);

  const conns = await listConnections('access-xyz');
  assert.equal(conns.length, 2);
  assert.equal(conns[0]?.tenantId, TENANT_ID);
  assert.equal(conns[0]?.tenantName, 'Acme R&D Pty Ltd');
  assert.equal(conns[1]?.tenantType, 'ORGANISATION');
});

test('listConnections: 401 throws', async () => {
  nock('https://api.xero.com').get('/connections').reply(401, 'unauthorized');
  await assert.rejects(listConnections('bad-token'), /xero list connections: 401/);
});

// -- parseXeroDate -----------------------------------------------------

test('parseXeroDate: Microsoft JSON Date /Date(epoch+0000)/ parses to correct Date', () => {
  // 2026-04-25T09:00:00Z = 1777107600000 ms.
  const d = parseXeroDate('/Date(1777107600000+0000)/');
  assert.ok(d instanceof Date);
  assert.equal(d?.toISOString(), '2026-04-25T09:00:00.000Z');
});

test('parseXeroDate: Microsoft JSON Date with negative offset still uses absolute millis', () => {
  // The +/-NNNN suffix is informational; the millis are absolute.
  const d = parseXeroDate('/Date(1777107600000-0500)/');
  assert.equal(d?.toISOString(), '2026-04-25T09:00:00.000Z');
});

test('parseXeroDate: ISO 8601 fallback', () => {
  const d = parseXeroDate('2026-04-25T09:00:00Z');
  assert.equal(d?.toISOString(), '2026-04-25T09:00:00.000Z');
});

test('parseXeroDate: YYYY-MM-DD fallback (interpreted as UTC midnight)', () => {
  const d = parseXeroDate('2026-04-25');
  assert.ok(d instanceof Date);
  // YYYY-MM-DD is parsed by `new Date(...)` as UTC midnight.
  assert.equal(d?.toISOString(), '2026-04-25T00:00:00.000Z');
});

test('parseXeroDate: undefined / null / empty / unparseable → null', () => {
  assert.equal(parseXeroDate(undefined), null);
  assert.equal(parseXeroDate(null), null);
  assert.equal(parseXeroDate(''), null);
  assert.equal(parseXeroDate('not-a-date'), null);
});

// -- listEmployees ----------------------------------------------------

test('listEmployees: happy path parses Employees array + sets Xero-tenant-id header', async () => {
  let capturedTenantHeader: string | undefined;
  nock('https://api.xero.com')
    .get('/payroll.xro/1.0/Employees')
    .query({ page: '1' })
    .matchHeader('authorization', 'Bearer fake-xero-access')
    .matchHeader('xero-tenant-id', (val: string | string[]) => {
      capturedTenantHeader = Array.isArray(val) ? val[0] : val;
      return true;
    })
    .reply(200, {
      Employees: [
        {
          EmployeeID: '00000000-0000-0000-0000-000000000001',
          FirstName: 'Alice',
          LastName: 'Smith',
          Email: 'alice@acme.test',
          Status: 'ACTIVE',
          StartDate: '/Date(1705276800000+0000)/',
          JobTitle: 'Researcher',
        },
        {
          EmployeeID: '00000000-0000-0000-0000-000000000002',
          FirstName: 'Bob',
          LastName: 'Jones',
          Email: 'bob@acme.test',
          Status: 'ACTIVE',
          StartDate: '/Date(1709251200000+0000)/',
        },
      ],
    });

  const { employees, next_page } = await listEmployees(opts());
  assert.equal(employees.length, 2);
  assert.equal(employees[0]?.EmployeeID, '00000000-0000-0000-0000-000000000001');
  assert.equal(employees[0]?.JobTitle, 'Researcher');
  // Short page (<100) → no next page.
  assert.equal(next_page, null);
  // The Xero-tenant-id header was sent.
  assert.equal(capturedTenantHeader, TENANT_ID);
});

test('listEmployees: full page (100 results) → next_page=2', async () => {
  const data = Array.from({ length: 100 }, (_, i) => ({
    EmployeeID: crypto.randomUUID(),
    FirstName: `First${i}`,
    LastName: `Last${i}`,
    Email: `user${i}@acme.test`,
    Status: 'ACTIVE' as const,
  }));
  nock('https://api.xero.com')
    .get('/payroll.xro/1.0/Employees')
    .query({ page: '1' })
    .reply(200, { Employees: data });

  const { employees, next_page } = await listEmployees(opts());
  assert.equal(employees.length, 100);
  assert.equal(next_page, 2);
});

test('listEmployees: page=2 forwarded as query param', async () => {
  let capturedUrl: string | undefined;
  nock('https://api.xero.com')
    .get('/payroll.xro/1.0/Employees')
    .query(true)
    .reply(200, function (uri) {
      capturedUrl = uri;
      return { Employees: [] };
    });

  await listEmployees(opts(), { page: 2 });
  assert.ok(capturedUrl?.includes('page=2'));
});

test('listEmployees: changed_since adds If-Modified-Since header', async () => {
  const since = new Date('2026-04-20T00:00:00Z');
  let capturedHeader: string | undefined;
  nock('https://api.xero.com')
    .get('/payroll.xro/1.0/Employees')
    .query({ page: '1' })
    .matchHeader('if-modified-since', (val: string | string[]) => {
      capturedHeader = Array.isArray(val) ? val[0] : val;
      return true;
    })
    .reply(200, { Employees: [] });

  await listEmployees(opts(), { changed_since: since });
  assert.equal(capturedHeader, since.toUTCString());
});

test('listEmployees: missing Employees field → empty array, next_page=null', async () => {
  nock('https://api.xero.com')
    .get('/payroll.xro/1.0/Employees')
    .query({ page: '1' })
    .reply(200, {});

  const { employees, next_page } = await listEmployees(opts());
  assert.equal(employees.length, 0);
  assert.equal(next_page, null);
});

test('listEmployees: 401 throws after retry exhaustion', { timeout: 60_000 }, async () => {
  nock('https://api.xero.com')
    .get('/payroll.xro/1.0/Employees')
    .query(true)
    .times(5)
    .reply(401, 'unauthorized');

  await assert.rejects(listEmployees(opts()), /xero list employees: 401/);
});

test('listEmployees: persistent 5xx throws after retry budget', { timeout: 60_000 }, async () => {
  nock('https://api.xero.com')
    .get('/payroll.xro/1.0/Employees')
    .query(true)
    .times(5)
    .reply(503, 'unavailable');

  await assert.rejects(listEmployees(opts()), /xero list employees: 503/);
});

// -- listTimesheets ----------------------------------------------------

test('listTimesheets: happy path parses Timesheets array', async () => {
  nock('https://api.xero.com')
    .get('/payroll.xro/1.0/Timesheets')
    .query({ page: '1' })
    .matchHeader('xero-tenant-id', TENANT_ID)
    .reply(200, {
      Timesheets: [
        {
          TimesheetID: 'ts-1',
          EmployeeID: '00000000-0000-0000-0000-000000000001',
          StartDate: '/Date(1745539200000+0000)/',
          EndDate: '/Date(1745798400000+0000)/',
          Status: 'APPROVED',
          Hours: 16,
          TimesheetLines: [
            { Date: '/Date(1745539200000+0000)/', NumberOfUnits: 8 },
            { Date: '/Date(1745625600000+0000)/', NumberOfUnits: 8 },
          ],
        },
      ],
    });

  const { timesheets, next_page } = await listTimesheets(opts());
  assert.equal(timesheets.length, 1);
  assert.equal(timesheets[0]?.Status, 'APPROVED');
  assert.equal(timesheets[0]?.TimesheetLines?.length, 2);
  assert.equal(next_page, null);
});

test('listTimesheets: full page (100) → next_page=2', async () => {
  const data = Array.from({ length: 100 }, (_, i) => ({
    TimesheetID: `ts-${i}`,
    EmployeeID: '00000000-0000-0000-0000-000000000001',
    StartDate: '/Date(1745539200000+0000)/',
    EndDate: '/Date(1745798400000+0000)/',
    Status: 'APPROVED' as const,
    TimesheetLines: [],
  }));
  nock('https://api.xero.com')
    .get('/payroll.xro/1.0/Timesheets')
    .query({ page: '1' })
    .reply(200, { Timesheets: data });

  const { timesheets, next_page } = await listTimesheets(opts());
  assert.equal(timesheets.length, 100);
  assert.equal(next_page, 2);
});

test('listTimesheets: changed_since adds If-Modified-Since header', async () => {
  const since = new Date('2026-04-20T00:00:00Z');
  let capturedHeader: string | undefined;
  nock('https://api.xero.com')
    .get('/payroll.xro/1.0/Timesheets')
    .query({ page: '1' })
    .matchHeader('if-modified-since', (val: string | string[]) => {
      capturedHeader = Array.isArray(val) ? val[0] : val;
      return true;
    })
    .reply(200, { Timesheets: [] });

  await listTimesheets(opts(), { changed_since: since });
  assert.equal(capturedHeader, since.toUTCString());
});

test('listTimesheets: missing Timesheets field → empty array', async () => {
  nock('https://api.xero.com')
    .get('/payroll.xro/1.0/Timesheets')
    .query({ page: '1' })
    .reply(200, {});

  const { timesheets, next_page } = await listTimesheets(opts());
  assert.equal(timesheets.length, 0);
  assert.equal(next_page, null);
});

test('listTimesheets: 401 throws after retry exhaustion', { timeout: 60_000 }, async () => {
  nock('https://api.xero.com')
    .get('/payroll.xro/1.0/Timesheets')
    .query(true)
    .times(5)
    .reply(401, 'unauthorized');

  await assert.rejects(listTimesheets(opts()), /xero list timesheets: 401/);
});
