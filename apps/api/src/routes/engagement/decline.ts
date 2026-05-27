import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { privilegedSql } from '@cpa/db/client';

/**
 * POST /v1/engagement/:token/decline
 *
 * PUBLIC (token-gated). Claimant declines the engagement letter.
 * Sets `declined_at = now()`, records the optional reason, and flips
 * `claim.engagement_status = 'declined'`.
 *
 * Token compare + lifecycle gate identical to `sign.ts` /
 * `get-by-token.ts`. Same `not_found` shroud over every failure mode
 * to avoid token-state leakage.
 *
 * `declined_reason` is optional and free-text; trimmed and capped at
 * 2000 chars to match the schema and keep payload sizes bounded.
 */
const declineBody = z.object({
  reason: z.string().trim().max(2000).optional(),
});

interface DeclineResponse {
  declinedAt: string;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function registerEngagementDecline(app: FastifyInstance): void {
  app.post<{ Params: { token: string } }>('/v1/engagement/:token/decline', async (req, reply) => {
    const token = req.params.token;
    if (!token || token.length < 16 || token.length > 256) {
      return reply
        .status(404)
        .send({ error: 'not_found', message: 'invalid token', requestId: req.id });
    }

    const parsed = declineBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'invalid_body',
        message: 'body must be { reason?: string }',
        requestId: req.id,
      });
    }
    const reason = parsed.data.reason ?? null;

    const result = await privilegedSql.begin(async (tx) => {
      const rows = await tx<
        {
          id: string;
          claim_id: string;
          send_token: string;
          send_token_expires_at: Date | null;
          signed_by_claimant_at: Date | null;
          declined_at: Date | null;
          expired_at: Date | null;
        }[]
      >`
          SELECT id, claim_id, send_token, send_token_expires_at,
                 signed_by_claimant_at, declined_at, expired_at
            FROM engagement_letter
           WHERE send_token = ${token}
           LIMIT 1
        `;
      const row = rows[0];
      if (!row || !row.send_token) return { kind: 'not_found' as const };
      if (!constantTimeEqual(token, row.send_token)) return { kind: 'not_found' as const };
      if (
        row.signed_by_claimant_at !== null ||
        row.declined_at !== null ||
        row.expired_at !== null
      ) {
        return { kind: 'not_found' as const };
      }
      if (row.send_token_expires_at !== null && row.send_token_expires_at.getTime() <= Date.now()) {
        return { kind: 'not_found' as const };
      }

      const declinedAt = new Date();
      await tx`
          UPDATE engagement_letter
             SET declined_at    = ${declinedAt},
                 declined_reason = ${reason}
           WHERE id = ${row.id}
        `;
      await tx`
          UPDATE claim
             SET engagement_status = 'declined',
                 updated_at = NOW()
           WHERE id = ${row.claim_id}
        `;

      return { kind: 'ok' as const, declinedAt };
    });

    if (result.kind === 'not_found') {
      return reply
        .status(404)
        .send({ error: 'not_found', message: 'invalid token', requestId: req.id });
    }

    return reply
      .status(200)
      .send({ declinedAt: result.declinedAt.toISOString() } satisfies DeclineResponse);
  });
}
