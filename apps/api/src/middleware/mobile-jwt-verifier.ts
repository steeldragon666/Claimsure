import { jwtVerify } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Mobile-side authentication principal (T-F5).
 *
 * Distinct from `req.user` (consultant-side OIDC session). The mobile app
 * runs on `subject_tenant_employee.id` — claimant employees who never have
 * a row in the firm-side `user`/`tenant_user` tables.
 *
 * `tenantId` is the consultant firm that owns the claimant; `subjectTenantId`
 * is the claimant they belong to. Both are needed:
 *   - tenantId so the RLS GUC (`app.current_tenant_id`) can be set on
 *     reads of media_artefact, time_entry, etc. (those tables are
 *     denormalised on tenant_id for index-friendly RLS — see P3 schema).
 *   - subjectTenantId so the mobile API can scope to a single claimant
 *     even if the firm has multiple.
 */
export interface MobilePrincipal {
  kind: 'employee';
  employeeId: string;
  tenantId: string;
  subjectTenantId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    mobileUser?: MobilePrincipal;
  }
}

/**
 * Audience tag on mobile JWTs. Matches what F7 (magic-link redeem) and
 * F8 (refresh) sign. Distinct from the consultant-session AUDIENCE
 * (`cpa-api`) so a leaked web cookie can't be replayed at the mobile API
 * (and vice versa).
 */
export const MOBILE_AUDIENCE = 'mobile';

/**
 * Verify a mobile-API JWT and return the principal.
 *
 * Throws on invalid signature, expired exp, wrong audience, or missing
 * required claims. The route-level wrapper (`requireMobileSession`) maps
 * the throw to a 401.
 *
 * Required claims (set by the issuer in F7/F8):
 *   - sub: subject_tenant_employee.id
 *   - tenant_id: consultant firm id (for RLS GUC)
 *   - subject_tenant_id: claimant id (for scope)
 */
export async function verifyMobileJwt(token: string, secret: Uint8Array): Promise<MobilePrincipal> {
  const { payload } = await jwtVerify(token, secret, { audience: MOBILE_AUDIENCE });
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new Error('mobile JWT missing sub');
  }
  const tenantId = payload['tenant_id'];
  const subjectTenantId = payload['subject_tenant_id'];
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    throw new Error('mobile JWT missing tenant_id');
  }
  if (typeof subjectTenantId !== 'string' || subjectTenantId.length === 0) {
    throw new Error('mobile JWT missing subject_tenant_id');
  }
  return {
    kind: 'employee',
    employeeId: payload.sub,
    tenantId,
    subjectTenantId,
  };
}

/**
 * Fastify preHandler that gates a mobile route on a valid Bearer token.
 *
 * Pattern matches the consultant-side `requireSession` from `@cpa/auth`
 * but reads from `Authorization: Bearer …` instead of a cookie (mobile
 * doesn't get cross-site cookies on a fresh native app load).
 *
 * 401 envelope follows the existing `{ error, message, requestId }`
 * shape used elsewhere in the API. Error codes use the upper-snake
 * variant the plan calls out (`UNAUTHENTICATED`).
 *
 * Reads `process.env.SESSION_JWT_SECRET` lazily (per-request) so tests
 * can swap the secret between cases without re-importing the module.
 */
export async function requireMobileSession(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
    await reply.status(401).send({
      error: { code: 'UNAUTHENTICATED', message: 'Bearer token required' },
      requestId: req.id,
    });
    return;
  }
  const token = auth.slice('Bearer '.length).trim();
  if (token.length === 0) {
    await reply.status(401).send({
      error: { code: 'UNAUTHENTICATED', message: 'Bearer token required' },
      requestId: req.id,
    });
    return;
  }
  const secretValue = process.env['SESSION_JWT_SECRET'];
  if (typeof secretValue !== 'string' || secretValue.length === 0) {
    // Production must always set this; falling through to a 500 here is
    // safer than minting a token-validation pass with an empty secret
    // (which would, in theory, accept any HS256 token signed with an
    // empty key). Surface as 500 + log so deploys flag the misconfig.
    req.log.error('SESSION_JWT_SECRET unset — refusing to verify mobile JWT');
    await reply.status(500).send({
      error: { code: 'CONFIG', message: 'auth not configured' },
      requestId: req.id,
    });
    return;
  }
  const secret = new TextEncoder().encode(secretValue);
  try {
    req.mobileUser = await verifyMobileJwt(token, secret);
  } catch {
    await reply.status(401).send({
      error: { code: 'UNAUTHENTICATED', message: 'invalid or expired token' },
      requestId: req.id,
    });
    return;
  }
}
