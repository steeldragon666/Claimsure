import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { privilegedSql } from '@cpa/db/client';

/**
 * GET /v1/engagement/by-token/:token
 *
 * PUBLIC (token-gated). Used by the mobile-app sign screen and the
 * web fallback to render the letter the claimant is about to sign.
 *
 * **Path note:** the spec sheet writes this as `GET /v1/engagement/[token]`,
 * but `GET /v1/engagement/:id` (the consultant view) and a bare `:token`
 * form would collide in Fastify's radix router. We disambiguate by
 * prefixing the token form with `/by-token/`. The sibling action
 * routes (`/v1/engagement/:token/sign`, `/v1/engagement/:token/decline`)
 * do NOT need the prefix because their literal sub-path (`/sign`,
 * `/decline`) already disambiguates them from `/v1/engagement/:id/countersign`.
 *
 * Token compare is constant-time via `crypto.timingSafeEqual`, mirroring
 * the `dev-login.ts` precedent. We can't `WHERE send_token = ?` and call
 * it a day — even though Postgres bytea compare is constant-time per
 * collation, the prefix scan and the result-set existence check leak
 * timing. We instead fetch the candidate row's *expected* token via a
 * deterministic lookup (the token itself, as a string column with
 * UNIQUE), then `timingSafeEqual` the bytes. The lookup itself can still
 * leak "token exists or not" through timing, but the comparison of the
 * matched bytes is constant — which is what the design doc calls for.
 *
 * The `privilegedSql` pool is required: there's no session yet, so
 * `app.current_tenant_id` is unset and the RLS policy would reject the
 * read. The token is the auth signal.
 *
 * **404 semantics:** any unhappy path — unknown token, expired,
 * already signed, declined, expired — returns 404 (not 401). Returning
 * a distinct 410 / 401 leaks token-state information to an attacker who
 * is probing.
 */
interface GetByTokenResponse {
  renderedMarkdown: string;
  consultantName: string | null;
  firmName: string;
  status: 'sent';
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function registerEngagementGetByToken(app: FastifyInstance): void {
  app.get<{ Params: { token: string } }>('/v1/engagement/by-token/:token', async (req, reply) => {
    const token = req.params.token;
    if (!token || token.length < 16 || token.length > 256) {
      // Reject obviously-malformed tokens before hitting the DB. 16 is
      // below the 32-byte/~43-char minimum but generous enough that a
      // brute attempt with a too-short input still bounces here. Upper
      // bound prevents pathological inputs.
      return reply
        .status(404)
        .send({ error: 'not_found', message: 'invalid token', requestId: req.id });
    }

    const rows = await privilegedSql<
      {
        send_token: string;
        send_token_expires_at: Date | null;
        rendered_markdown: string;
        signed_by_claimant_at: Date | null;
        declined_at: Date | null;
        expired_at: Date | null;
        firm_name: string;
        consultant_name: string | null;
      }[]
    >`
      SELECT el.send_token,
             el.send_token_expires_at,
             el.rendered_markdown,
             el.signed_by_claimant_at,
             el.declined_at,
             el.expired_at,
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
        JOIN tenant t ON t.id = el.tenant_id
       WHERE el.send_token = ${token}
       LIMIT 1
    `;
    const row = rows[0];
    if (!row || !row.send_token) {
      return reply
        .status(404)
        .send({ error: 'not_found', message: 'invalid token', requestId: req.id });
    }

    if (!constantTimeEqual(token, row.send_token)) {
      // Belt and braces — Postgres already filtered by equality, but
      // the design doc calls for an explicit constant-time check here.
      return reply
        .status(404)
        .send({ error: 'not_found', message: 'invalid token', requestId: req.id });
    }

    // Lifecycle gate: only `sent` letters are visible to the claimant
    // via this route. Once signed / declined / expired the token is
    // dead.
    if (row.signed_by_claimant_at !== null || row.declined_at !== null || row.expired_at !== null) {
      return reply
        .status(404)
        .send({ error: 'not_found', message: 'invalid token', requestId: req.id });
    }
    if (row.send_token_expires_at !== null && row.send_token_expires_at.getTime() <= Date.now()) {
      return reply
        .status(404)
        .send({ error: 'not_found', message: 'invalid token', requestId: req.id });
    }

    return reply.status(200).send({
      renderedMarkdown: row.rendered_markdown,
      consultantName: row.consultant_name,
      firmName: row.firm_name,
      status: 'sent',
    } satisfies GetByTokenResponse);
  });
}
