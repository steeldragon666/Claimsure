// Test-only OIDC IdP mocking helpers. Imported only from the
// *.integration.test.ts files. The .test.ts files themselves are
// excluded from the production build (apps/api/tsconfig.json excludes
// src/**/*.test.ts), but this fixtures file is NOT — it ships in dist/
// as dead code (nothing in server.ts reaches it). That keeps eslint's
// projectService happy without splitting the source tree, and the
// devDependency-only imports (nock, jose) are inert at runtime because
// the entrypoint never resolves them.
//
// What these do
// -------------
// Nock-intercept the three endpoints openid-client v5 hits for a full
// authorization-code-with-PKCE callback flow:
//   1. GET .well-known/openid-configuration — the discovery doc
//   2. GET <jwks_uri>                       — fetched lazily during ID token verification
//   3. POST <token_endpoint>                — code-for-tokens exchange
//
// We generate a per-call RS256 keypair with jose.generateKeyPair,
// publish the public JWK at the JWKS endpoint, sign the ID token with
// the private key, and return the signed token + auth code so the test
// can drive /v1/auth/<idp>/callback. This means the production verifier
// path runs UNCHANGED — same Issuer.discover, same client.callback,
// same JWKS-based signature check; only the network is mocked.
//
// Both helpers .persist() all interceptors so a single test can issue
// multiple injects (e.g. /login then /callback) without re-arming. The
// integration tests call nock.cleanAll() in afterEach so per-test state
// doesn't bleed.
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import nock from 'nock';

export interface MockIdpResult {
  /** The ID token JWT the test will receive when it calls /token */
  idToken: string;
  /** The auth code the test should send to /callback */
  authCode: string;
  /** Convenience cleanup — equivalent to nock.cleanAll() */
  cleanup: () => void;
}

export interface MockIdpClaims {
  sub: string;
  email: string;
  name?: string;
  /** Microsoft-only stable user id; ignored by the Google helper */
  oid?: string;
  /** Must match the nonce minted by /authorize and stored in the handshake cookie */
  nonce: string;
}

/**
 * Set up nock interceptors for a Microsoft Entra OIDC flow.
 *
 * Discovers from `https://login.microsoftonline.com/${tenantId}/v2.0`,
 * publishes one public JWK, returns an ID token signed with the
 * matching private key. The token's `iss` is the Microsoft issuer, `aud`
 * is `clientId`, and the supplied claims (sub/oid/email/name/nonce) are
 * spread into the payload.
 */
export async function mockMicrosoftIdp(opts: {
  tenantId: string;
  clientId: string;
  claims: MockIdpClaims;
  authCode: string;
}): Promise<MockIdpResult> {
  const issuer = `https://login.microsoftonline.com/${opts.tenantId}/v2.0`;
  const jwksPath = '/discovery/v2.0/keys';
  const jwksUri = `${issuer}${jwksPath}`;
  const tokenPath = '/oauth2/v2.0/token';
  const tokenEndpoint = `${issuer}${tokenPath}`;
  const authEndpoint = `${issuer}/oauth2/v2.0/authorize`;

  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  publicJwk.kid = 'test-ms-key-1';

  const idToken = await new SignJWT({ ...opts.claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-ms-key-1', typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience(opts.clientId)
    .setIssuedAt()
    .setNotBefore('-1s')
    .setExpirationTime('1h')
    .sign(privateKey);

  // Discovery
  nock(issuer)
    .persist()
    .get('/.well-known/openid-configuration')
    .reply(200, {
      issuer,
      authorization_endpoint: authEndpoint,
      token_endpoint: tokenEndpoint,
      jwks_uri: jwksUri,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      scopes_supported: ['openid', 'email', 'profile'],
    });

  // JWKS — openid-client v5 fetches this lazily during ID token verification
  nock(issuer)
    .persist()
    .get(jwksPath)
    .reply(200, { keys: [publicJwk] });

  // Token exchange — production code POSTs application/x-www-form-urlencoded
  // (grant_type=authorization_code, code=<authCode>, code_verifier=<...>,
  //  client_id=<...>, client_secret=<...>, redirect_uri=<...>). We don't
  // assert on the body shape here — the goal is to feed back a signed
  // ID token regardless of how the body is encoded.
  nock(issuer).persist().post(tokenPath).reply(200, {
    access_token: 'mock-access-token',
    id_token: idToken,
    token_type: 'Bearer',
    expires_in: 3600,
    scope: 'openid email profile',
  });

  return {
    idToken,
    authCode: opts.authCode,
    cleanup: () => {
      nock.cleanAll();
    },
  };
}

/**
 * Set up nock interceptors for a Google Workspace OIDC flow.
 *
 * Mirrors mockMicrosoftIdp but with Google's hostname split:
 * - Discovery + authorize live at https://accounts.google.com
 * - JWKS at https://www.googleapis.com/oauth2/v3/certs
 * - Token at https://oauth2.googleapis.com/token
 *
 * Three different nock scopes — that's exactly what the discovery doc
 * tells openid-client to fetch from.
 */
export async function mockGoogleIdp(opts: {
  clientId: string;
  claims: MockIdpClaims;
  authCode: string;
}): Promise<MockIdpResult> {
  const issuer = 'https://accounts.google.com';
  const jwksHost = 'https://www.googleapis.com';
  const jwksPath = '/oauth2/v3/certs';
  const jwksUri = `${jwksHost}${jwksPath}`;
  const tokenHost = 'https://oauth2.googleapis.com';
  const tokenPath = '/token';
  const tokenEndpoint = `${tokenHost}${tokenPath}`;
  const authEndpoint = 'https://accounts.google.com/o/oauth2/v2/auth';

  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  publicJwk.kid = 'test-g-key-1';

  const idToken = await new SignJWT({ ...opts.claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-g-key-1', typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience(opts.clientId)
    .setIssuedAt()
    .setNotBefore('-1s')
    .setExpirationTime('1h')
    .sign(privateKey);

  nock(issuer)
    .persist()
    .get('/.well-known/openid-configuration')
    .reply(200, {
      issuer,
      authorization_endpoint: authEndpoint,
      token_endpoint: tokenEndpoint,
      jwks_uri: jwksUri,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      scopes_supported: ['openid', 'email', 'profile'],
    });

  nock(jwksHost)
    .persist()
    .get(jwksPath)
    .reply(200, { keys: [publicJwk] });

  nock(tokenHost).persist().post(tokenPath).reply(200, {
    access_token: 'mock-access-token',
    id_token: idToken,
    token_type: 'Bearer',
    expires_in: 3600,
    scope: 'openid email profile',
  });

  return {
    idToken,
    authCode: opts.authCode,
    cleanup: () => {
      nock.cleanAll();
    },
  };
}
