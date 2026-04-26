import { jwtVerify, SignJWT } from 'jose';

export interface AvailableTenant {
  tenantId: string;
  name: string;
  slug: string;
  role: 'admin' | 'consultant' | 'viewer';
}

export interface SessionClaims {
  sub: string;
  email: string;
  primaryIdp: 'microsoft' | 'google';
  activeTenantId: string | null;
  activeRole: 'admin' | 'consultant' | 'viewer' | null;
  availableTenants: AvailableTenant[];
}

export interface VerifiedSession extends SessionClaims {
  iat: number;
  exp: number;
}

const ISSUER = 'cpa-platform';
const AUDIENCE = 'cpa-api';

const secretToKey = (secret: string): Uint8Array => new TextEncoder().encode(secret);

export interface SignOptions {
  ttlSeconds: number;
}

/**
 * Sign a session JWT (HS256) carrying the user's identity, active tenant,
 * and the firms they belong to. Cookie value at runtime.
 *
 * The TTL is added to the issued-at time to compute exp. Negative TTL
 * is allowed (for tests that need an expired token).
 */
export async function signSession(
  claims: SessionClaims,
  secret: string,
  opts: SignOptions,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(claims.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + opts.ttlSeconds)
    .sign(secretToKey(secret));
}

/**
 * Verify a session JWT and return the claims. Throws on invalid signature,
 * wrong issuer/audience, or expired exp. jose's jwtVerify does the
 * standard JWT validations natively (signature, exp, nbf, iss, aud).
 */
export async function verifySession(jwt: string, secret: string): Promise<VerifiedSession> {
  const { payload } = await jwtVerify(jwt, secretToKey(secret), {
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  return {
    sub: String(payload.sub),
    email: String(payload['email']),
    primaryIdp: payload['primaryIdp'] as 'microsoft' | 'google',
    activeTenantId: (payload['activeTenantId'] as string | null) ?? null,
    activeRole: (payload['activeRole'] as 'admin' | 'consultant' | 'viewer' | null) ?? null,
    availableTenants: (payload['availableTenants'] as AvailableTenant[]) ?? [],
    iat: Number(payload.iat),
    exp: Number(payload.exp),
  };
}
