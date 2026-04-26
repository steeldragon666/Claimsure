import type { FastifyInstance } from 'fastify';
import { Issuer, type Client } from 'openid-client';
import {
  findOrCreateUser,
  generateNonce,
  generatePkce,
  generateState,
  lookupActiveTenant,
  signSession,
} from '@cpa/auth';

export interface MicrosoftAuthConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  sessionSecret: string;
  cookieName: string;
  cookieSecure: boolean;
  ttlSeconds: number;
  postLoginRedirect: string;
}

const HANDSHAKE_COOKIE = 'cpa_oidc_handshake_ms';
const HANDSHAKE_TTL_SEC = 300;

const buildClient = async (cfg: MicrosoftAuthConfig): Promise<Client> => {
  const issuer = await Issuer.discover(`https://login.microsoftonline.com/${cfg.tenantId}/v2.0`);
  return new issuer.Client({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uris: [cfg.redirectUri],
    response_types: ['code'],
  });
};

const handshakeCookieAttrs = (cfg: MicrosoftAuthConfig): string =>
  `Path=/; HttpOnly; SameSite=Lax; Max-Age=${HANDSHAKE_TTL_SEC}${cfg.cookieSecure ? '; Secure' : ''}`;

const sessionCookieAttrs = (cfg: MicrosoftAuthConfig): string =>
  `Path=/; HttpOnly; SameSite=Lax; Max-Age=${cfg.ttlSeconds}${cfg.cookieSecure ? '; Secure' : ''}`;

/**
 * Register Microsoft Entra OIDC login + callback routes.
 *
 * /v1/auth/microsoft/login generates a PKCE+state+nonce handshake,
 * stores it in a 5-min sameSite=Lax cookie, and 302s to login.microsoftonline.com.
 *
 * /v1/auth/microsoft/callback verifies state, exchanges code for tokens
 * (PKCE-protected), verifies the ID token, finds-or-creates the user,
 * looks up the active tenant, signs our session JWT, sets cpa_session
 * cookie, clears the handshake cookie, 302s to /.
 *
 * Errors return JSON envelopes per the API's existing error pattern.
 * Async config loading (Issuer.discover) happens at registration time
 * so the route handlers themselves stay sync about IdP discovery.
 */
export async function registerMicrosoftAuth(
  app: FastifyInstance,
  cfg: MicrosoftAuthConfig,
): Promise<void> {
  const client = await buildClient(cfg);

  app.get('/v1/auth/microsoft/login', async (_req, reply) => {
    const { verifier, challenge, method } = generatePkce();
    const state = generateState();
    const nonce = generateNonce();

    const url = client.authorizationUrl({
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: method,
    });

    const handshake = JSON.stringify({ verifier, state, nonce });
    void reply.header(
      'set-cookie',
      `${HANDSHAKE_COOKIE}=${encodeURIComponent(handshake)}; ${handshakeCookieAttrs(cfg)}`,
    );
    return reply.redirect(url, 302);
  });

  app.get('/v1/auth/microsoft/callback', async (req, reply) => {
    const handshakeCookie = req.cookies[HANDSHAKE_COOKIE];
    if (!handshakeCookie) {
      return reply.status(400).send({
        error: 'missing_handshake',
        message: 'OIDC handshake cookie missing',
        requestId: req.id,
      });
    }
    let handshake: { verifier: string; state: string; nonce: string };
    try {
      handshake = JSON.parse(decodeURIComponent(handshakeCookie)) as {
        verifier: string;
        state: string;
        nonce: string;
      };
    } catch {
      return reply.status(400).send({
        error: 'invalid_handshake',
        message: 'OIDC handshake cookie malformed',
        requestId: req.id,
      });
    }

    const params = client.callbackParams(req.raw);

    let tokenSet: Awaited<ReturnType<typeof client.callback>>;
    try {
      tokenSet = await client.callback(cfg.redirectUri, params, {
        state: handshake.state,
        nonce: handshake.nonce,
        code_verifier: handshake.verifier,
      });
    } catch (err) {
      req.log.error({ err }, 'oidc microsoft callback failed');
      return reply.status(401).send({
        error: 'oidc_failed',
        message: 'OIDC verification failed',
        requestId: req.id,
      });
    }

    const idClaims = tokenSet.claims();
    const oid = idClaims['oid'];
    const email = idClaims.email;
    if (typeof oid !== 'string' || typeof email !== 'string') {
      return reply.status(401).send({
        error: 'missing_claim',
        message: 'IdP did not return required oid+email claims',
        requestId: req.id,
      });
    }

    const user = await findOrCreateUser({
      primaryIdp: 'microsoft',
      externalId: `microsoft:${oid}`,
      email,
      displayName: typeof idClaims.name === 'string' ? idClaims.name : null,
    });
    const active = await lookupActiveTenant(user.id);

    const jwt = await signSession(
      {
        sub: user.id,
        email: user.email,
        primaryIdp: 'microsoft',
        activeTenantId: active.activeTenantId,
        activeRole: active.activeRole,
        availableTenants: active.availableTenants.map(({ tenantId, name, slug, role }) => ({
          tenantId,
          name,
          slug,
          role,
        })),
      },
      cfg.sessionSecret,
      { ttlSeconds: cfg.ttlSeconds },
    );

    void reply.header('set-cookie', [
      `${cfg.cookieName}=${jwt}; ${sessionCookieAttrs(cfg)}`,
      `${HANDSHAKE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    ]);
    return reply.redirect(cfg.postLoginRedirect, 302);
  });
}
