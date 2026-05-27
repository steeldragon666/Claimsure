import type { FastifyInstance } from 'fastify';
import { sql } from '@cpa/db/client';
import { requireMobileSession } from '../../middleware/mobile-jwt-verifier.js';

/**
 * GET /v1/me/pending-engagement
 *
 * Mobile-app first-launch gate (Wizard Step 1, Task 05).
 *
 * Returns the most recent engagement_letter in `sent` state for the
 * signed-in mobile employee's claimant — i.e. the engagement letter
 * the consultant has emailed but the claimant hasn't yet signed,
 * declined, or let expire. The mobile app calls this on cold start
 * (and on pull-to-refresh) and, when non-null, blocks navigation
 * onto a sign screen.
 *
 * Auth: `requireMobileSession`. The JWT carries `tenant_id` (the
 * consultant firm) and `subject_tenant_id` (the claimant); both are
 * used:
 *   - tenant_id → set as `app.current_tenant_id` so the RLS policy
 *     on `engagement_letter` (migration 0087) accepts the read.
 *   - subject_tenant_id → filter joined claims to this single
 *     claimant; a firm can host many claimants but this employee
 *     only ever represents one.
 *
 * "Pending" means:
 *   - `claim.engagement_status = 'sent'` (the consultant fired Send)
 *   - `el.signed_by_claimant_at IS NULL`
 *   - `el.declined_at IS NULL`
 *   - `el.expired_at IS NULL`
 *   - `el.send_token_expires_at` is null OR still in the future
 *
 * If the consultant re-sends (issues a fresh row for the same claim,
 * or rotates the token), the `created_at DESC` order picks the
 * newest. The `one_letter_per_claim` UNIQUE on `engagement_letter`
 * (migration 0087) means in practice there's at most one row per
 * claim, but a future "letter v2" workflow that retires the old row
 * and inserts a new one for the same claim would still produce
 * stable behaviour here.
 *
 * Returns:
 *   - 200 `{ pendingEngagement: { engagementId, sendToken, claimId,
 *     renderedMarkdown, firmName, consultantName } }` when a pending
 *     letter exists.
 *   - 200 `{ pendingEngagement: null }` when there is none. We
 *     deliberately return 200 + null rather than 404 so the mobile
 *     screen can treat "no pending engagement" as a normal,
 *     non-blocking outcome without translating an HTTP error.
 *
 * `sendToken` IS returned here because the mobile screen is going to
 * POST `/v1/engagement/:token/sign` next; the JWT-authed read of the
 * employee's own claimant's pending letter is the trust boundary
 * that legitimises handing the token to this client. Anyone with the
 * mobile JWT can already sign on behalf of the claimant — this just
 * exposes the existing capability through a different surface.
 */
interface PendingEngagement {
  engagementId: string;
  sendToken: string;
  claimId: string;
  renderedMarkdown: string;
  firmName: string;
  consultantName: string | null;
}

interface MePendingResponse {
  pendingEngagement: PendingEngagement | null;
}

export function registerEngagementMePending(app: FastifyInstance): void {
  app.get('/v1/me/pending-engagement', { preHandler: requireMobileSession }, async (req, reply) => {
    const principal = req.mobileUser!;

    const row = await sql.begin(async (tx) => {
      // Set the RLS GUC for the consultant firm — engagement_letter's
      // policy gates reads on tenant_id matching the GUC. The token-
      // gated public endpoints use `privilegedSql` because they have
      // no session; here we DO have a session, so we use the regular
      // pool + GUC and let RLS do the cross-tenant guard.
      await tx`SELECT set_config('app.current_tenant_id', ${principal.tenantId}, true)`;
      const rows = await tx<
        {
          id: string;
          claim_id: string;
          send_token: string | null;
          rendered_markdown: string;
          firm_name: string;
          consultant_name: string | null;
        }[]
      >`
        SELECT el.id,
               el.claim_id,
               el.send_token,
               el.rendered_markdown,
               t.name AS firm_name,
               (SELECT u.display_name
                  FROM tenant_user tu
                  JOIN "user" u ON u.id = tu.user_id
                 WHERE tu.tenant_id = el.tenant_id
                   AND tu.role IN ('admin', 'consultant')
                   AND tu.deleted_at IS NULL
                 ORDER BY tu.is_default DESC, tu.created_at ASC
                 LIMIT 1) AS consultant_name
          FROM engagement_letter el
          JOIN claim c ON c.id = el.claim_id
          JOIN tenant t ON t.id = el.tenant_id
         WHERE c.subject_tenant_id = ${principal.subjectTenantId}
           AND c.engagement_status = 'sent'
           AND el.signed_by_claimant_at IS NULL
           AND el.declined_at IS NULL
           AND el.expired_at IS NULL
           AND (el.send_token_expires_at IS NULL
                OR el.send_token_expires_at > NOW())
         ORDER BY el.created_at DESC
         LIMIT 1
      `;
      return rows[0] ?? null;
    });

    if (!row || !row.send_token) {
      return reply.status(200).send({ pendingEngagement: null } satisfies MePendingResponse);
    }

    return reply.status(200).send({
      pendingEngagement: {
        engagementId: row.id,
        sendToken: row.send_token,
        claimId: row.claim_id,
        renderedMarkdown: row.rendered_markdown,
        firmName: row.firm_name,
        consultantName: row.consultant_name,
      },
    } satisfies MePendingResponse);
  });
}
