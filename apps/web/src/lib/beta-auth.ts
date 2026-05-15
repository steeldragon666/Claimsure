import { SignJWT, jwtVerify } from 'jose';

/**
 * Parse the BETA_ALLOWLIST env-var format into a Set for O(1) membership.
 *
 * Format: comma-separated emails, with optional whitespace around commas.
 * Emails are lowercased + trimmed; empty entries (from double-commas or a
 * trailing comma) are dropped so editing the env var is forgiving.
 */
export function parseAllowlist(raw: string): Set<string> {
  return new Set(
    raw
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0),
  );
}

const ISS = 'claimsure-beta';

/** typ claim on each kind of JWT. Verifier asserts this. */
export type TokenType = 'beta-link' | 'beta-session';

/** Default lifetimes. Magic link is short-lived; session is 30 days. */
const MAGIC_LINK_TTL_SECONDS = 15 * 60;

function secretToKey(secret: string): Uint8Array {
  if (secret.length !== 64) {
    throw new Error('BETA_AUTH_SECRET must be 32-byte hex (64 hex chars)');
  }
  return new Uint8Array(secret.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
}

/**
 * Mint a 15-min magic-link JWT for the given (lowercased) email.
 */
export async function mintMagicLinkToken(email: string, secret: string): Promise<string> {
  return await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISS)
    .setSubject(email)
    .setIssuedAt()
    .setExpirationTime(`${MAGIC_LINK_TTL_SECONDS}s`)
    .setNotBefore('0s')
    .setAudience('beta-link')
    .sign(secretToKey(secret));
}

/**
 * Verify a JWT of the given expected type. Throws on:
 *   - signature mismatch
 *   - expired
 *   - wrong typ claim (e.g. session token presented as a magic link)
 *
 * Returns { email } on success.
 */
export async function verifyToken(
  token: string,
  expectedType: TokenType,
  secret: string,
): Promise<{ email: string }> {
  const { payload } = await jwtVerify(token, secretToKey(secret), {
    issuer: ISS,
    audience: expectedType,
  });
  const email = payload.sub;
  if (typeof email !== 'string' || email.length === 0) {
    throw new Error('beta-auth: token missing sub claim');
  }
  return { email };
}

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

/**
 * Mint a 30-day session JWT (the cookie value).
 */
export async function mintSessionToken(email: string, secret: string): Promise<string> {
  return await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISS)
    .setSubject(email)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .setNotBefore('0s')
    .setAudience('beta-session')
    .sign(secretToKey(secret));
}
