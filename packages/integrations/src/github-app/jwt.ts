import { createSign } from 'node:crypto';

/**
 * GitHub App JWT signer (Task B.2 / P7).
 *
 * Mints a short-lived RS256 JWT that authenticates *as the App* against
 * GitHub's `/app/*` endpoints. This token is the upstream credential used
 * by `installation-token.ts` to request scoped per-installation tokens —
 * App JWTs themselves cannot read repo contents or open PRs.
 *
 * Hand-rolled with `node:crypto` rather than pulling in `jsonwebtoken` or
 * `jose`. The runtime/crypto.ts module sets the precedent: this package
 * keeps its dep tree minimal and uses Node primitives directly.
 *
 * GitHub's contract (https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app):
 *  - `alg: RS256`, `typ: JWT`
 *  - `iss`: the numeric GitHub App ID (string-encoded — JWT spec takes
 *    strings, GitHub is forgiving but we stick to the strict reading)
 *  - `iat`: issued-at, set to `now - 60s` to absorb clock skew between
 *    our app servers and GitHub's auth gate
 *  - `exp`: expiry, capped at `iat + 600s`. GitHub rejects anything
 *    longer than 10 minutes with "JWT expiration time too long".
 */

export interface CreateAppJwtOptions {
  /** Numeric GitHub App ID (e.g. "123456"). Stored as a string because
   *  that's what JWT consumers expect and what GitHub returns in webhook
   *  payloads. */
  appId: string;
  /** PEM-encoded RS256 private key (PKCS#1 or PKCS#8) — the file you
   *  download from `https://github.com/settings/apps/<slug>` after
   *  generating a private key. */
  privateKey: string;
  /** Token lifetime in seconds. Default 600 (GitHub's max). Values >600
   *  are rejected here rather than at the GitHub edge so failures
   *  surface synchronously with a clear error instead of as a 401 from
   *  the installation-token exchange. */
  ttlSeconds?: number;
  /** Override `now` for tests. Defaults to `Date.now()`. */
  now?: () => number;
}

const MAX_TTL_SECONDS = 600;
const CLOCK_SKEW_SECONDS = 60;

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export function createAppJwt(opts: CreateAppJwtOptions): string {
  const { appId, privateKey } = opts;
  const ttl = opts.ttlSeconds ?? MAX_TTL_SECONDS;
  if (ttl <= 0 || ttl > MAX_TTL_SECONDS) {
    throw new Error(
      `createAppJwt: ttlSeconds must be in (0, ${MAX_TTL_SECONDS}]; got ${String(ttl)}`,
    );
  }
  if (!appId) {
    throw new Error('createAppJwt: appId is required');
  }
  if (!privateKey) {
    throw new Error('createAppJwt: privateKey is required');
  }

  const nowMs = (opts.now ?? Date.now)();
  const nowSec = Math.floor(nowMs / 1000);
  const iat = nowSec - CLOCK_SKEW_SECONDS;
  const exp = iat + ttl;

  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iat, exp, iss: appId };

  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKey);
  const signatureB64 = base64url(signature);

  return `${signingInput}.${signatureB64}`;
}
