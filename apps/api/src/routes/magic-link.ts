import crypto from 'node:crypto';
import { SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import { privilegedSql } from '@cpa/db/client';
import {
  magicLinkRedeemBody,
  type Employee,
  type MagicLinkRedeemBrand,
  type PayrollProvider,
} from '@cpa/schemas';
import { MOBILE_AUDIENCE } from '../middleware/mobile-jwt-verifier.js';

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1h, matches design doc §3.1
const REFRESH_TOKEN_TTL_DAYS = 90; // sliding window per design doc §3.2

interface EmployeeRow {
  id: string;
  subject_tenant_id: string;
  tenant_id: string;
  email: string;
  name: string;
  job_title: string | null;
  payroll_external_id: string | null;
  payroll_provider: PayrollProvider | null;
  invited_at: Date | string;
  invited_by_user_id: string;
  first_seen_at: Date | string | null;
  last_seen_at: Date | string | null;
  deactivated_at: Date | string | null;
}

interface BrandRow {
  display_name: string;
  primary_color: string;
  accent_color: string;
  logo_s3_key: string | null;
}

const isoOf = (v: Date | string): string => (typeof v === 'string' ? v : v.toISOString());
const isoOrNull = (v: Date | string | null): string | null => (v === null ? null : isoOf(v));

const toApiEmployee = (r: EmployeeRow): Employee => ({
  id: r.id,
  subject_tenant_id: r.subject_tenant_id,
  tenant_id: r.tenant_id,
  email: r.email,
  name: r.name,
  job_title: r.job_title,
  payroll_external_id: r.payroll_external_id,
  payroll_provider: r.payroll_provider,
  invited_at: isoOf(r.invited_at),
  invited_by_user_id: r.invited_by_user_id,
  first_seen_at: isoOrNull(r.first_seen_at),
  last_seen_at: isoOrNull(r.last_seen_at),
  deactivated_at: isoOrNull(r.deactivated_at),
});

const errEnvelope = (
  code: string,
  message: string,
  requestId: string,
): { error: { code: string; message: string }; requestId: string } => ({
  error: { code, message },
  requestId,
});

/**
 * Sign a mobile-API access token.
 *
 * Mirrors the F5 verifier's expectations: aud='mobile', sub=employee.id,
 * + custom claims tenant_id + subject_tenant_id. HS256 with the same
 * SESSION_JWT_SECRET as the consultant session — the audience is what
 * separates the two, not the key.
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
 * Mint a fresh refresh token + its hex SHA-256 digest. The raw token is
 * returned to the client; only the hash is persisted.
 */
function mintRefreshToken(): { rawToken: string; tokenHash: string } {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  return { rawToken, tokenHash };
}

const sessionSecret = (): string => {
  const v = process.env['SESSION_JWT_SECRET'];
  if (typeof v !== 'string' || v.length === 0) {
    // Production must set this. We deliberately don't fall back to a
    // dev-only constant here — F7 mints credentials, not a no-op.
    throw new Error('SESSION_JWT_SECRET unset');
  }
  return v;
};

/**
 * Register POST /v1/auth/magic-link/redeem (T-F7).
 *
 * Bootstraps a mobile session from the magic-link emailed at invite-time:
 *   1. Hash the raw token; look up the magic_link_token row.
 *   2. 401 if missing, expired, or already consumed.
 *   3. Mark consumed_at = NOW().
 *   4. Resolve the employee + their tenant + brand_config display fields.
 *   5. Mint refresh_token (random 32 bytes) + insert mobile_session row
 *      (90d sliding window).
 *   6. Sign access_token (1h, aud='mobile').
 *   7. Return { access_token, refresh_token, employee, brand_config }.
 *
 * NOT auth-gated — the magic link IS the auth signal. All DB I/O uses
 * privilegedSql since no tenant context is set during redemption.
 */
export function registerMagicLinkRedeem(app: FastifyInstance): void {
  app.post('/v1/auth/magic-link/redeem', async (req, reply) => {
    const parsed = magicLinkRedeemBody.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send(
          errEnvelope(
            'INVALID_BODY',
            'Body must be { token, device_fingerprint, push_token? }',
            req.id,
          ),
        );
    }
    const { token, device_fingerprint, push_token } = parsed.data;

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // Step 1: look up the magic-link row by hash. Single-row matchby
    // unique index (token_hash). Capture expires_at and consumed_at so
    // we can decide which 401 reason applies.
    const tokenRows = await privilegedSql<
      {
        id: string;
        employee_id: string;
        expires_at: Date;
        consumed_at: Date | null;
      }[]
    >`
      SELECT id, employee_id, expires_at, consumed_at
        FROM magic_link_token
       WHERE token_hash = ${tokenHash}
    `;
    const tokenRow = tokenRows[0];
    if (!tokenRow) {
      return reply
        .status(401)
        .send(errEnvelope('UNAUTHENTICATED', 'invalid or expired token', req.id));
    }
    const now = Date.now();
    if (tokenRow.consumed_at !== null) {
      return reply.status(401).send(errEnvelope('UNAUTHENTICATED', 'token already used', req.id));
    }
    if (new Date(tokenRow.expires_at).getTime() <= now) {
      return reply
        .status(401)
        .send(errEnvelope('UNAUTHENTICATED', 'invalid or expired token', req.id));
    }

    // Step 2: mark consumed. Use a conditional UPDATE so a concurrent
    // redeem (eg. user double-tapped the deep link) doesn't double-mint
    // sessions — only the first UPDATE returns a row.
    const consumed = await privilegedSql<{ id: string }[]>`
      UPDATE magic_link_token
         SET consumed_at = NOW()
       WHERE id = ${tokenRow.id} AND consumed_at IS NULL
      RETURNING id
    `;
    if (!consumed[0]) {
      // Lost the race; the other handler is the authoritative redeemer.
      return reply.status(401).send(errEnvelope('UNAUTHENTICATED', 'token already used', req.id));
    }

    // Step 3: load the employee. RLS bypassed (privilegedSql) since we
    // don't have tenant context yet — the token IS the auth signal.
    // Reject deactivated employees: a token persists 15min and we
    // shouldn't bootstrap a session for someone who's been removed.
    const employeeRows = await privilegedSql<EmployeeRow[]>`
      SELECT id, subject_tenant_id, tenant_id, email, name, job_title,
             payroll_external_id, payroll_provider, invited_at,
             invited_by_user_id, first_seen_at, last_seen_at, deactivated_at
        FROM subject_tenant_employee
       WHERE id = ${tokenRow.employee_id}
    `;
    const employeeRow = employeeRows[0];
    if (!employeeRow || employeeRow.deactivated_at !== null) {
      return reply.status(401).send(errEnvelope('UNAUTHENTICATED', 'employee not active', req.id));
    }

    // Step 4: load the firm's brand. Public-by-design display fields only.
    const brandRows = await privilegedSql<BrandRow[]>`
      SELECT display_name, primary_color, accent_color, logo_s3_key
        FROM brand_config
       WHERE tenant_id = ${employeeRow.tenant_id}
    `;
    // Fallback if the firm hasn't customised yet — give the platform
    // defaults so the mobile app can render *something* reasonable. The
    // brand_config row is created at firm onboarding (P2 onboard-tenant
    // tool), but we don't want a redeem to 500 on a stale dev DB.
    const brand: MagicLinkRedeemBrand = brandRows[0] ?? {
      display_name: 'CPA Platform',
      primary_color: '#0066cc',
      accent_color: '#00a86b',
      logo_s3_key: null,
    };

    // Step 5: mint refresh token + persist mobile_session row.
    const { rawToken: refreshToken, tokenHash: refreshTokenHash } = mintRefreshToken();
    const expiresAt = new Date(now + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
    await privilegedSql`
      INSERT INTO mobile_session (
        id, employee_id, device_fingerprint, refresh_token_hash, expires_at, push_token
      ) VALUES (
        ${crypto.randomUUID()}, ${employeeRow.id}, ${device_fingerprint},
        ${refreshTokenHash}, ${expiresAt.toISOString()}::timestamptz,
        ${push_token ?? null}
      )
    `;

    // Step 6: bump first_seen_at / last_seen_at on the employee row.
    // first_seen_at flips on the first redeem only.
    await privilegedSql`
      UPDATE subject_tenant_employee
         SET first_seen_at = COALESCE(first_seen_at, NOW()),
             last_seen_at = NOW()
       WHERE id = ${employeeRow.id}
    `;

    // Step 7: sign access token + assemble response.
    const accessToken = await signMobileAccessToken({
      employeeId: employeeRow.id,
      tenantId: employeeRow.tenant_id,
      subjectTenantId: employeeRow.subject_tenant_id,
      secret: sessionSecret(),
    });

    return reply.status(200).send({
      access_token: accessToken,
      refresh_token: refreshToken,
      employee: toApiEmployee(employeeRow),
      brand_config: brand,
    });
  });
}
