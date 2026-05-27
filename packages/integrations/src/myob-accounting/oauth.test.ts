import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import nock from 'nock';
import { buildAuthUrl, exchangeCode, refreshAccessToken } from './oauth.js';

const MYOB_SECURE_HOST = 'https://secure.myob.com';

function requestBodyToString(body: unknown): string {
  if (typeof body === 'string') return body;
  if (body instanceof Buffer) return body.toString('utf8');
  if (body instanceof URLSearchParams) return body.toString();
  return JSON.stringify(body);
}

beforeEach(() => {
  nock.cleanAll();
});

after(() => {
  nock.cleanAll();
});

test('buildAuthUrl: builds MYOB authorization URL with scope and state', () => {
  const authUrl = new URL(
    buildAuthUrl({
      client_id: 'client-id',
      client_secret: 'client-secret',
      redirect_uri: 'https://claimsure.test/oauth/myob/callback',
      state: 'opaque-state',
    }),
  );

  assert.equal(authUrl.origin, MYOB_SECURE_HOST);
  assert.equal(authUrl.pathname, '/oauth2/account/authorize');
  assert.equal(authUrl.searchParams.get('client_id'), 'client-id');
  assert.equal(
    authUrl.searchParams.get('redirect_uri'),
    'https://claimsure.test/oauth/myob/callback',
  );
  assert.equal(authUrl.searchParams.get('response_type'), 'code');
  assert.equal(authUrl.searchParams.get('scope'), 'CompanyFile');
  assert.equal(authUrl.searchParams.get('state'), 'opaque-state');
});

test('exchangeCode: exchanges authorization code for OAuth tokens', async () => {
  let capturedBody: string | undefined;
  nock(MYOB_SECURE_HOST)
    .post('/oauth2/v1/authorize')
    .reply(200, function (_uri, body) {
      capturedBody = requestBodyToString(body);
      return {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 3600,
        scope: 'CompanyFile',
      };
    });

  const tokens = await exchangeCode({
    client_id: 'client-id',
    client_secret: 'client-secret',
    redirect_uri: 'https://claimsure.test/oauth/myob/callback',
    code: 'code-123',
  });

  assert.ok(capturedBody);
  const body = new URLSearchParams(capturedBody);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('client_id'), 'client-id');
  assert.equal(body.get('client_secret'), 'client-secret');
  assert.equal(body.get('code'), 'code-123');
  assert.equal(body.get('redirect_uri'), 'https://claimsure.test/oauth/myob/callback');
  assert.equal(tokens.access_token, 'access-token');
  assert.equal(tokens.refresh_token, 'refresh-token');
  assert.deepEqual(tokens.scopes, ['CompanyFile']);
  assert.ok(tokens.expires_at instanceof Date);
});

test('refreshAccessToken: refreshes MYOB OAuth tokens', async () => {
  let capturedBody: string | undefined;
  nock(MYOB_SECURE_HOST)
    .post('/oauth2/v1/authorize')
    .reply(200, function (_uri, body) {
      capturedBody = requestBodyToString(body);
      return {
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
      };
    });

  const tokens = await refreshAccessToken({
    client_id: 'client-id',
    client_secret: 'client-secret',
    redirect_uri: 'https://claimsure.test/oauth/myob/callback',
    refresh_token: 'old-refresh-token',
  });

  assert.ok(capturedBody);
  const body = new URLSearchParams(capturedBody);
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('refresh_token'), 'old-refresh-token');
  assert.equal(tokens.access_token, 'new-access-token');
  assert.equal(tokens.refresh_token, 'new-refresh-token');
});
