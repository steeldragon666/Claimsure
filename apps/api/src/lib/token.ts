import { randomBytes } from 'node:crypto';

/**
 * Generate an opaque, URL-safe public token (base64url, no padding).
 *
 * Used for token-gated public endpoints where the token IS the auth
 * signal — e.g. the engagement-letter `send_token` that authorises the
 * web fallback at `/engagement/[token]/sign`. The 32-byte default gives
 * 256 bits of entropy, well past any practical brute-force budget.
 *
 * `base64url` is chosen over hex (more compact, ~43 chars vs 64) and
 * over standard base64 (avoids `+` / `/` / `=` which need extra URL
 * escaping). Node's `randomBytes` is CSPRNG-backed (libcrypto), so the
 * resulting string is suitable as a credential, not just an identifier.
 *
 * Constant-time comparison of tokens lives at the call site (see
 * `dev-login.ts` for the canonical `timingSafeEqual` pattern). This
 * helper deliberately does NOT expose a `compare` function: the
 * compare must happen against the candidate token presented by the
 * caller, not against the freshly-generated one.
 */
export function generateOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
