import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { privilegedSql } from '@cpa/db/client';
import {
  CLAIMANT_SESSION_COOKIE,
  verifyClaimantSession,
  type ClaimantSessionPrincipal,
} from './claimant-magic-link.js';

/**
 * Claim-stage placeholder (T-C12).
 *
 * The 7 stages match the design doc's claim-lifecycle taxonomy. v1
 * returns 'activity_capture' as a static value — the real driver lands
 * with the activity-capture / narrative-drafting workflow tasks. The
 * union is exported so the timeline component can render a fixed
 * sequence regardless of where the API decides to point.
 */
export const CLAIM_STAGES = [
  'engagement',
  'activity_capture',
  'narrative_drafting',
  'expenditure_schedule',
  'review',
  'submission',
  'audit_defence',
] as const;
export type ClaimStage = (typeof CLAIM_STAGES)[number];

export interface ClaimantStatusResponse {
  subject_tenant: { id: string; name: string; kind: 'claimant' | 'financier' };
  brand: {
    display_name: string;
    primary_color: string;
    accent_color: string;
    logo_s3_key: string | null;
  };
  claim_stage: ClaimStage;
  recent_events: Array<{
    id: string;
    kind: string;
    captured_at: string;
    snippet: string;
  }>;
  pending_rfis: Array<{
    id: string;
    requested_at: string;
    document_kind: string;
  }>;
}

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
 * Auth gate for PWA-claimant routes.
 *
 * Reads cpa_claimant_session cookie, verifies the JWT (audience =
 * pwa-claimant), and attaches the principal to req for downstream use.
 * 401 on missing or invalid cookie.
 *
 * Inlined per-route rather than registered as a global plugin because
 * the consultant session plugin already runs as a global preHandler;
 * adding a second one that fights over req.user / req.cookies feels
 * fragile, and only three routes need this auth surface (status, score,
 * + future).
 */
export async function requireClaimantSession(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<ClaimantSessionPrincipal | null> {
  const cookieValue = req.cookies[CLAIMANT_SESSION_COOKIE];
  if (typeof cookieValue !== 'string' || cookieValue.length === 0) {
    await reply.status(401).send(errEnvelope('UNAUTHENTICATED', 'No claimant session', req.id));
    return null;
  }
  try {
    return await verifyClaimantSession(cookieValue, sessionSecret());
  } catch {
    await reply
      .status(401)
      .send(errEnvelope('UNAUTHENTICATED', 'Invalid or expired session', req.id));
    return null;
  }
}

/**
 * Build the snippet for a recent-events feed row. Voice notes don't
 * carry useful raw_text; for them we surface a constant label. For
 * everything else, take the first 80 chars of payload.raw_text.
 *
 * The classifier writes raw_text into payload.raw_text on the events
 * route (see events.ts step 3) so this is a stable accessor across
 * the 12 evidence kinds + OVERRIDE.
 */
const eventSnippet = (kind: string, payload: unknown): string => {
  if (kind === 'VOICE') return 'Voice note';
  // Defensive parse: postgres-js may surface jsonb columns as a JSON-string
  // scalar instead of a parsed object when the row was written via the
  // `${JSON.stringify(obj)}::jsonb` pattern (versus chain.ts INSERT which
  // happens to roundtrip cleanly). Tolerate both shapes so the snippet
  // extraction works regardless of the writer's encoding.
  let p: unknown = payload;
  if (typeof p === 'string') {
    try {
      p = JSON.parse(p);
    } catch {
      // Not JSON — fall through and let the caller see the empty snippet.
    }
  }
  if (typeof p === 'object' && p !== null) {
    const rawText = (p as { raw_text?: unknown }).raw_text;
    if (typeof rawText === 'string') {
      return rawText.length > 80 ? rawText.slice(0, 80) + '…' : rawText;
    }
  }
  return '';
};

/**
 * Register GET /v1/claimant-status/:claimant_id (T-C12).
 *
 * Auth: cpa_claimant_session cookie. The route enforces that the
 * authenticated employee belongs to the requested claimant — passing a
 * claimant_id from a different firm 404s. The lookup uses privilegedSql
 * since claimant employees don't carry the consultant-side RLS GUC; we
 * filter explicitly on tenant_id + subject_tenant_id from the JWT.
 *
 * Returns the data needed to paint the "where is my claim" surface:
 *   - subject_tenant: claimant identity (name, kind)
 *   - brand: firm-side white-label display fields
 *   - claim_stage: current pipeline stage (placeholder for v1)
 *   - recent_events: last 5 events on this claimant's chain
 *   - pending_rfis: empty for v1; the table arrives later
 */
export function registerClaimantStatus(app: FastifyInstance): void {
  app.get<{ Params: { claimant_id: string } }>(
    '/v1/claimant-status/:claimant_id',
    async (req, reply) => {
      const principal = await requireClaimantSession(req, reply);
      if (!principal) return;

      const { claimant_id } = req.params;

      // Cross-firm guard. A leaked cookie from claimant A shouldn't be
      // able to read claimant B's status — even within the same firm,
      // employees only see their own claimant. The JWT's
      // subject_tenant_id is the one we trust.
      if (principal.subjectTenantId !== claimant_id) {
        return reply.status(404).send(errEnvelope('NOT_FOUND', 'Claimant not found', req.id));
      }

      // Step 1: load the subject_tenant + the firm's brand row in one
      // round-trip. Both tables live under the same tenant_id; we filter
      // explicitly here since RLS requires a session GUC the PWA cookie
      // doesn't set on the connection.
      const subjectRows = await privilegedSql<
        {
          id: string;
          name: string;
          kind: 'claimant' | 'financier';
          deleted_at: Date | null;
        }[]
      >`
        SELECT id, name, kind, deleted_at
          FROM subject_tenant
         WHERE id = ${claimant_id}
           AND tenant_id = ${principal.tenantId}
      `;
      const subject = subjectRows[0];
      if (!subject || subject.deleted_at !== null) {
        return reply.status(404).send(errEnvelope('NOT_FOUND', 'Claimant not found', req.id));
      }

      const brandRows = await privilegedSql<
        {
          display_name: string;
          primary_color: string;
          accent_color: string;
          logo_s3_key: string | null;
        }[]
      >`
        SELECT display_name, primary_color, accent_color, logo_s3_key
          FROM brand_config
         WHERE tenant_id = ${principal.tenantId}
      `;
      const brand = brandRows[0] ?? {
        // Same fallback as F7 — keeps a stale-DB dev environment from
        // 500ing on a missing brand row.
        display_name: 'CPA Platform',
        primary_color: '#0066cc',
        accent_color: '#00a86b',
        logo_s3_key: null,
      };

      // Step 2: last 5 events on the chain. Use privilegedSql (cpa role,
      // RLS-bypass) consistent with the subject_tenant + brand_config
      // lookups above — claimant employees authenticate via the PWA
      // cookie which doesn't carry the consultant-side tenant GUC.
      // The `AND tenant_id = ${principal.tenantId}` filter in the WHERE
      // clause is the explicit cross-firm guard, mirroring the JWT's
      // tenant_id claim.
      //
      // (Earlier attempt wrapped this in sql.begin + set_config to use
      // the cpa_app role + RLS, but that caused the test runner to hang
      // post-test — possibly the begin-transaction connection wasn't
      // releasing in time for sql.end() in the test's after() hook.)
      const events = await privilegedSql<
        {
          id: string;
          kind: string;
          payload: unknown;
          captured_at: Date | string;
        }[]
      >`
        SELECT id, kind, payload, captured_at
          FROM event
         WHERE subject_tenant_id = ${claimant_id}
           AND tenant_id = ${principal.tenantId}
         ORDER BY captured_at DESC, received_at DESC, id DESC
         LIMIT 5
      `;

      const response: ClaimantStatusResponse = {
        subject_tenant: { id: subject.id, name: subject.name, kind: subject.kind },
        brand,
        // Placeholder until the activity-capture / narrative-drafting
        // workflow tasks land the real stage tracker.
        claim_stage: 'activity_capture',
        recent_events: events.map((e) => ({
          id: e.id,
          kind: e.kind,
          captured_at:
            typeof e.captured_at === 'string' ? e.captured_at : e.captured_at.toISOString(),
          snippet: eventSnippet(e.kind, e.payload),
        })),
        // Placeholder; the pending_rfi table arrives with the
        // signing-request / RFI workflow tasks.
        pending_rfis: [],
      };

      return reply.status(200).send(response);
    },
  );
}
