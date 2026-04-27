import {
  XERO_CONNECTIONS_URL,
  XERO_OAUTH_AUTHORIZE_URL,
  XERO_OAUTH_TOKEN_URL,
  XERO_PAYROLL_SCOPES,
  type XeroPayrollAuthConfig,
} from './types.js';
import type { OAuthTokens } from '../../runtime/types.js';

/**
 * Xero Payroll AU OAuth flow (T-B18).
 *
 * Xero is the only provider in the codebase that mandates **PKCE** —
 * even confidential clients must include a `code_challenge` on the
 * authorize step and a matching `code_verifier` on the token-exchange
 * step (RFC 7636). The `client_secret` remains optional: omit for
 * public clients (mobile / SPA), include for confidential ones (this
 * codebase's case).
 *
 * The PKCE primitives live in `runtime/oauth.ts` — the route layer
 * generates the verifier with `generatePkceVerifier()`, derives the
 * challenge with `pkceChallengeFromVerifier()`, persists the verifier
 * (typically on the OAuth state cookie or a short-lived row), and feeds
 * it back into `exchangeCode` here on the callback.
 *
 * **Tenant-id discovery**: After `exchangeCode` succeeds the access
 * token is *not* yet bound to a specific Xero org. The orchestrator
 * calls `listConnections(access_token)` to get the array of
 * `{ tenantId, tenantName, tenantType }` the user authorized; one of
 * those `tenantId` values is then persisted onto
 * `integration_connection.external_account_id` and passed back into
 * the client on every API call as the `Xero-tenant-id` header.
 *
 * `state` is supplied by the caller — same pattern as EH/KeyPay/Deputy.
 * We keep this module DB-agnostic; persistence is the route's job.
 */

export function buildAuthUrl(
  opts: XeroPayrollAuthConfig & { state: string; pkce_challenge: string },
): string {
  const u = new URL(XERO_OAUTH_AUTHORIZE_URL);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', opts.client_id);
  u.searchParams.set('redirect_uri', opts.redirect_uri);
  u.searchParams.set('scope', XERO_PAYROLL_SCOPES.join(' '));
  u.searchParams.set('state', opts.state);
  u.searchParams.set('code_challenge', opts.pkce_challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

type XeroTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
};

export async function exchangeCode(
  opts: XeroPayrollAuthConfig & { code: string; pkce_verifier: string },
): Promise<OAuthTokens> {
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('client_id', opts.client_id);
  if (opts.client_secret) body.set('client_secret', opts.client_secret);
  body.set('code', opts.code);
  body.set('redirect_uri', opts.redirect_uri);
  body.set('code_verifier', opts.pkce_verifier);

  const res = await fetch(XERO_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`xero oauth exchange: ${res.status} ${errText}`);
  }
  const data = (await res.json()) as XeroTokenResponse;
  const tokens: OAuthTokens = {
    access_token: data.access_token,
    expires_at: new Date(Date.now() + data.expires_in * 1000),
  };
  if (data.refresh_token !== undefined) tokens.refresh_token = data.refresh_token;
  if (data.scope !== undefined) tokens.scopes = data.scope.split(' ');
  return tokens;
}

/**
 * Refresh an expired Xero access token using the refresh_token grant
 * (RFC 6749 §6). Xero rotates refresh tokens on every refresh — the
 * caller MUST persist the new refresh_token (do not keep the old one).
 *
 * Note: refresh does NOT re-issue the `tenantId` set — once granted,
 * the user's authorized tenant list is stable for the life of the
 * connection. The orchestrator keeps the `external_account_id` as-is.
 */
export async function refreshAccessToken(
  opts: XeroPayrollAuthConfig & { refresh_token: string },
): Promise<OAuthTokens> {
  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('client_id', opts.client_id);
  if (opts.client_secret) body.set('client_secret', opts.client_secret);
  body.set('refresh_token', opts.refresh_token);

  const res = await fetch(XERO_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`xero oauth refresh: ${res.status} ${errText}`);
  }
  const data = (await res.json()) as XeroTokenResponse;
  const tokens: OAuthTokens = {
    access_token: data.access_token,
    expires_at: new Date(Date.now() + data.expires_in * 1000),
  };
  if (data.refresh_token !== undefined) tokens.refresh_token = data.refresh_token;
  if (data.scope !== undefined) tokens.scopes = data.scope.split(' ');
  return tokens;
}

/**
 * Per-Xero-tenant connection record returned by `GET /connections`.
 * `tenantId` is the value to pass back on every API call as the
 * `Xero-tenant-id` header. `tenantType` is typically `ORGANISATION`
 * for a normal Xero subscription.
 */
export type XeroConnection = {
  tenantId: string;
  tenantName: string;
  tenantType: string;
};

/**
 * After `exchangeCode`, call this with the fresh access_token to
 * discover which Xero tenants (organisations) the user authorized.
 * The orchestrator picks one (typically the first) and persists it as
 * `external_account_id`.
 */
export async function listConnections(access_token: string): Promise<XeroConnection[]> {
  const res = await fetch(XERO_CONNECTIONS_URL, {
    headers: {
      Authorization: `Bearer ${access_token}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`xero list connections: ${res.status} ${errText}`);
  }
  return (await res.json()) as XeroConnection[];
}
