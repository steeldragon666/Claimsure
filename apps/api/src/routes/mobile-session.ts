import crypto from 'node:crypto';
import { SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import { privilegedSql } from '@cpa/db/client';
import { refreshTokenBody } from '@cpa/schemas';
import { MOBILE_AUDIENCE } from '../middleware/mobile-jwt-verifier.js';

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1h, matches F7
const REFRESH_TOKEN_TTL_DAYS = 90; // sliding window per design doc §3.2

const errEnvelope = (
  code: string,
  message: string,
  requestId: string,
): { error: { code: string; message: string }; requestId: string } => ({
  error: { code, message },
  requestId,
});

const sessionSecret = (): string => {
  const v = process.env['SESSION_JWT_SECRET'];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error('SESSION_JWT_SECRET unset');
  }
  return v;
};

/**
 * Sign a fresh mobile-API access token. Same shape as F7's signer —
 * deliberately duplicated rather than extracted to a shared helper so
 * each route owns its issuance contract; if F7 + F8 ever diverge on
 * audience or claims (eg. signing-event audience for a future webhook
 * route), the local copies make that obvious in diff.
 */
async function signMobileAccessToken(args: {
  employeeId: string;
  tenantId: string;
  subjectTenantId: string;
  secret: string;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const key = new TextEncoder().encode(args.secret);
  return await new SignJWT({
    tenant_id: args.tenantId,
    subject_tenant_id: args.subjectTenantId,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(args.employeeId)
    .setAudience(MOBILE_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + ACCESS_TOKEN_TTL_SECONDS)
    .sign(key);
}

/**
 * Mint a fresh refresh token + its hex SHA-256 digest.
 */
function mintRefreshToken(): { rawToken: string; tokenHash: string } {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  return { rawToken, tokenHash };
}

/**
 * Register POST /v1/auth/refresh (T-F8).
 *
 * Rotates the refresh token + extends the session expiry by 90 days.
 * No auth header required — the refresh_token IS the credential. The
 * device_fingerprint match is the additional binding so a stolen
 * refresh_token can't be replayed from a different device unless the
 * attacker also captured the keychain UUID / androidId.
 */
export function registerRefreshRoute(app: FastifyInstance): void {
  app.post('/v1/auth/refresh', async (req, reply) => {
    const parsed = refreshTokenBody.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send(
          errEnvelope(
            'INVALID_BODY',
            'Body must be { refresh_token, device_fingerprint, push_token? }',
            req.id,
          ),
        );
    }
    const { refresh_token, device_fingerprint, push_token } = parsed.data;
    const refreshHash = crypto.createHash('sha256').update(refresh_token).digest('hex');

    // Step 1: lookup the session by hash.
    const sessions = await privilegedSql<
      {
        id: string;
        employee_id: string;
        device_fingerprint: string;
        expires_at: Date;
        revoked_at: Date | null;
      }[]
    >`
      SELECT id, employee_id, device_fingerprint, expires_at, revoked_at
        FROM mobile_session
       WHERE refresh_token_hash = ${refreshHash}
    `;
    const session = sessions[0];
    if (!session) {
      return reply
        .status(401)
        .send(errEnvelope('UNAUTHENTICATED', 'invalid refresh token', req.id));
    }
    if (session.revoked_at !== null) {
      return reply.status(401).send(errEnvelope('UNAUTHENTICATED', 'session revoked', req.id));
    }
    const now = Date.now();
    if (new Date(session.expires_at).getTime() <= now) {
      return reply.status(401).send(errEnvelope('UNAUTHENTICATED', 'session expired', req.id));
    }

    // Step 2: device fingerprint must match the value stored at redeem-time.
    // 403 (not 401) since the token is structurally fine — the bind is
    // what failed, and the client app needs to disambiguate the two
    // states (re-redeem vs. logout-and-rebind).
    if (session.device_fingerprint !== device_fingerprint) {
      return reply
        .status(403)
        .send(errEnvelope('DEVICE_MISMATCH', 'device fingerprint does not match', req.id));
    }

    // Step 3: rotate. Generate a new refresh_token hash + extend
    // expires_at by 90d from now (sliding window). last_refreshed_at
    // bumps automatically via the column default — set it explicitly
    // for clarity.
    //
    // push_token: if the client supplies one, persist it. Absent
    // push_token leaves the existing value untouched (COALESCE) — so a
    // mid-life refresh from a client that hasn't yet captured a push
    // token doesn't accidentally clear a valid one previously set.
    const { rawToken: newRefresh, tokenHash: newRefreshHash } = mintRefreshToken();
    const newExpires = new Date(now + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
    const updated = await privilegedSql<{ id: string }[]>`
      UPDATE mobile_session
         SET refresh_token_hash = ${newRefreshHash},
             expires_at = ${newExpires.toISOString()}::timestamptz,
             last_refreshed_at = NOW(),
             push_token = COALESCE(${push_token ?? null}, push_token)
       WHERE id = ${session.id}
         AND revoked_at IS NULL
      RETURNING id
    `;
    if (!updated[0]) {
      // Lost a race with a concurrent refresh / revoke. Treat as 401
      // so the client re-bootstraps via magic link.
      return reply.status(401).send(errEnvelope('UNAUTHENTICATED', 'session revoked', req.id));
    }

    // Step 4: load the employee context for the access token. The
    // employee row has the tenant_id + subject_tenant_id we need to
    // mint a same-shape token to F7.
    const empRows = await privilegedSql<
      {
        tenant_id: string;
        subject_tenant_id: string;
        deactivated_at: Date | null;
      }[]
    >`
      SELECT tenant_id, subject_tenant_id, deactivated_at
        FROM subject_tenant_employee
       WHERE id = ${session.employee_id}
    `;
    const emp = empRows[0];
    if (!emp || emp.deactivated_at !== null) {
      // Edge: an admin deactivated the employee while the session was
      // alive. Revoke the session so future refreshes 401 fast.
      await privilegedSql`
        UPDATE mobile_session SET revoked_at = NOW() WHERE id = ${session.id}
      `;
      return reply.status(401).send(errEnvelope('UNAUTHENTICATED', 'employee not active', req.id));
    }

    // Step 5: bump the employee's last_seen_at — this IS active use.
    await privilegedSql`
      UPDATE subject_tenant_employee SET last_seen_at = NOW() WHERE id = ${session.employee_id}
    `;

    // Step 6: sign the new access token + return both.
    const accessToken = await signMobileAccessToken({
      employeeId: session.employee_id,
      tenantId: emp.tenant_id,
      subjectTenantId: emp.subject_tenant_id,
      secret: sessionSecret(),
    });

    return reply.status(200).send({
      access_token: accessToken,
      refresh_token: newRefresh,
    });
  });
}
