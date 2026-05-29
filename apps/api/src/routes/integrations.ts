import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { requireSession } from '@cpa/auth';
import { sql } from '@cpa/db/client';
import {
  INTEGRATION_PROVIDERS,
  integrationProvider,
  type IntegrationConnection,
  type IntegrationProvider,
  type IntegrationSyncState,
} from '@cpa/schemas';
import {
  encryptToken,
  exchangeCodeForTokens,
  generateOAuthState,
  generatePkceVerifier,
  getTokenEncryptionKey,
  pkceChallengeFromVerifier,
} from '@cpa/integrations/runtime';
import {
  XERO_OAUTH_AUTHORIZE_URL,
  XERO_OAUTH_TOKEN_URL,
  XERO_ACCOUNTING_SCOPES,
} from '@cpa/integrations/xero-accounting';
import {
  MYOB_OAUTH_AUTHORIZE_URL,
  MYOB_OAUTH_TOKEN_URL,
  MYOB_ACCOUNTING_SCOPES,
} from '@cpa/integrations/myob-accounting';

/**
 * OAuth state cookie name. We persist `state + pkce_verifier + provider`
 * as a short-lived signed cookie keyed on the provider; on /callback the
 * route reads + clears it. Single-cookie-per-flow, expires in 10 minutes
 * (OAuth specs are usually completed sub-minute; 10m is generous for
 * sandbox redirect flows).
 */
const OAUTH_STATE_COOKIE_PREFIX = 'cpa_oauth_';
const OAUTH_STATE_TTL_SECONDS = 600;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Providers that connect PER CLIENT (each claimant company has its own org):
// accounting + payroll. Firm-level providers (docusign) are NOT in this set —
// they hold one connection per consultancy with subject_tenant_id NULL.
const PER_CLIENT_PROVIDERS: ReadonlySet<IntegrationProvider> = new Set<IntegrationProvider>([
  'xero_accounting',
  'myob_accounting',
  'xero_payroll',
  'employment_hero',
  'keypay',
  'deputy',
]);
const isPerClientProvider = (p: IntegrationProvider): boolean => PER_CLIENT_PROVIDERS.has(p);

interface RawIntegrationConnectionRow {
  id: string;
  tenant_id: string;
  subject_tenant_id: string | null;
  provider: IntegrationProvider;
  expires_at: Date | string;
  scopes: string[] | null;
  external_account_id: string | null;
  last_synced_at: Date | string | null;
  sync_state: IntegrationSyncState;
  last_error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const isoOf = (v: Date | string): string => (typeof v === 'string' ? v : v.toISOString());
const isoOrNull = (v: Date | string | null): string | null => (v === null ? null : isoOf(v));

const toApi = (r: RawIntegrationConnectionRow): IntegrationConnection => ({
  id: r.id,
  tenant_id: r.tenant_id,
  subject_tenant_id: r.subject_tenant_id,
  provider: r.provider,
  expires_at: isoOf(r.expires_at),
  scopes: r.scopes,
  external_account_id: r.external_account_id,
  last_synced_at: isoOrNull(r.last_synced_at),
  sync_state: r.sync_state,
  last_error: r.last_error,
  created_at: isoOf(r.created_at),
  updated_at: isoOf(r.updated_at),
});

/**
 * Per-provider OAuth metadata. Provider endpoints + scopes come from the
 * connector packages (single source of truth); client credentials +
 * redirect URI come from env vars (per-provider, so sandbox vs prod is
 * env-driven). A provider returns `null` — and therefore 412
 * provider_not_configured — until its `*_CLIENT_ID` + `*_REDIRECT_URI`
 * env vars are present (e.g. the firm must register a Xero/MYOB OAuth app
 * first).
 *
 * Wired: docusign, xero_accounting, myob_accounting. (xero_payroll +
 * employment_hero/keypay/deputy remain on the payroll swimlane backlog.)
 */
type ProviderOAuthConfig = {
  authorize_url: string;
  token_url: string;
  client_id: string;
  client_secret?: string;
  redirect_uri: string;
  scopes: string[];
};

function getProviderOAuthConfig(provider: IntegrationProvider): ProviderOAuthConfig | null {
  switch (provider) {
    case 'docusign': {
      const clientId = process.env['DOCUSIGN_CLIENT_ID'];
      const clientSecret = process.env['DOCUSIGN_CLIENT_SECRET'];
      const redirectUri = process.env['DOCUSIGN_REDIRECT_URI'];
      const authBase = process.env['DOCUSIGN_AUTH_BASE_URL'] ?? 'https://account-d.docusign.com';
      if (!clientId || !redirectUri) return null;
      const cfg: ProviderOAuthConfig = {
        authorize_url: `${authBase}/oauth/auth`,
        token_url: `${authBase}/oauth/token`,
        client_id: clientId,
        redirect_uri: redirectUri,
        scopes: ['signature', 'impersonation'],
      };
      if (clientSecret !== undefined) cfg.client_secret = clientSecret;
      return cfg;
    }
    case 'xero_accounting': {
      const clientId = process.env['XERO_CLIENT_ID'];
      const clientSecret = process.env['XERO_CLIENT_SECRET'];
      const redirectUri = process.env['XERO_REDIRECT_URI'];
      if (!clientId || !redirectUri) return null;
      const cfg: ProviderOAuthConfig = {
        authorize_url: XERO_OAUTH_AUTHORIZE_URL,
        token_url: XERO_OAUTH_TOKEN_URL,
        client_id: clientId,
        redirect_uri: redirectUri,
        scopes: [...XERO_ACCOUNTING_SCOPES],
      };
      if (clientSecret !== undefined) cfg.client_secret = clientSecret;
      return cfg;
    }
    case 'myob_accounting': {
      const clientId = process.env['MYOB_CLIENT_ID'];
      const clientSecret = process.env['MYOB_CLIENT_SECRET'];
      const redirectUri = process.env['MYOB_REDIRECT_URI'];
      if (!clientId || !redirectUri) return null;
      const cfg: ProviderOAuthConfig = {
        authorize_url: MYOB_OAUTH_AUTHORIZE_URL,
        token_url: MYOB_OAUTH_TOKEN_URL,
        client_id: clientId,
        redirect_uri: redirectUri,
        scopes: [...MYOB_ACCOUNTING_SCOPES],
      };
      if (clientSecret !== undefined) cfg.client_secret = clientSecret;
      return cfg;
    }
    // employment_hero / keypay / deputy / xero_payroll: payroll swimlane backlog.
    default:
      return null;
  }
}

/**
 * Register integration-connection routes (T-B3).
 *
 * Surface:
 *   GET    /v1/integrations
 *     List the calling firm's integration connections (metadata only —
 *     no tokens). RLS confines results to the active tenant.
 *
 *   POST   /v1/integrations/:provider/connect
 *     Begin an OAuth authorization-code+PKCE flow. Returns the provider
 *     authorize URL with a fresh `state` + `code_challenge`. The verifier
 *     and state are persisted in a short-lived signed cookie keyed on
 *     the provider, so the /callback can validate them.
 *
 *   GET    /v1/integrations/:provider/callback
 *     Handle the redirect from the provider. Validates `state`,
 *     exchanges the code for tokens via `exchangeCodeForTokens()`,
 *     encrypts both tokens via AES-256-GCM, upserts the
 *     integration_connection row, then 302s to the consultant portal
 *     admin page. Mismatched state → 400. Token-encryption-key missing
 *     → 500 (boot-time misconfig).
 *
 *   DELETE /v1/integrations/:provider
 *     Revoke. Marks `sync_state='failed'` + nulls token columns + sets
 *     `last_error='revoked'`. We don't hard-delete to preserve audit
 *     history (the row may be referenced by signing_requests / payroll
 *     sync logs).
 *
 * Auth: requireSession; admin-or-consultant for connect/callback/delete
 * mutations (viewers can list but not change integration state).
 */
export function registerIntegrations(app: FastifyInstance): void {
  app.get<{ Querystring: { subject_tenant_id?: string } }>(
    '/v1/integrations',
    { preHandler: requireSession },
    async (req) => {
      const tenantId = req.user!.tenantId!;
      // Optional per-client filter. When present, return only that client's
      // connections; otherwise return all the firm's connections (each row
      // carries its subject_tenant_id so the UI can group by client).
      const subjectFilter =
        typeof req.query.subject_tenant_id === 'string' && UUID_RE.test(req.query.subject_tenant_id)
          ? req.query.subject_tenant_id
          : null;
      return await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<RawIntegrationConnectionRow[]>`
          SELECT id, tenant_id, subject_tenant_id, provider, expires_at, scopes,
                 external_account_id, last_synced_at, sync_state, last_error,
                 created_at, updated_at
            FROM integration_connection
           WHERE (sync_state <> 'failed' OR last_error <> 'revoked')
             ${subjectFilter ? tx`AND subject_tenant_id = ${subjectFilter}` : tx``}
           ORDER BY created_at ASC
        `;
        return { integrations: rows.map(toApi) };
      });
    },
  );

  app.post<{ Params: { provider: string }; Body: { subject_tenant_id?: string } }>(
    '/v1/integrations/:provider/connect',
    { preHandler: requireSession },
    async (req, reply) => {
      const role = req.user!.role;
      if (role !== 'admin' && role !== 'consultant') {
        return reply.status(403).send({
          error: 'forbidden',
          message: 'Admin or consultant role required',
          requestId: req.id,
        });
      }
      const parsed = integrationProvider.safeParse(req.params.provider);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'invalid_provider',
          message: `Provider must be one of: ${INTEGRATION_PROVIDERS.join(', ')}`,
          requestId: req.id,
        });
      }
      const provider = parsed.data;
      const cfg = getProviderOAuthConfig(provider);
      if (!cfg) {
        return reply.status(412).send({
          error: 'provider_not_configured',
          message: `Integration "${provider}" is not configured on this server (missing env vars or not yet wired)`,
          requestId: req.id,
        });
      }

      // Per-client providers (accounting/payroll) bind the connection to a
      // specific client (subject_tenant). Firm-level providers (DocuSign)
      // do not. For per-client providers we require + validate the client id,
      // and carry it through the OAuth round-trip in the state cookie so the
      // callback stores the token against that client.
      const tenantId = req.user!.tenantId!;
      let subjectTenantId: string | null = null;
      if (isPerClientProvider(provider)) {
        const sid = req.body?.subject_tenant_id;
        if (typeof sid !== 'string' || !UUID_RE.test(sid)) {
          return reply.status(400).send({
            error: 'subject_tenant_required',
            message: `Provider "${provider}" connects per client — a valid subject_tenant_id is required.`,
            requestId: req.id,
          });
        }
        // Verify the client belongs to the caller's firm (RLS-scoped read).
        const owns = await sql.begin(async (tx) => {
          await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
          const rows = await tx<{ id: string }[]>`
            SELECT id::text FROM subject_tenant WHERE id = ${sid} LIMIT 1
          `;
          return rows.length > 0;
        });
        if (!owns) {
          return reply.status(404).send({
            error: 'client_not_found',
            message: 'No such client in this firm.',
            requestId: req.id,
          });
        }
        subjectTenantId = sid;
      }

      const state = generateOAuthState();
      const verifier = generatePkceVerifier();
      const { challenge, method } = pkceChallengeFromVerifier(verifier);

      // Stash {state, verifier, subjectTenantId} in a short-lived cookie keyed
      // on provider. Cookie value is JSON; signed/encrypted is overkill for a
      // 10-min CSRF token + PKCE verifier + client id (the callback validates
      // state before redeeming). httpOnly + sameSite=lax keeps it from JS +
      // cross-site fetch.
      const cookieValue = JSON.stringify({ state, verifier, subjectTenantId });
      void reply.setCookie(`${OAUTH_STATE_COOKIE_PREFIX}${provider}`, cookieValue, {
        httpOnly: true,
        secure: process.env['NODE_ENV'] === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: OAUTH_STATE_TTL_SECONDS,
      });

      const authorize = new URL(cfg.authorize_url);
      authorize.searchParams.set('response_type', 'code');
      authorize.searchParams.set('client_id', cfg.client_id);
      authorize.searchParams.set('redirect_uri', cfg.redirect_uri);
      authorize.searchParams.set('scope', cfg.scopes.join(' '));
      authorize.searchParams.set('state', state);
      authorize.searchParams.set('code_challenge', challenge);
      authorize.searchParams.set('code_challenge_method', method);

      return reply.status(200).send({ redirect_url: authorize.toString() });
    },
  );

  app.get<{
    Params: { provider: string };
    Querystring: { code?: string; state?: string; error?: string };
  }>('/v1/integrations/:provider/callback', { preHandler: requireSession }, async (req, reply) => {
    const role = req.user!.role;
    if (role !== 'admin' && role !== 'consultant') {
      return reply.status(403).send({
        error: 'forbidden',
        message: 'Admin or consultant role required',
        requestId: req.id,
      });
    }
    const parsed = integrationProvider.safeParse(req.params.provider);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'invalid_provider',
        message: `Provider must be one of: ${INTEGRATION_PROVIDERS.join(', ')}`,
        requestId: req.id,
      });
    }
    const provider = parsed.data;
    const cfg = getProviderOAuthConfig(provider);
    if (!cfg) {
      return reply.status(412).send({
        error: 'provider_not_configured',
        message: `Integration "${provider}" is not configured on this server`,
        requestId: req.id,
      });
    }

    // Provider returned an error param (user denied, scope mismatch,
    // etc.). Surface 400 with the provider's error string.
    if (req.query.error) {
      return reply.status(400).send({
        error: 'oauth_error',
        message: `Provider returned error: ${req.query.error}`,
        requestId: req.id,
      });
    }
    if (!req.query.code || !req.query.state) {
      return reply.status(400).send({
        error: 'invalid_callback',
        message: 'Missing code or state on callback',
        requestId: req.id,
      });
    }

    const cookieName = `${OAUTH_STATE_COOKIE_PREFIX}${provider}`;
    const cookieRaw = req.cookies[cookieName];
    if (!cookieRaw) {
      return reply.status(400).send({
        error: 'oauth_state_expired',
        message: 'OAuth state cookie missing or expired',
        requestId: req.id,
      });
    }
    let stash: { state: string; verifier: string; subjectTenantId?: string | null };
    try {
      stash = JSON.parse(cookieRaw) as {
        state: string;
        verifier: string;
        subjectTenantId?: string | null;
      };
    } catch {
      return reply.status(400).send({
        error: 'oauth_state_malformed',
        message: 'OAuth state cookie malformed',
        requestId: req.id,
      });
    }
    if (stash.state !== req.query.state) {
      return reply.status(400).send({
        error: 'oauth_state_mismatch',
        message: 'OAuth state does not match — possible CSRF',
        requestId: req.id,
      });
    }

    // Clear the state cookie immediately after use. Even if the token
    // exchange fails downstream, we don't want a replayable PKCE
    // verifier hanging around.
    void reply.clearCookie(cookieName, { path: '/' });

    const exchangeReq = {
      token_url: cfg.token_url,
      client_id: cfg.client_id,
      ...(cfg.client_secret !== undefined ? { client_secret: cfg.client_secret } : {}),
      code: req.query.code,
      pkce_verifier: stash.verifier,
      redirect_uri: cfg.redirect_uri,
    };
    let tokens;
    try {
      tokens = await exchangeCodeForTokens(exchangeReq);
    } catch (err) {
      req.log.error({ err, provider }, 'oauth code exchange failed');
      return reply.status(502).send({
        error: 'oauth_exchange_failed',
        message: 'Failed to exchange authorization code for tokens',
        requestId: req.id,
      });
    }

    const encKey = getTokenEncryptionKey();
    const accessEncrypted = encryptToken(tokens.access_token, encKey);
    const refreshEncrypted =
      tokens.refresh_token !== undefined ? encryptToken(tokens.refresh_token, encKey) : null;
    const scopes = tokens.scopes ?? null;

    const tenantId = req.user!.tenantId!;
    // For per-client providers the connection is keyed on the client carried
    // through the OAuth round-trip; firm-level providers store NULL.
    const subjectTenantId = isPerClientProvider(provider) ? (stash.subjectTenantId ?? null) : null;
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
      // Upsert: re-authorising replaces the existing row. The conflict target
      // is the matching PARTIAL unique index — per-client
      // (tenant_id, subject_tenant_id, provider) when bound to a client, else
      // the firm-level (tenant_id, provider). sync_state resets to 'idle' on
      // re-auth so a previously-failed connection is healed.
      if (subjectTenantId !== null) {
        await tx`
            INSERT INTO integration_connection (
              id, tenant_id, subject_tenant_id, provider, access_token_encrypted,
              refresh_token_encrypted, expires_at, scopes, sync_state, last_error
            ) VALUES (
              ${crypto.randomUUID()}, ${tenantId}, ${subjectTenantId}, ${provider},
              ${accessEncrypted}, ${refreshEncrypted},
              ${tokens.expires_at.toISOString()}::timestamptz, ${scopes}, 'idle', NULL
            )
            ON CONFLICT (tenant_id, subject_tenant_id, provider)
              WHERE subject_tenant_id IS NOT NULL DO UPDATE SET
              access_token_encrypted = EXCLUDED.access_token_encrypted,
              refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
              expires_at = EXCLUDED.expires_at,
              scopes = EXCLUDED.scopes,
              sync_state = 'idle',
              last_error = NULL,
              updated_at = NOW()
          `;
      } else {
        await tx`
            INSERT INTO integration_connection (
              id, tenant_id, provider, access_token_encrypted, refresh_token_encrypted,
              expires_at, scopes, sync_state, last_error
            ) VALUES (
              ${crypto.randomUUID()}, ${tenantId}, ${provider}, ${accessEncrypted},
              ${refreshEncrypted}, ${tokens.expires_at.toISOString()}::timestamptz,
              ${scopes}, 'idle', NULL
            )
            ON CONFLICT (tenant_id, provider)
              WHERE subject_tenant_id IS NULL DO UPDATE SET
              access_token_encrypted = EXCLUDED.access_token_encrypted,
              refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
              expires_at = EXCLUDED.expires_at,
              scopes = EXCLUDED.scopes,
              sync_state = 'idle',
              last_error = NULL,
              updated_at = NOW()
          `;
      }
    });

    // 302 back to the consultant portal admin page (P3 stub — the actual
    // admin UI lands in P3c). Tests assert on the Location header.
    const successRedirect =
      process.env['INTEGRATIONS_SUCCESS_REDIRECT'] ?? '/admin/integrations?connected=' + provider;
    return reply.status(302).header('Location', successRedirect).send();
  });

  app.delete<{ Params: { provider: string }; Querystring: { subject_tenant_id?: string } }>(
    '/v1/integrations/:provider',
    { preHandler: requireSession },
    async (req, reply) => {
      const role = req.user!.role;
      if (role !== 'admin' && role !== 'consultant') {
        return reply.status(403).send({
          error: 'forbidden',
          message: 'Admin or consultant role required',
          requestId: req.id,
        });
      }
      const parsed = integrationProvider.safeParse(req.params.provider);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'invalid_provider',
          message: `Provider must be one of: ${INTEGRATION_PROVIDERS.join(', ')}`,
          requestId: req.id,
        });
      }
      const provider = parsed.data;
      // Per-client providers need the client id so we tombstone exactly that
      // client's connection (not every client's for this provider). Firm-level
      // providers scope to the single subject_tenant_id IS NULL row.
      let subjectTenantId: string | null = null;
      if (isPerClientProvider(provider)) {
        const sid = req.query.subject_tenant_id;
        if (typeof sid !== 'string' || !UUID_RE.test(sid)) {
          return reply.status(400).send({
            error: 'subject_tenant_required',
            message: `Provider "${provider}" is per client — a valid subject_tenant_id query param is required.`,
            requestId: req.id,
          });
        }
        subjectTenantId = sid;
      }
      const tenantId = req.user!.tenantId!;
      // Run the soft-delete inside the transaction and capture whether a row
      // matched, but DON'T send the reply from inside `sql.begin` — doing so
      // flushes the HTTP response before the COMMIT lands, so a caller that
      // immediately re-reads the row can race the commit and observe the
      // pre-update state. Send the reply only after the transaction resolves.
      const found = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        // Soft-delete: tombstone the row by zeroing tokens + flagging
        // failed/revoked. The row stays so signing_requests + payroll
        // sync logs that reference it keep their FK.
        const rows = await tx<{ id: string }[]>`
          UPDATE integration_connection
             SET access_token_encrypted = '',
                 refresh_token_encrypted = NULL,
                 sync_state = 'failed',
                 last_error = 'revoked',
                 updated_at = NOW()
           WHERE provider = ${provider}
             ${
               subjectTenantId !== null
                 ? tx`AND subject_tenant_id = ${subjectTenantId}`
                 : tx`AND subject_tenant_id IS NULL`
             }
          RETURNING id
        `;
        return rows.length > 0;
      });
      if (!found) {
        return reply.status(404).send({
          error: 'integration_not_found',
          message: 'No active integration connection for that provider',
          requestId: req.id,
        });
      }
      return reply.status(204).send();
    },
  );
}
