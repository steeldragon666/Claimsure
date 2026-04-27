import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nock from 'nock';
import {
  exchangeCodeForTokens,
  generateOAuthState,
  generatePkceVerifier,
  pkceChallengeFromVerifier,
} from './oauth.js';

beforeEach(() => {
  nock.cleanAll();
});

after(() => {
  nock.cleanAll();
});

test('generatePkceVerifier returns base64url string of 43-128 chars', () => {
  const v = generatePkceVerifier();
  assert.ok(v.length >= 43 && v.length <= 128, `length ${v.length} outside spec`);
  assert.match(v, /^[A-Za-z0-9_-]+$/, 'must be base64url');
});

test('generatePkceVerifier produces unique values', () => {
  const a = generatePkceVerifier();
  const b = generatePkceVerifier();
  assert.notEqual(a, b);
});

test('pkceChallengeFromVerifier is deterministic and matches S256', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const expected = crypto.createHash('sha256').update(verifier).digest('base64url');
  const { challenge, method } = pkceChallengeFromVerifier(verifier);
  assert.equal(method, 'S256');
  assert.equal(challenge, expected);

  // Re-running yields the same value.
  const second = pkceChallengeFromVerifier(verifier);
  assert.equal(second.challenge, expected);
});

test('generateOAuthState returns a base64url string of reasonable length', () => {
  const s = generateOAuthState();
  assert.ok(s.length >= 32, `state too short: ${s.length}`);
  assert.match(s, /^[A-Za-z0-9_-]+$/);
});

test('exchangeCodeForTokens succeeds and computes expires_at', async () => {
  const before = Date.now();
  nock('https://idp.example.com')
    .post('/oauth/token', (body: string) => {
      const params = new URLSearchParams(body);
      assert.equal(params.get('grant_type'), 'authorization_code');
      assert.equal(params.get('client_id'), 'cid');
      assert.equal(params.get('client_secret'), 'csecret');
      assert.equal(params.get('code'), 'abc');
      assert.equal(params.get('code_verifier'), 'verifier');
      assert.equal(params.get('redirect_uri'), 'https://app.example.com/cb');
      return true;
    })
    .reply(200, {
      access_token: 'AT',
      refresh_token: 'RT',
      expires_in: 3600,
      scope: 'read write',
    });

  const tokens = await exchangeCodeForTokens({
    token_url: 'https://idp.example.com/oauth/token',
    client_id: 'cid',
    client_secret: 'csecret',
    code: 'abc',
    pkce_verifier: 'verifier',
    redirect_uri: 'https://app.example.com/cb',
  });

  assert.equal(tokens.access_token, 'AT');
  assert.equal(tokens.refresh_token, 'RT');
  assert.deepEqual(tokens.scopes, ['read', 'write']);
  const after = Date.now();
  // expires_at ~= now + 3600s; allow ample slack.
  const expiresMs = tokens.expires_at.getTime();
  assert.ok(expiresMs >= before + 3600_000 - 50);
  assert.ok(expiresMs <= after + 3600_000 + 50);
});

test('exchangeCodeForTokens omits client_secret when not provided (PKCE-only)', async () => {
  nock('https://idp.example.com')
    .post('/oauth/token', (body: string) => {
      const params = new URLSearchParams(body);
      return params.get('client_secret') === null;
    })
    .reply(200, {
      access_token: 'AT',
      expires_in: 600,
    });

  const tokens = await exchangeCodeForTokens({
    token_url: 'https://idp.example.com/oauth/token',
    client_id: 'cid',
    code: 'abc',
    pkce_verifier: 'verifier',
    redirect_uri: 'https://app.example.com/cb',
  });
  assert.equal(tokens.access_token, 'AT');
  assert.equal(tokens.refresh_token, undefined);
  assert.equal(tokens.scopes, undefined);
});

test('exchangeCodeForTokens throws on non-2xx', async () => {
  nock('https://idp.example.com').post('/oauth/token').reply(400, 'invalid_grant');

  await assert.rejects(
    exchangeCodeForTokens({
      token_url: 'https://idp.example.com/oauth/token',
      client_id: 'cid',
      code: 'bad',
      pkce_verifier: 'verifier',
      redirect_uri: 'https://app.example.com/cb',
    }),
    /oauth exchange failed: 400/,
  );
});
