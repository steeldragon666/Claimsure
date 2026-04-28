import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nock from 'nock';
import { buildAuthUrl, exchangeCode, refreshAccessToken, listConnections } from './oauth.js';
import {
  XERO_OAUTH_AUTHORIZE_URL,
  XERO_ACCOUNTING_SCOPES,
  XERO_ACCOUNTING_PROVIDER,
} from './types.js';
import {
  generatePkceVerifier,
  pkceChallengeFromVerifier,
  generateOAuthState,
} from '../runtime/oauth.js';

const TENANT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

beforeEach(() => {
  nock.cleanAll();
});

after(() => {
  nock.cleanAll();
});

// -- Provider key sanity ----------------------------------------------

test('provider key is xero_accounting (distinct from xero_payroll)', () => {
  // Stable contract — F4 schema decision; B7 stub-routing depends on it.
  assert.equal(XERO_ACCOUNTING_PROVIDER, 'xero_accounting');
});

// -- Scope set ---------------------------------------------------------

test('XERO_ACCOUNTING_SCOPES matches the plan-mandated set', () => {
  // Plan calls for exactly these four scopes — order doesn't matter for
  // OAuth, but document the expected set as a stable contract.
  assert.deepEqual([...XERO_ACCOUNTING_SCOPES].sort(), [
    'accounting.contacts',
    'accounting.settings',
    'accounting.transactions',
    'offline_access',
  ]);
});

// -- PKCE state generation --------------------------------------------
//
// The PKCE primitives live in runtime/oauth.ts (shared with xero-payroll
// and any future PKCE-mandated provider). These tests pin down the
// behaviour the xero-accounting OAuth flow relies on: that
// generatePkceVerifier produces a spec-conformant string, that
// pkceChallengeFromVerifier deterministically derives an S256 challenge,
// and that buildAuthUrl forwards both the state and the challenge into
// the authorize URL.

test('generatePkceVerifier: 43–128 char base64url string per RFC 7636', () => {
  const v = generatePkceVerifier();
  assert.ok(v.length >= 43 && v.length <= 128, `length ${v.length} out of spec`);
  assert.match(v, /^[A-Za-z0-9_-]+$/, 'must be base64url');
});

test('generatePkceVerifier: produces unique values across calls', () => {
  const a = generatePkceVerifier();
  const b = generatePkceVerifier();
  assert.notEqual(a, b);
});

test('pkceChallengeFromVerifier: deterministic + S256', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const expected = crypto.createHash('sha256').update(verifier).digest('base64url');
  const { challenge, method } = pkceChallengeFromVerifier(verifier);
  assert.equal(method, 'S256');
  assert.equal(challenge, expected);

  // Re-running yields the same value.
  const second = pkceChallengeFromVerifier(verifier);
  assert.equal(second.challenge, expected);
});

test('generateOAuthState: base64url string of reasonable length', () => {
  const s = generateOAuthState();
  assert.ok(s.length >= 32, `state too short: ${s.length}`);
  assert.match(s, /^[A-Za-z0-9_-]+$/);
});

// -- buildAuthUrl ------------------------------------------------------

test('buildAuthUrl: returns authorize URL with PKCE challenge + state', () => {
  // Use the real PKCE primitives to verify the integration end-to-end.
  const verifier = generatePkceVerifier();
  const { challenge } = pkceChallengeFromVerifier(verifier);
  const state = generateOAuthState();

  const url = buildAuthUrl({
    client_id: 'cid',
    client_secret: 'csecret',
    redirect_uri: 'https://app.example/cb',
    state,
    pkce_challenge: challenge,
  });

  const u = new URL(url);
  assert.equal(`${u.origin}${u.pathname}`, XERO_OAUTH_AUTHORIZE_URL);
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('client_id'), 'cid');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://app.example/cb');
  assert.equal(u.searchParams.get('state'), state);
  assert.equal(u.searchParams.get('scope'), XERO_ACCOUNTING_SCOPES.join(' '));
  // PKCE: challenge present + S256 method.
  assert.equal(u.searchParams.get('code_challenge'), challenge);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
});

test('buildAuthUrl: scope contains the four accounting + offline_access scopes', () => {
  const url = buildAuthUrl({
    client_id: 'cid',
    redirect_uri: 'https://app.example/cb',
    state: 's',
    pkce_challenge: 'c',
  });
  const scope = new URL(url).searchParams.get('scope') ?? '';
  const parts = scope.split(' ').sort();
  assert.deepEqual(parts, [
    'accounting.contacts',
    'accounting.settings',
    'accounting.transactions',
    'offline_access',
  ]);
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

// -- exchangeCode (token-exchange parsing) ----------------------------

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
      scope: 'accounting.transactions accounting.contacts accounting.settings offline_access',
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
  assert.deepEqual(tokens.scopes, [
    'accounting.transactions',
    'accounting.contacts',
    'accounting.settings',
    'offline_access',
  ]);
  // expires_at ~= now + 1800s − SKEW_BUFFER_MS (60s) = now + 1740s.
  // The 60s skew buffer is subtracted in oauth.ts so the persisted
  // deadline is slightly earlier than Xero's view, prompting an early
  // refresh rather than a 401 mid-request.
  const expiresMs = tokens.expires_at.getTime();
  assert.ok(expiresMs >= before + 1740 * 1000 - 50);
  assert.ok(expiresMs <= afterTs + 1740 * 1000 + 50);

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

test('exchangeCode: omits refresh_token / scopes when not present in response', async () => {
  // Some Xero responses omit refresh_token if offline_access wasn't
  // granted — the parser must not invent fields.
  nock('https://identity.xero.com').post('/connect/token').reply(200, {
    access_token: 'AT',
    expires_in: 1800,
  });

  const tokens = await exchangeCode({
    client_id: 'cid',
    redirect_uri: 'https://app.example/cb',
    code: 'c',
    pkce_verifier: 'v',
  });
  assert.equal(tokens.access_token, 'AT');
  assert.equal(tokens.refresh_token, undefined);
  assert.equal(tokens.scopes, undefined);
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
    /xero accounting oauth exchange: 400 invalid_grant/,
  );
});

// -- refreshAccessToken (rotation) ------------------------------------

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
  // Critical: the new refresh_token MUST replace the old one — the
  // caller persists this back to integration_connection.
  assert.equal(tokens.refresh_token, 'xero-refresh-new');
  assert.notEqual(tokens.refresh_token, 'xero-refresh-old');

  assert.ok(capturedBody);
  const parsed = new URLSearchParams(capturedBody);
  assert.equal(parsed.get('grant_type'), 'refresh_token');
  assert.equal(parsed.get('refresh_token'), 'xero-refresh-old');
  assert.equal(parsed.get('client_id'), 'cid');
  assert.equal(parsed.get('client_secret'), 'csecret');
});

test('refreshAccessToken: response without refresh_token → undefined (caller keeps old one)', async () => {
  // Defensive: if Xero ever returns a response missing refresh_token
  // (sliding-window refresh, or partial response), we must not fabricate
  // a value. Caller logic decides whether to keep old or fail loudly.
  nock('https://identity.xero.com').post('/connect/token').reply(200, {
    access_token: 'xero-access-new',
    expires_in: 1800,
  });

  const tokens = await refreshAccessToken({
    client_id: 'cid',
    redirect_uri: 'https://app.example/cb',
    refresh_token: 'xero-refresh-old',
  });
  assert.equal(tokens.access_token, 'xero-access-new');
  assert.equal(tokens.refresh_token, undefined);
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
    /xero accounting oauth refresh: 401/,
  );
});

// -- listConnections (tenant-id discovery) ----------------------------

test('listConnections: returns tenantId array + sends bearer token', async () => {
  nock('https://api.xero.com')
    .get('/connections')
    .matchHeader('authorization', 'Bearer access-xyz')
    .reply(200, [
      {
        id: 'conn-1',
        tenantId: TENANT_ID,
        tenantType: 'ORGANISATION',
        tenantName: 'Acme Bookkeeping Pty Ltd',
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
  assert.equal(conns[0]?.tenantName, 'Acme Bookkeeping Pty Ltd');
  assert.equal(conns[1]?.tenantType, 'ORGANISATION');
});

test('listConnections: 401 throws', async () => {
  nock('https://api.xero.com').get('/connections').reply(401, 'unauthorized');
  await assert.rejects(listConnections('bad-token'), /xero accounting list connections: 401/);
});
