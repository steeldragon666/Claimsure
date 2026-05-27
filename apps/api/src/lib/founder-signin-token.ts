/**
 * Founder-issued magic-signin token — HS256 JWT signed with
 * SESSION_JWT_SECRET (the same secret as session cookies, so the surface
 * area for secret rotation is identical).
 *
 * Issued by the founder-approve route after a 1-click override turns a
 * `claude_deny` decision into an approved tenant. The applicant receives an
 * email with a single link of the shape:
 *
 *     {PUBLIC_BASE_URL}/v1/auth/founder-issued-signin?token=<jwt>
 *
 * The link sets a session cookie and redirects to /subject-tenants.
 *
 * Custom claim `kind: 'founder-issued-signin'` discriminates this token from
 * a normal session JWT — even though both are signed with the same secret,
 * we refuse to accept a regular session JWT here (defence in depth against
 * someone replaying a leaked cookie at this endpoint to harvest a fresh
 * cookie). Issuer/audience also differ.
 *
 * Default TTL: 24 hours.
 */
import { jwtVerify, SignJWT } from 'jose';

const ISSUER = 'cpa-platform';
const AUDIENCE = 'cpa-founder-issued-signin';
const KIND = 'founder-issued-signin' as const;

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

const secretToKey = (secret: string): Uint8Array => new TextEncoder().encode(secret);

export interface FounderSigninPayload {
  /** User id (sub). */
  sub: string;
  /** User email — defence-in-depth check on verify. */
  email: string;
  /** Tenant id the link signs the user in to. */
  tenantId: string;
}

export interface VerifiedFounderSigninPayload extends FounderSigninPayload {
  iat: number;
  exp: number;
}

export interface SignFounderSigninTokenOptions {
  /** Override the 24h default TTL — tests pass a short value or negative for expiry. */
  ttlSeconds?: number;
}

export async function signFounderSigninToken(
  payload: FounderSigninPayload,
  secret: string,
  options: SignFounderSigninTokenOptions = {},
): Promise<string> {
  if (secret.length === 0) {
    throw new Error('signFounderSigninToken: secret must be non-empty');
  }
  const ttl = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    email: payload.email,
    tenantId: payload.tenantId,
    kind: KIND,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(payload.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .sign(secretToKey(secret));
}

/**
 * Verify the JWT and return the payload. Throws on invalid signature,
 * wrong issuer/audience, expired exp, or kind mismatch.
 */
export async function verifyFounderSigninToken(
  jwt: string,
  secret: string,
): Promise<VerifiedFounderSigninPayload> {
  const { payload } = await jwtVerify(jwt, secretToKey(secret), {
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  if (payload['kind'] !== KIND) {
    throw new Error('founder-signin: unexpected token kind');
  }
  const email = payload['email'];
  const tenantId = payload['tenantId'];
  if (typeof email !== 'string' || email.length === 0) {
    throw new Error('founder-signin: missing email claim');
  }
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    throw new Error('founder-signin: missing tenantId claim');
  }
  return {
    sub: String(payload.sub),
    email,
    tenantId,
    iat: Number(payload.iat),
    exp: Number(payload.exp),
  };
}
