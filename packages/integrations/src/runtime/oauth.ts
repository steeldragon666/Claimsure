import crypto from 'node:crypto';
import type { OAuthTokens } from './types.js';

/**
 * Generate a PKCE verifier per RFC 7636: 32 bytes of CSPRNG output, encoded
 * as base64url. The resulting string is 43 characters (well within the
 * 43–128 char range the spec mandates).
 */
export function generatePkceVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Derive an S256 PKCE challenge from a verifier. The challenge is
 * `base64url(SHA-256(verifier))` — deterministic, so the same verifier
 * always produces the same challenge.
 */
export function pkceChallengeFromVerifier(verifier: string): {
  challenge: string;
  method: 'S256';
} {
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { challenge, method: 'S256' };
}

/**
 * Generate a CSRF-safe `state` parameter for an OAuth authorization
 * request. 32 bytes of CSPRNG, base64url-encoded.
 */
export function generateOAuthState(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export type OAuthCallbackParams = {
  code: string;
  state: string;
  expected_state: string;
  pkce_verifier: string;
};

export type OAuthExchangeRequest = {
  token_url: string;
  client_id: string;
  /** Optional: omitted for public clients using PKCE-only flows. */
  client_secret?: string;
  code: string;
  pkce_verifier: string;
  redirect_uri: string;
};

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
};

/**
 * Exchange an authorization code for tokens using PKCE
 * (RFC 6749 §4.1.3 + RFC 7636). The returned `expires_at` is computed
 * client-side from `expires_in` so callers don't have to track wall-clock
 * arithmetic themselves.
 */
export async function exchangeCodeForTokens(
  req: OAuthExchangeRequest,
): Promise<OAuthTokens> {
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('client_id', req.client_id);
  if (req.client_secret) body.set('client_secret', req.client_secret);
  body.set('code', req.code);
  body.set('code_verifier', req.pkce_verifier);
  body.set('redirect_uri', req.redirect_uri);

  const res = await fetch(req.token_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`oauth exchange failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as TokenResponse;
  const tokens: OAuthTokens = {
    access_token: data.access_token,
    expires_at: new Date(Date.now() + data.expires_in * 1000),
  };
  if (data.refresh_token !== undefined) tokens.refresh_token = data.refresh_token;
  if (data.scope !== undefined) tokens.scopes = data.scope.split(' ');
  return tokens;
}
