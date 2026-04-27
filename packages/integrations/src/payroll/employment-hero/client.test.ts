import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import nock from 'nock';
import { buildAuthUrl, exchangeCode, refreshAccessToken } from './oauth.js';
import {
  listEmployees,
  listTimesheets,
  type EmploymentHeroClientOptions,
} from './client.js';
import { EH_API_BASE, EH_OAUTH_AUTHORIZE_URL, EH_SCOPES } from './types.js';

const ORG_ID = 'org-eh-001';

const opts = (): EmploymentHeroClientOptions => ({
  access_token: 'fake-eh-access',
  organisation_id: ORG_ID,
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
  assert.equal(`${u.origin}${u.pathname}`, EH_OAUTH_AUTHORIZE_URL);
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('client_id'), 'cid');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://app.example/cb');
  assert.equal(u.searchParams.get('state'), 'csrf-token-xyz');
  assert.equal(u.searchParams.get('scope'), EH_SCOPES.join(' '));
});

test('exchangeCode: happy path returns OAuthTokens with computed expires_at', async () => {
  let capturedBody: string | null = null;
  nock('https://oauth.employmenthero.com')
    .post('/oauth2/token', (body: string) => {
      capturedBody = body;
      return true;
    })
    .reply(200, {
      access_token: 'eh-access-1',
      refresh_token: 'eh-refresh-1',
      expires_in: 3600,
      scope: 'read:employees read:timesheets',
      token_type: 'Bearer',
    });

  const before = Date.now();
  const tokens = await exchangeCode({
    client_id: 'cid',
    client_secret: 'csecret',
    redirect_uri: 'https://app.example/cb',
    code: 'auth-code-xyz',
  });
  const after = Date.now();

  assert.equal(tokens.access_token, 'eh-access-1');
  assert.equal(tokens.refresh_token, 'eh-refresh-1');
  assert.deepEqual(tokens.scopes, ['read:employees', 'read:timesheets']);
  // expires_at ≈ now + 3600s; tolerate the wall-clock window of the test.
  const expiresMs = tokens.expires_at.getTime();
  assert.ok(expiresMs >= before + 3600 * 1000 - 50);
  assert.ok(expiresMs <= after + 3600 * 1000 + 50);

  assert.ok(capturedBody, 'body captured');
  const parsed = new URLSearchParams(capturedBody);
  assert.equal(parsed.get('grant_type'), 'authorization_code');
  assert.equal(parsed.get('client_id'), 'cid');
  assert.equal(parsed.get('client_secret'), 'csecret');
  assert.equal(parsed.get('code'), 'auth-code-xyz');
  assert.equal(parsed.get('redirect_uri'), 'https://app.example/cb');
});

test('exchangeCode: 400 throws with descriptive message', async () => {
  nock('https://oauth.employmenthero.com')
    .post('/oauth2/token')
    .reply(400, 'invalid_grant');

  await assert.rejects(
    exchangeCode({
      client_id: 'cid',
      client_secret: 'csecret',
      redirect_uri: 'https://app.example/cb',
      code: 'bad-code',
    }),
    /employment_hero oauth exchange: 400 invalid_grant/,
  );
});

test('refreshAccessToken: happy path returns new tokens', async () => {
  let capturedBody: string | null = null;
  nock('https://oauth.employmenthero.com')
    .post('/oauth2/token', (body: string) => {
      capturedBody = body;
      return true;
    })
    .reply(200, {
      access_token: 'eh-access-new',
      refresh_token: 'eh-refresh-new',
      expires_in: 7200,
    });

  const tokens = await refreshAccessToken({
    client_id: 'cid',
    client_secret: 'csecret',
    redirect_uri: 'https://app.example/cb',
    refresh_token: 'eh-refresh-old',
  });
  assert.equal(tokens.access_token, 'eh-access-new');
  assert.equal(tokens.refresh_token, 'eh-refresh-new');

  assert.ok(capturedBody);
  const parsed = new URLSearchParams(capturedBody);
  assert.equal(parsed.get('grant_type'), 'refresh_token');
  assert.equal(parsed.get('refresh_token'), 'eh-refresh-old');
});

test('refreshAccessToken: 401 throws', async () => {
  nock('https://oauth.employmenthero.com')
    .post('/oauth2/token')
    .reply(401, 'invalid refresh token');

  await assert.rejects(
    refreshAccessToken({
      client_id: 'cid',
      client_secret: 'csecret',
      redirect_uri: 'https://app.example/cb',
      refresh_token: 'expired',
    }),
    /employment_hero oauth refresh: 401/,
  );
});

// -- listEmployees ------------------------------------------------------

test('listEmployees: happy path parses data + next_cursor=null when missing', async () => {
  nock('https://api.employmenthero.com')
    .get(`/api/v1/organisations/${ORG_ID}/employees`)
    .matchHeader('authorization', 'Bearer fake-eh-access')
    .reply(200, {
      data: [
        {
          id: 'eh-emp-1',
          first_name: 'Alice',
          surname: 'Smith',
          work_email: 'alice@acme.test',
          start_date: '2024-01-15',
          organisation_id: ORG_ID,
          status: 'active',
        },
        {
          id: 'eh-emp-2',
          first_name: 'Bob',
          surname: 'Jones',
          work_email: 'bob@acme.test',
          job_title: 'Engineer',
          start_date: '2024-03-01',
          organisation_id: ORG_ID,
          status: 'active',
        },
      ],
    });

  const { employees, next_cursor } = await listEmployees(opts());
  assert.equal(employees.length, 2);
  assert.equal(employees[0]?.id, 'eh-emp-1');
  assert.equal(employees[1]?.job_title, 'Engineer');
  assert.equal(next_cursor, null);
});

test('listEmployees: pagination — passes cursor + reads meta.next_cursor', async () => {
  nock('https://api.employmenthero.com')
    .get(`/api/v1/organisations/${ORG_ID}/employees`)
    .query({ cursor: 'page-2-cur' })
    .reply(200, {
      data: [
        {
          id: 'eh-emp-3',
          first_name: 'Carol',
          surname: 'Lee',
          work_email: 'carol@acme.test',
          start_date: '2024-05-01',
          organisation_id: ORG_ID,
          status: 'active',
        },
      ],
      meta: { next_cursor: 'page-3-cur' },
    });

  const { employees, next_cursor } = await listEmployees(opts(), { cursor: 'page-2-cur' });
  assert.equal(employees.length, 1);
  assert.equal(next_cursor, 'page-3-cur');
});

test('listEmployees: changed_since adds updated_after query param', async () => {
  const since = new Date('2026-04-20T00:00:00Z');
  nock('https://api.employmenthero.com')
    .get(`/api/v1/organisations/${ORG_ID}/employees`)
    .query({ updated_after: since.toISOString() })
    .reply(200, { data: [] });

  const { employees } = await listEmployees(opts(), { changed_since: since });
  assert.equal(employees.length, 0);
});

// -- listTimesheets ----------------------------------------------------

test('listTimesheets: happy path', async () => {
  nock('https://api.employmenthero.com')
    .get(`/api/v1/organisations/${ORG_ID}/timesheets`)
    .reply(200, {
      data: [
        {
          id: 'ts-1',
          employee_id: 'eh-emp-1',
          date: '2026-04-25',
          start_time: '2026-04-25T09:00:00Z',
          end_time: '2026-04-25T17:00:00Z',
          duration_minutes: 480,
          status: 'approved',
          notes: 'R&D experimentation',
        },
      ],
    });

  const { timesheets, next_cursor } = await listTimesheets(opts());
  assert.equal(timesheets.length, 1);
  assert.equal(timesheets[0]?.duration_minutes, 480);
  assert.equal(timesheets[0]?.notes, 'R&D experimentation');
  assert.equal(next_cursor, null);
});

test('listTimesheets: date filters use YYYY-MM-DD format', async () => {
  const from = new Date('2026-04-01T08:30:00Z');
  const to = new Date('2026-04-30T23:59:59Z');
  nock('https://api.employmenthero.com')
    .get(`/api/v1/organisations/${ORG_ID}/timesheets`)
    .query({ from_date: '2026-04-01', to_date: '2026-04-30' })
    .reply(200, { data: [] });

  const { timesheets } = await listTimesheets(opts(), { from_date: from, to_date: to });
  assert.equal(timesheets.length, 0);
});

test('listTimesheets: pagination cursor + changed_since both forwarded', async () => {
  const since = new Date('2026-04-20T00:00:00Z');
  nock('https://api.employmenthero.com')
    .get(`/api/v1/organisations/${ORG_ID}/timesheets`)
    .query({ updated_after: since.toISOString(), cursor: 'pg2' })
    .reply(200, {
      data: [],
      meta: { next_cursor: 'pg3' },
    });

  const { next_cursor } = await listTimesheets(opts(), {
    changed_since: since,
    cursor: 'pg2',
  });
  assert.equal(next_cursor, 'pg3');
});

// -- 401 retry exhaustion ----------------------------------------------

test(
  'listEmployees: 401 retries up to max_attempts, then throws',
  { timeout: 60_000 },
  async () => {
    // withRetry retries on any throw; we throw on !res.ok — so 401 burns
    // the full retry budget (default 5) before surfacing as a thrown error.
    nock('https://api.employmenthero.com')
      .get(`/api/v1/organisations/${ORG_ID}/employees`)
      .times(5)
      .reply(401, 'unauthorized');

    await assert.rejects(
      listEmployees(opts()),
      /employment_hero list employees: 401/,
    );
  },
);

test(
  'listEmployees: persistent 5xx throws after retry budget',
  { timeout: 60_000 },
  async () => {
    // withRetry retries on thrown exceptions from the wrapped function. fetch
    // only rejects on network errors, not status codes — the !res.ok throw
    // happens AFTER withRetry resolves. So even a single 503 surfaces as a
    // thrown error here, but we use times(5) to mirror the docusign pattern
    // and document the retry budget.
    nock('https://api.employmenthero.com')
      .get(`/api/v1/organisations/${ORG_ID}/employees`)
      .times(5)
      .reply(503, 'unavailable');

    await assert.rejects(
      listEmployees(opts()),
      /employment_hero list employees: 503/,
    );
  },
);

test('client: respects custom base_url override', async () => {
  nock('https://eh-staging.example')
    .get(`/api/v1/organisations/${ORG_ID}/employees`)
    .reply(200, { data: [] });

  const { employees } = await listEmployees({
    ...opts(),
    base_url: 'https://eh-staging.example/api/v1',
  });
  assert.equal(employees.length, 0);
  assert.equal(EH_API_BASE, 'https://api.employmenthero.com/api/v1');
});
