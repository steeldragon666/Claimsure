import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import nock from 'nock';
import { buildAuthUrl, exchangeCode, refreshAccessToken } from './oauth.js';
import { listEmployees, listTimesheets, type DeputyClientOptions } from './client.js';
import { DEPUTY_OAUTH_AUTHORIZE_URL, DEPUTY_SCOPES } from './types.js';

const INSTALL_URL = 'https://acme.deputy.com';

const opts = (): DeputyClientOptions => ({
  access_token: 'fake-deputy-access',
  install_url: INSTALL_URL,
});

beforeEach(() => {
  nock.cleanAll();
});

after(() => {
  nock.cleanAll();
});

// -- OAuth --------------------------------------------------------------

test('buildAuthUrl: returns authorize URL with required params + state', () => {
  const url = buildAuthUrl({
    client_id: 'cid',
    client_secret: 'csecret',
    redirect_uri: 'https://app.example/cb',
    state: 'csrf-token-xyz',
  });
  const u = new URL(url);
  assert.equal(`${u.origin}${u.pathname}`, DEPUTY_OAUTH_AUTHORIZE_URL);
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('client_id'), 'cid');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://app.example/cb');
  assert.equal(u.searchParams.get('state'), 'csrf-token-xyz');
  assert.equal(u.searchParams.get('scope'), DEPUTY_SCOPES.join(' '));
});

test('exchangeCode: happy path returns OAuthTokens + endpoint_url + computed expires_at', async () => {
  let capturedBody: string | null = null;
  nock('https://once.deputy.com')
    .post('/oauth/access_token', (body: string) => {
      capturedBody = body;
      return true;
    })
    .reply(200, {
      access_token: 'deputy-access-1',
      refresh_token: 'deputy-refresh-1',
      expires_in: 3600,
      scope: 'longlife_refresh_token',
      token_type: 'bearer',
      endpoint: 'https://acme.deputy.com',
    });

  const before = Date.now();
  const result = await exchangeCode({
    client_id: 'cid',
    client_secret: 'csecret',
    redirect_uri: 'https://app.example/cb',
    code: 'auth-code-xyz',
  });
  const afterTs = Date.now();

  assert.equal(result.access_token, 'deputy-access-1');
  assert.equal(result.refresh_token, 'deputy-refresh-1');
  assert.equal(result.endpoint_url, 'https://acme.deputy.com');
  assert.deepEqual(result.scopes, ['longlife_refresh_token']);
  // expires_at ≈ now + 3600s; tolerate the wall-clock window of the test.
  const expiresMs = result.expires_at.getTime();
  assert.ok(expiresMs >= before + 3600 * 1000 - 50);
  assert.ok(expiresMs <= afterTs + 3600 * 1000 + 50);

  assert.ok(capturedBody, 'body captured');
  const parsed = new URLSearchParams(capturedBody);
  assert.equal(parsed.get('grant_type'), 'authorization_code');
  assert.equal(parsed.get('client_id'), 'cid');
  assert.equal(parsed.get('client_secret'), 'csecret');
  assert.equal(parsed.get('code'), 'auth-code-xyz');
  assert.equal(parsed.get('redirect_uri'), 'https://app.example/cb');
  assert.equal(parsed.get('scope'), 'longlife_refresh_token');
});

test('exchangeCode: missing endpoint in token response throws', async () => {
  nock('https://once.deputy.com').post('/oauth/access_token').reply(200, {
    access_token: 'deputy-access',
    expires_in: 3600,
    // endpoint missing
  });

  await assert.rejects(
    exchangeCode({
      client_id: 'cid',
      client_secret: 'csecret',
      redirect_uri: 'https://app.example/cb',
      code: 'good-code',
    }),
    /missing endpoint in token response/,
  );
});

test('exchangeCode: 400 throws with descriptive message', async () => {
  nock('https://once.deputy.com').post('/oauth/access_token').reply(400, 'invalid_grant');

  await assert.rejects(
    exchangeCode({
      client_id: 'cid',
      client_secret: 'csecret',
      redirect_uri: 'https://app.example/cb',
      code: 'bad-code',
    }),
    /deputy oauth exchange: 400 invalid_grant/,
  );
});

test('refreshAccessToken: happy path returns new tokens', async () => {
  let capturedBody: string | null = null;
  nock('https://once.deputy.com')
    .post('/oauth/access_token', (body: string) => {
      capturedBody = body;
      return true;
    })
    .reply(200, {
      access_token: 'deputy-access-new',
      refresh_token: 'deputy-refresh-new',
      expires_in: 7200,
    });

  const tokens = await refreshAccessToken({
    client_id: 'cid',
    client_secret: 'csecret',
    redirect_uri: 'https://app.example/cb',
    refresh_token: 'deputy-refresh-old',
  });
  assert.equal(tokens.access_token, 'deputy-access-new');
  assert.equal(tokens.refresh_token, 'deputy-refresh-new');

  assert.ok(capturedBody);
  const parsed = new URLSearchParams(capturedBody);
  assert.equal(parsed.get('grant_type'), 'refresh_token');
  assert.equal(parsed.get('refresh_token'), 'deputy-refresh-old');
});

test('refreshAccessToken: 401 throws', async () => {
  nock('https://once.deputy.com').post('/oauth/access_token').reply(401, 'invalid refresh token');

  await assert.rejects(
    refreshAccessToken({
      client_id: 'cid',
      client_secret: 'csecret',
      redirect_uri: 'https://app.example/cb',
      refresh_token: 'expired',
    }),
    /deputy oauth refresh: 401/,
  );
});

// -- listEmployees ------------------------------------------------------

test('listEmployees: happy path parses array + sends OAuth auth header + JSON body', async () => {
  let capturedBody: unknown;
  nock(INSTALL_URL)
    .post('/api/v1/resource/Employee/QUERY', (body) => {
      capturedBody = body;
      return true;
    })
    .matchHeader('authorization', 'OAuth fake-deputy-access')
    .matchHeader('content-type', 'application/json')
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
        EmployeeStartDate: '2024-03-01',
        Active: 1,
        Position: 'Engineer',
      },
    ]);

  const { employees, next_cursor } = await listEmployees(opts());
  assert.equal(employees.length, 2);
  assert.equal(employees[0]?.Id, 1001);
  assert.equal(employees[1]?.Position, 'Engineer');
  // Short page (<500) → no next page.
  assert.equal(next_cursor, null);

  // Verify body shape: sort + start + max, no search when no filters.
  const body = capturedBody as Record<string, unknown>;
  assert.deepEqual(body['sort'], { Id: 'asc' });
  assert.equal(body['start'], 0);
  assert.equal(body['max'], 500);
  assert.equal(body['search'], undefined);
});

test('listEmployees: full page (500 results) → next_cursor=500', async () => {
  // Synthesise exactly 500 items to trigger the "full page" pagination signal.
  const data = Array.from({ length: 500 }, (_, i) => ({
    Id: 2000 + i,
    DisplayName: `User ${i}`,
    FirstName: `First${i}`,
    LastName: `Last${i}`,
    Email: `user${i}@acme.test`,
    EmployeeStartDate: '2024-01-01',
    Active: 1,
  }));
  nock(INSTALL_URL).post('/api/v1/resource/Employee/QUERY').reply(200, data);

  const { employees, next_cursor } = await listEmployees(opts());
  assert.equal(employees.length, 500);
  assert.equal(next_cursor, 500);
});

test('listEmployees: cursor=500 sends start=500', async () => {
  let capturedBody: unknown;
  nock(INSTALL_URL)
    .post('/api/v1/resource/Employee/QUERY', (body) => {
      capturedBody = body;
      return true;
    })
    .reply(200, [
      {
        Id: 3001,
        DisplayName: 'Carol Lee',
        FirstName: 'Carol',
        LastName: 'Lee',
        Email: 'carol@acme.test',
        EmployeeStartDate: '2024-05-01',
        Active: 1,
      },
    ]);

  const { employees, next_cursor } = await listEmployees(opts(), { cursor: 500 });
  assert.equal(employees.length, 1);
  assert.equal(next_cursor, null);
  const body = capturedBody as Record<string, unknown>;
  assert.equal(body['start'], 500);
});

test('listEmployees: changed_since adds Modified search predicate (unix seconds)', async () => {
  const since = new Date('2026-04-20T00:00:00Z');
  const expectedUnix = Math.floor(since.getTime() / 1000);
  let capturedBody: unknown;
  nock(INSTALL_URL)
    .post('/api/v1/resource/Employee/QUERY', (body) => {
      capturedBody = body;
      return true;
    })
    .reply(200, []);

  const { employees } = await listEmployees(opts(), { changed_since: since });
  assert.equal(employees.length, 0);
  const body = capturedBody as Record<string, unknown>;
  const search = body['search'] as Record<string, unknown>;
  const s1 = search['s1'] as Record<string, unknown>;
  assert.equal(s1['field'], 'Modified');
  assert.equal(s1['type'], 'ge');
  assert.equal(s1['data'], expectedUnix);
});

test('listEmployees: 401 throws after retry exhaustion', { timeout: 60_000 }, async () => {
  nock(INSTALL_URL).post('/api/v1/resource/Employee/QUERY').times(5).reply(401, 'unauthorized');

  await assert.rejects(listEmployees(opts()), /deputy list employees: 401/);
});

test('listEmployees: persistent 5xx throws after retry budget', { timeout: 60_000 }, async () => {
  nock(INSTALL_URL).post('/api/v1/resource/Employee/QUERY').times(5).reply(503, 'unavailable');

  await assert.rejects(listEmployees(opts()), /deputy list employees: 503/);
});

// -- listTimesheets ----------------------------------------------------

test('listTimesheets: happy path', async () => {
  nock(INSTALL_URL)
    .post('/api/v1/resource/Timesheet/QUERY')
    .matchHeader('authorization', 'OAuth fake-deputy-access')
    .reply(200, [
      {
        Id: 9001,
        Employee: 1001,
        Date: '2026-04-25',
        StartTime: 1745571600,
        EndTime: 1745600400,
        TotalTime: 8,
        Cost: 0,
        Comment: 'R&D experimentation',
        Discarded: 0,
      },
    ]);

  const { timesheets, next_cursor } = await listTimesheets(opts());
  assert.equal(timesheets.length, 1);
  assert.equal(timesheets[0]?.TotalTime, 8);
  assert.equal(timesheets[0]?.Comment, 'R&D experimentation');
  assert.equal(next_cursor, null);
});

test('listTimesheets: from_date / to_date use YYYY-MM-DD format in search predicates', async () => {
  const from = new Date('2026-04-01T08:30:00Z');
  const to = new Date('2026-04-30T23:59:59Z');
  let capturedBody: unknown;
  nock(INSTALL_URL)
    .post('/api/v1/resource/Timesheet/QUERY', (body) => {
      capturedBody = body;
      return true;
    })
    .reply(200, []);

  await listTimesheets(opts(), { from_date: from, to_date: to });
  const body = capturedBody as Record<string, unknown>;
  const search = body['search'] as Record<string, unknown>;
  const s1 = search['s1'] as Record<string, unknown>;
  const s2 = search['s2'] as Record<string, unknown>;
  assert.equal(s1['field'], 'Date');
  assert.equal(s1['type'], 'ge');
  assert.equal(s1['data'], '2026-04-01');
  assert.equal(s2['field'], 'Date');
  assert.equal(s2['type'], 'le');
  assert.equal(s2['data'], '2026-04-30');
});

test('listTimesheets: full page (500 results) → next_cursor=500', async () => {
  const data = Array.from({ length: 500 }, (_, i) => ({
    Id: 5000 + i,
    Employee: 1001,
    Date: '2026-04-25',
    StartTime: 1745571600,
    EndTime: 1745600400,
    TotalTime: 8,
    Cost: 0,
    Discarded: 0,
  }));
  nock(INSTALL_URL).post('/api/v1/resource/Timesheet/QUERY').reply(200, data);

  const { timesheets, next_cursor } = await listTimesheets(opts());
  assert.equal(timesheets.length, 500);
  assert.equal(next_cursor, 500);
});

test('listTimesheets: changed_since + cursor + date filters all forwarded together', async () => {
  const since = new Date('2026-04-20T00:00:00Z');
  const expectedUnix = Math.floor(since.getTime() / 1000);
  const from = new Date('2026-04-01T00:00:00Z');
  let capturedBody: unknown;
  nock(INSTALL_URL)
    .post('/api/v1/resource/Timesheet/QUERY', (body) => {
      capturedBody = body;
      return true;
    })
    .reply(200, []);

  await listTimesheets(opts(), {
    changed_since: since,
    from_date: from,
    cursor: 500,
  });
  const body = capturedBody as Record<string, unknown>;
  assert.equal(body['start'], 500);
  const search = body['search'] as Record<string, unknown>;
  const s1 = search['s1'] as Record<string, unknown>;
  const s3 = search['s3'] as Record<string, unknown>;
  assert.equal(s1['field'], 'Date');
  assert.equal(s1['data'], '2026-04-01');
  assert.equal(s3['field'], 'Modified');
  assert.equal(s3['data'], expectedUnix);
});
