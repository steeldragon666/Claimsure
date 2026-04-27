import {
  EH_OAUTH_AUTHORIZE_URL,
  EH_OAUTH_TOKEN_URL,
  EH_SCOPES,
  type EmploymentHeroAuthConfig,
} from './types.js';
import type { OAuthTokens } from '../../runtime/types.js';

/**
 * Employment Hero OAuth flow (T-B8).
 *
 * EH uses the standard OAuth 2.0 authorization-code grant (RFC 6749 §4.1)
 * and treats this app as a confidential client — `client_secret` is sent
 * on every token request. No PKCE is required (or accepted) by EH at the
 * authorize endpoint, so we skip the verifier/challenge dance the
 * generic `runtime/oauth.ts` exchange uses for DocuSign.
 *
 * `state` is supplied by the caller (apps/api/integrations route) — they
 * generate it via `generateOAuthState()` and round-trip it through the
 * cookie + redirect. We keep this module DB-agnostic; persistence is
 * the route's job.
 */

export function buildAuthUrl(opts: EmploymentHeroAuthConfig & { state: string }): string {
  const u = new URL(EH_OAUTH_AUTHORIZE_URL);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', opts.client_id);
  u.searchParams.set('redirect_uri', opts.redirect_uri);
  u.searchParams.set('scope', EH_SCOPES.join(' '));
  u.searchParams.set('state', opts.state);
  return u.toString();
}

type EmploymentHeroTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
};

export async function exchangeCode(
  opts: EmploymentHeroAuthConfig & { code: string },
): Promise<OAuthTokens> {
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('client_id', opts.client_id);
  body.set('client_secret', opts.client_secret);
  body.set('code', opts.code);
  body.set('redirect_uri', opts.redirect_uri);

  const res = await fetch(EH_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`employment_hero oauth exchange: ${res.status} ${errText}`);
  }
  const data = (await res.json()) as EmploymentHeroTokenResponse;
  const tokens: OAuthTokens = {
    access_token: data.access_token,
    expires_at: new Date(Date.now() + data.expires_in * 1000),
  };
  if (data.refresh_token !== undefined) tokens.refresh_token = data.refresh_token;
  if (data.scope !== undefined) tokens.scopes = data.scope.split(' ');
  return tokens;
}

/**
 * Refresh an expired access token using the refresh_token grant
 * (RFC 6749 §6). EH may or may not return a new refresh_token on
 * refresh — when absent, the caller should keep the existing one.
 */
export async function refreshAccessToken(
  opts: EmploymentHeroAuthConfig & { refresh_token: string },
): Promise<OAuthTokens> {
  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('client_id', opts.client_id);
  body.set('client_secret', opts.client_secret);
  body.set('refresh_token', opts.refresh_token);

  const res = await fetch(EH_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`employment_hero oauth refresh: ${res.status} ${errText}`);
  }
  const data = (await res.json()) as EmploymentHeroTokenResponse;
  const tokens: OAuthTokens = {
    access_token: data.access_token,
    expires_at: new Date(Date.now() + data.expires_in * 1000),
  };
  if (data.refresh_token !== undefined) tokens.refresh_token = data.refresh_token;
  if (data.scope !== undefined) tokens.scopes = data.scope.split(' ');
  return tokens;
}
