import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { privilegedSql } from '@cpa/db/client';
import { getBoss } from '../../lib/pg-boss-client.js';

/**
 * POST /v1/engagement/:token/sign
 *
 * PUBLIC (token-gated). Claimant signs the engagement letter by
 * submitting `{ typedName }`. We record the signature metadata
 * (timestamp, IP, UA, typed name), flip `claim.engagement_status =
 * 'signed'`, and enqueue the pg-boss `engagement-letter-render-pdf`
 * job (handler in task 03 — this PR only enqueues).
 *
 * Token compare via `crypto.timingSafeEqual` — same pattern as
 * `get-by-token.ts`. Lifecycle gate identical: only a `sent` letter
 * (non-expired, not declined/signed) may transition to signed.
 *
 * **All writes in a single tx**: signature insert + claim status
 * update. If the tx commits we MUST enqueue the PDF job; if pg-boss
 * fails after commit, the data is consistent (signed letter, sent
 * status) and a recovery sweep can re-enqueue based on
 * `pdf_evidence_id IS NULL` — same pattern as `claim-finalisation`.
 */

const PDF_RENDER_JOB = 'engagement-letter-render-pdf';

const signBody = z.object({
  typedName: z.string().trim().min(1).max(200),
});

interface SignResponse {
  engagementId: string;
  signedAt: string;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function registerEngagementSign(app: FastifyInstance): void {
  app.post<{ Params: { token: string } }>('/v1/engagement/:token/sign', async (req, reply) => {
    const token = req.params.token;
    if (!token || token.length < 16 || token.length > 256) {
      return reply
        .status(404)
        .send({ error: 'not_found', message: 'invalid token', requestId: req.id });
    }

    const parsed = signBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'invalid_body',
        message: 'body must be { typedName: string }',
        requestId: req.id,
      });
    }
    const { typedName } = parsed.data;

    const ip = req.ip;
    const ua = req.headers['user-agent'] ?? '';

    // 1) Lookup row + constant-time token compare + lifecycle gate.
    //    Same shape as get-by-token.ts.
    // 2) Update signature columns + flip claim.engagement_status.
    //    Both in one tx (privilegedSql does not auto-tx).
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

      const signedAt = new Date();
      await tx`
          UPDATE engagement_letter
             SET signed_by_claimant_at  = ${signedAt},
                 signed_by_claimant_name = ${typedName},
                 signed_by_claimant_ip   = ${ip},
                 signed_by_claimant_ua   = ${ua}
           WHERE id = ${row.id}
        `;
      await tx`
          UPDATE claim
             SET engagement_status = 'signed',
                 updated_at = NOW()
           WHERE id = ${row.claim_id}
        `;

      return {
        kind: 'ok' as const,
        engagementId: row.id,
        signedAt,
      };
    });

    if (result.kind === 'not_found') {
      return reply
        .status(404)
        .send({ error: 'not_found', message: 'invalid token', requestId: req.id });
    }

    // Enqueue the async PDF render. Job handler lands in task 03 —
    // we only emit here. pg-boss failure is logged but does NOT roll
    // back the sign: the legal signature has already committed and a
    // sweep job can re-enqueue based on `pdf_evidence_id IS NULL`
    // (same recovery model as claim-finalisation).
    try {
      const boss = await getBoss();
      await boss.send(PDF_RENDER_JOB, { engagement_letter_id: result.engagementId });
    } catch (err) {
      req.log.warn(
        { err, engagementId: result.engagementId },
        'pg-boss enqueue of engagement-letter-render-pdf failed; sweep will retry',
      );
    }

    return reply.status(200).send({
      engagementId: result.engagementId,
      signedAt: result.signedAt.toISOString(),
    } satisfies SignResponse);
  });
}
