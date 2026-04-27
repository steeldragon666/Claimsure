import {
  DEPUTY_OAUTH_AUTHORIZE_URL,
  DEPUTY_OAUTH_TOKEN_URL,
  DEPUTY_SCOPES,
  type DeputyAuthConfig,
} from './types.js';
import type { OAuthTokens } from '../../runtime/types.js';

/**
 * Deputy OAuth flow (T-B15).
 *
 * Deputy uses the standard OAuth 2.0 authorization-code grant (RFC 6749
 * §4.1) over a shared host — `once.deputy.com` handles both the
 * authorize and token endpoints. We treat this app as a confidential
 * client (`client_secret` on every token request) — Deputy does not
 * accept PKCE.
 *
 * The notable wrinkle vs EH: the token-exchange response includes an
 * `endpoint` field carrying the customer's install URL (e.g.
 * `https://acme.deputy.com`). The orchestrator persists this onto
 * `integration_connection.external_account_id` so the client knows
 * which subdomain to call. We surface it as `endpoint_url` on the
 * exchange result alongside the standard OAuth fields.
 *
 * `state` is supplied by the caller (apps/api/integrations route) — the
 * route generates it via `generateOAuthState()` and round-trips it
 * through the cookie + redirect. We keep this module DB-agnostic;
 * persistence is the route's job.
 */

export function buildAuthUrl(opts: DeputyAuthConfig & { state: string }): string {
  const u = new URL(DEPUTY_OAUTH_AUTHORIZE_URL);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', opts.client_id);
  u.searchParams.set('redirect_uri', opts.redirect_uri);
  u.searchParams.set('scope', DEPUTY_SCOPES.join(' '));
  u.searchParams.set('state', opts.state);
  return u.toString();
}

type DeputyTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
  /** Deputy-specific: the customer's install URL (e.g. https://acme.deputy.com). */
  endpoint?: string;
};

export type DeputyExchangeResult = OAuthTokens & {
  /** The customer's Deputy install URL — persist as `external_account_id`. */
  endpoint_url: string;
};

export async function exchangeCode(
  opts: DeputyAuthConfig & { code: string },
): Promise<DeputyExchangeResult> {
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('client_id', opts.client_id);
  body.set('client_secret', opts.client_secret);
  body.set('code', opts.code);
  body.set('redirect_uri', opts.redirect_uri);
  body.set('scope', DEPUTY_SCOPES.join(' '));

  const res = await fetch(DEPUTY_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`deputy oauth exchange: ${res.status} ${errText}`);
  }
  const data = (await res.json()) as DeputyTokenResponse;
  if (!data.endpoint) {
    throw new Error('deputy oauth exchange: missing endpoint in token response');
  }
  const result: DeputyExchangeResult = {
    access_token: data.access_token,
    expires_at: new Date(Date.now() + data.expires_in * 1000),
    endpoint_url: data.endpoint,
  };
  if (data.refresh_token !== undefined) result.refresh_token = data.refresh_token;
  if (data.scope !== undefined) result.scopes = data.scope.split(' ');
  return result;
}

/**
 * Refresh an expired access token using the refresh_token grant
 * (RFC 6749 §6). Deputy may or may not return a new refresh_token on
 * refresh — when absent, the caller should keep the existing one.
 *
 * Note: refresh does NOT re-issue the `endpoint` field — the install
 * URL is established once at first auth and persists for the life of
 * the connection.
 */
export async function refreshAccessToken(
  opts: DeputyAuthConfig & { refresh_token: string },
): Promise<OAuthTokens> {
  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('client_id', opts.client_id);
  body.set('client_secret', opts.client_secret);
  body.set('refresh_token', opts.refresh_token);
  body.set('scope', DEPUTY_SCOPES.join(' '));

  const res = await fetch(DEPUTY_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`deputy oauth refresh: ${res.status} ${errText}`);
  }
  const data = (await res.json()) as DeputyTokenResponse;
  const tokens: OAuthTokens = {
    access_token: data.access_token,
    expires_at: new Date(Date.now() + data.expires_in * 1000),
  };
  if (data.refresh_token !== undefined) tokens.refresh_token = data.refresh_token;
  if (data.scope !== undefined) tokens.scopes = data.scope.split(' ');
  return tokens;
}
