import type { OAuthTokens } from '../runtime/types.js';
import {
  MYOB_ACCOUNTING_SCOPES,
  MYOB_OAUTH_AUTHORIZE_URL,
  MYOB_OAUTH_TOKEN_URL,
  type MyobAccountingAuthConfig,
} from './types.js';

const SKEW_BUFFER_MS = 60_000;

export function buildAuthUrl(opts: MyobAccountingAuthConfig & { state: string }): string {
  const url = new URL(MYOB_OAUTH_AUTHORIZE_URL);
  url.searchParams.set('client_id', opts.client_id);
  url.searchParams.set('redirect_uri', opts.redirect_uri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', MYOB_ACCOUNTING_SCOPES.join(' '));
  url.searchParams.set('state', opts.state);
  return url.toString();
}

type MyobTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
};

/**
 * Exchange an authorization code for MYOB OAuth tokens.
 *
 * SECURITY: Returned tokens are plaintext. Callers must encrypt them with the
 * integration runtime helpers before persisting to `integration_connection`.
 */
export async function exchangeCode(
  opts: MyobAccountingAuthConfig & { code: string },
): Promise<OAuthTokens> {
  const body = new URLSearchParams();
  body.set('client_id', opts.client_id);
  body.set('client_secret', opts.client_secret);
  body.set('grant_type', 'authorization_code');
  body.set('code', opts.code);
  body.set('redirect_uri', opts.redirect_uri);

  const res = await fetch(MYOB_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`myob accounting oauth exchange: ${res.status} ${errText}`);
  }

  return toOAuthTokens((await res.json()) as MyobTokenResponse);
}

/**
 * Refresh an expired MYOB access token.
 *
 * SECURITY: Returned tokens are plaintext. The route layer owns encryption and
 * persistence, matching the Xero integration boundary.
 */
export async function refreshAccessToken(
  opts: MyobAccountingAuthConfig & { refresh_token: string },
): Promise<OAuthTokens> {
  const body = new URLSearchParams();
  body.set('client_id', opts.client_id);
  body.set('client_secret', opts.client_secret);
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', opts.refresh_token);

  const res = await fetch(MYOB_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`myob accounting oauth refresh: ${res.status} ${errText}`);
  }

  return toOAuthTokens((await res.json()) as MyobTokenResponse);
}

function toOAuthTokens(data: MyobTokenResponse): OAuthTokens {
  const tokens: OAuthTokens = {
    access_token: data.access_token,
    expires_at: new Date(Date.now() + data.expires_in * 1000 - SKEW_BUFFER_MS),
  };
  if (data.refresh_token !== undefined) tokens.refresh_token = data.refresh_token;
  if (data.scope !== undefined) tokens.scopes = data.scope.split(' ');
  return tokens;
}

