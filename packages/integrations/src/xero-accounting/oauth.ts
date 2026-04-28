import {
  XERO_CONNECTIONS_URL,
  XERO_OAUTH_AUTHORIZE_URL,
  XERO_OAUTH_TOKEN_URL,
  XERO_ACCOUNTING_SCOPES,
  type XeroAccountingAuthConfig,
} from './types.js';
import type { OAuthTokens } from '../runtime/types.js';

/**
 * Xero Accounting OAuth flow (T-B1).
 *
 * Mirrors `payroll/xero-payroll/oauth.ts` — same PKCE primitives, same
 * Xero identity host, same encrypted-token storage convention — but
 * targets the Accounting API scope set instead of Payroll AU. A single
 * Xero account can therefore power both swimlanes simultaneously: one
 * `integration_connection` row with `provider='xero_payroll'` and
 * another with `provider='xero_accounting'`.
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
 * `integration_connection.external_account_id` and passed back into the
 * client on every API call as the `Xero-tenant-id` header.
 *
 * `state` is supplied by the caller — same pattern as the payroll
 * counterpart. We keep this module DB-agnostic; persistence is the
 * route's job.
 *
 * **SECURITY — plaintext-token boundary**: `exchangeCode` and
 * `refreshAccessToken` return `OAuthTokens` with PLAINTEXT
 * `access_token` and `refresh_token` strings. Callers MUST encrypt
 * these with `encryptToken()` from `@cpa/integrations/runtime` before
 * persisting to `integration_connection.encrypted_credentials_blob`.
 * The route layer (e.g. `apps/api/src/routes/integrations.ts`) owns
 * that encryption step — this module never touches the DB.
 */

/**
 * Subtracted from token expiry to account for clock skew + network
 * latency between Xero's auth server and our app servers. 60 seconds is
 * conventional for short-lived OAuth tokens; matches the tolerance Xero
 * recommends in their auth-flow guide. Applied uniformly in both
 * `exchangeCode` and `refreshAccessToken` so the persisted `expires_at`
 * is always slightly earlier than Xero's view, prompting an early
 * refresh rather than a 401 mid-request.
 */
const SKEW_BUFFER_MS = 60_000;

export function buildAuthUrl(
  opts: XeroAccountingAuthConfig & { state: string; pkce_challenge: string },
): string {
  const u = new URL(XERO_OAUTH_AUTHORIZE_URL);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', opts.client_id);
  u.searchParams.set('redirect_uri', opts.redirect_uri);
  u.searchParams.set('scope', XERO_ACCOUNTING_SCOPES.join(' '));
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

/**
 * Exchange an authorization code for OAuth tokens (PKCE flow).
 *
 * SECURITY: The returned `OAuthTokens` contain PLAINTEXT access and
 * refresh tokens. Caller MUST encrypt with `encryptToken()` from
 * `@cpa/integrations/runtime` before persisting to
 * `integration_connection.encrypted_credentials_blob`. The route layer
 * (e.g. `apps/api/src/routes/integrations.ts`) is responsible for this
 * — this module never touches the DB.
 *
 * The returned `expires_at` already accounts for `SKEW_BUFFER_MS` of
 * clock-skew tolerance, so callers can treat it as the wall-clock
 * deadline to refresh by.
 */
export async function exchangeCode(
  opts: XeroAccountingAuthConfig & { code: string; pkce_verifier: string },
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
    throw new Error(`xero accounting oauth exchange: ${res.status} ${errText}`);
  }
  const data = (await res.json()) as XeroTokenResponse;
  const tokens: OAuthTokens = {
    access_token: data.access_token,
    expires_at: new Date(Date.now() + data.expires_in * 1000 - SKEW_BUFFER_MS),
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
 * SECURITY: The returned `OAuthTokens` contain PLAINTEXT access and
 * refresh tokens. Caller MUST encrypt with `encryptToken()` from
 * `@cpa/integrations/runtime` before persisting to
 * `integration_connection.encrypted_credentials_blob`. The route layer
 * (e.g. `apps/api/src/routes/integrations.ts`) is responsible for this
 * — this module never touches the DB.
 *
 * Note: refresh does NOT re-issue the `tenantId` set — once granted,
 * the user's authorized tenant list is stable for the life of the
 * connection. The orchestrator keeps the `external_account_id` as-is.
 *
 * The returned `expires_at` already accounts for `SKEW_BUFFER_MS` of
 * clock-skew tolerance.
 */
export async function refreshAccessToken(
  opts: XeroAccountingAuthConfig & { refresh_token: string },
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
    throw new Error(`xero accounting oauth refresh: ${res.status} ${errText}`);
  }
  const data = (await res.json()) as XeroTokenResponse;
  const tokens: OAuthTokens = {
    access_token: data.access_token,
    expires_at: new Date(Date.now() + data.expires_in * 1000 - SKEW_BUFFER_MS),
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
    throw new Error(`xero accounting list connections: ${res.status} ${errText}`);
  }
  return (await res.json()) as XeroConnection[];
}
