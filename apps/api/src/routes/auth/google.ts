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

export interface GoogleAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  sessionSecret: string;
  cookieName: string;
  cookieSecure: boolean;
  ttlSeconds: number;
  postLoginRedirect: string;
}

const HANDSHAKE_COOKIE = 'cpa_oidc_handshake_g';
const HANDSHAKE_TTL_SEC = 300;

const buildClient = async (cfg: GoogleAuthConfig): Promise<Client> => {
  const issuer = await Issuer.discover('https://accounts.google.com');
  return new issuer.Client({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uris: [cfg.redirectUri],
    response_types: ['code'],
  });
};

const handshakeCookieAttrs = (cfg: GoogleAuthConfig): string =>
  `Path=/; HttpOnly; SameSite=Lax; Max-Age=${HANDSHAKE_TTL_SEC}${cfg.cookieSecure ? '; Secure' : ''}`;

const sessionCookieAttrs = (cfg: GoogleAuthConfig): string =>
  `Path=/; HttpOnly; SameSite=Lax; Max-Age=${cfg.ttlSeconds}${cfg.cookieSecure ? '; Secure' : ''}`;

/**
 * Register Google Workspace OIDC login + callback routes.
 *
 * Mirrors the Microsoft flow (T7) with these IdP-specific differences:
 * - discovery URL: https://accounts.google.com
 * - stable user identifier claim: 'sub' (vs Microsoft's 'oid')
 * - externalId format: 'google:<sub>'
 * - handshake cookie: cpa_oidc_handshake_g (separate from MS's _ms)
 *
 * Session cookie name is shared with Microsoft — both IdPs produce a
 * compatible session JWT consumed by the same sessionPlugin middleware.
 */
export async function registerGoogleAuth(
  app: FastifyInstance,
  cfg: GoogleAuthConfig,
): Promise<void> {
  const client = await buildClient(cfg);

  app.get('/v1/auth/google/login', async (_req, reply) => {
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

  app.get('/v1/auth/google/callback', async (req, reply) => {
    const handshakeCookie = (req.cookies as Record<string, string | undefined>)[HANDSHAKE_COOKIE];
    if (!handshakeCookie) {
      return reply.status(400).send({
        error: 'missing_handshake',
        message: 'OIDC handshake cookie missing',
        requestId: req.id,
      });
    }
    let handshake: { verifier: string; state: string; nonce: string };
    try {
      handshake = JSON.parse(decodeURIComponent(handshakeCookie)) as typeof handshake;
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
      req.log.error({ err }, 'oidc google callback failed');
      return reply.status(401).send({
        error: 'oidc_failed',
        message: 'OIDC verification failed',
        requestId: req.id,
      });
    }

    const idClaims = tokenSet.claims();
    const sub = idClaims.sub;
    const email = idClaims.email;
    if (typeof sub !== 'string' || typeof email !== 'string') {
      return reply.status(401).send({
        error: 'missing_claim',
        message: 'IdP did not return required sub+email claims',
        requestId: req.id,
      });
    }

    const user = await findOrCreateUser({
      primaryIdp: 'google',
      externalId: `google:${sub}`,
      email,
      displayName: typeof idClaims.name === 'string' ? idClaims.name : null,
    });
    const active = await lookupActiveTenant(user.id);

    const jwt = await signSession(
      {
        sub: user.id,
        email: user.email,
        primaryIdp: 'google',
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
