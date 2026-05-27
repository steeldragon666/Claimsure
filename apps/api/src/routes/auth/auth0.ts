import type { FastifyInstance } from 'fastify';
import { Issuer, type Client } from 'openid-client';
import {
  findOrCreateUser,
  generateNonce,
  generatePkce,
  generateState,
  lookupActiveTenant,
  signSession,
  type UserRow,
} from '@cpa/auth';
import { privilegedSql } from '@cpa/db/client';

export interface Auth0AuthConfig {
  domain: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  sessionSecret: string;
  cookieName: string;
  cookieSecure: boolean;
  ttlSeconds: number;
  postLoginRedirect: string;
}

const HANDSHAKE_COOKIE = 'cpa_oidc_handshake_auth0';
const HANDSHAKE_TTL_SEC = 300;

const normalizeIssuer = (domain: string): string => {
  const trimmed = domain.trim().replace(/\/+$/, '');
  return trimmed.startsWith('https://') ? trimmed : `https://${trimmed}`;
};

const buildClient = async (cfg: Auth0AuthConfig): Promise<Client> => {
  const issuer = await Issuer.discover(normalizeIssuer(cfg.domain));
  return new issuer.Client({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uris: [cfg.redirectUri],
    response_types: ['code'],
  });
};

const handshakeCookieAttrs = (cfg: Auth0AuthConfig): string =>
  `Path=/; HttpOnly; SameSite=Lax; Max-Age=${HANDSHAKE_TTL_SEC}${cfg.cookieSecure ? '; Secure' : ''}`;

const sessionCookieAttrs = (cfg: Auth0AuthConfig): string =>
  `Path=/; HttpOnly; SameSite=Lax; Max-Age=${cfg.ttlSeconds}${cfg.cookieSecure ? '; Secure' : ''}`;

function isEmailUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; constraint_name?: unknown; message?: unknown };
  if (e.code !== '23505') return false;
  if (e.constraint_name === 'user_email_unique') return true;
  return typeof e.message === 'string' && e.message.includes('user_email_unique');
}

async function findOrCreateAuth0User(input: {
  sub: string;
  email: string;
  displayName: string | null;
}): Promise<UserRow> {
  try {
    return await findOrCreateUser({
      primaryIdp: 'auth0',
      externalId: `auth0:${input.sub}`,
      email: input.email,
      displayName: input.displayName,
    });
  } catch (err) {
    if (!isEmailUniqueViolation(err)) throw err;

    const rows = await privilegedSql<UserRow[]>`
      UPDATE "user"
         SET last_login_at = NOW()
       WHERE lower(email) = lower(${input.email})
         AND deleted_at IS NULL
      RETURNING id, email, display_name AS "displayName", primary_idp AS "primaryIdp", external_id AS "externalId"
    `;
    if (!rows[0]) throw err;
    return rows[0];
  }
}

/**
 * Register Auth0 OIDC login + callback routes.
 *
 * Auth0 is the hosted-login option for production signup/login. Email signup
 * can still create a trial firm first; if that same person later signs in
 * through Auth0, we accept only a verified email claim and attach the session
 * to the existing user row instead of creating a duplicate account.
 */
export async function registerAuth0Auth(
  app: FastifyInstance,
  cfg: Auth0AuthConfig,
): Promise<void> {
  const client = await buildClient(cfg);

  app.get('/v1/auth/auth0/login', async (_req, reply) => {
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

  app.get('/v1/auth/auth0/callback', async (req, reply) => {
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
      req.log.error({ err }, 'oidc auth0 callback failed');
      return reply.status(401).send({
        error: 'oidc_failed',
        message: 'OIDC verification failed',
        requestId: req.id,
      });
    }

    const idClaims = tokenSet.claims();
    const sub = idClaims.sub;
    const email = idClaims.email;
    const emailVerified = idClaims.email_verified;
    if (typeof sub !== 'string' || typeof email !== 'string') {
      return reply.status(401).send({
        error: 'missing_claim',
        message: 'Auth0 did not return required sub+email claims',
        requestId: req.id,
      });
    }
    if (emailVerified !== true) {
      return reply.status(401).send({
        error: 'email_not_verified',
        message: 'Auth0 must return a verified email before ArchiveOne can create a session',
        requestId: req.id,
      });
    }

    const user = await findOrCreateAuth0User({
      sub,
      email,
      displayName: typeof idClaims.name === 'string' ? idClaims.name : null,
    });
    const active = await lookupActiveTenant(user.id);

    const jwt = await signSession(
      {
        sub: user.id,
        email: user.email,
        primaryIdp: user.primaryIdp,
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
