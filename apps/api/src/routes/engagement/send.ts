import type { FastifyInstance } from 'fastify';
import { requireSession } from '@cpa/auth';
import { sql } from '@cpa/db/client';
import { generateOpaqueToken } from '../../lib/token.js';
import { renderTemplate } from '../../lib/render-template.js';

/**
 * POST /v1/claims/:id/engagement/send
 *
 * Session-required. Renders the per-firm engagement-letter template
 * against the claim's variables, generates an opaque 30-day send token,
 * upserts the `engagement_letter` row (one-per-claim — re-sending after
 * decline/expire updates the existing row), and flips
 * `claim.engagement_status = 'sent'`.
 *
 * RLS-scoped via `sql.begin` + `set_config('app.current_tenant_id')`.
 * Cross-tenant access is therefore a 404 not a 403 — the RLS policy
 * makes the row invisible.
 *
 * **Idempotency / resend semantics:** if the claim already has an
 * engagement_letter (declined or expired), we update it in place rather
 * than inserting a sibling. The `one_letter_per_claim` UNIQUE
 * constraint enforces this at the DB level too. The token rotates on
 * each send so a previously-leaked token cannot be reused.
 *
 * **Template gating:** the firm must have configured
 * `tenant.engagement_letter_template_md`. NULL = 422 (operator action
 * needed). Letting send proceed with a NULL template would render an
 * empty letter and create a signed-empty-letter audit trail, which is
 * worse than a hard refusal.
 */
const SEND_TOKEN_TTL_DAYS = 30;

interface SendResponse {
  engagementId: string;
  sendToken: string;
  expiresAt: string;
}

export function registerEngagementSend(app: FastifyInstance): void {
  app.post<{ Params: { id: string } }>(
    '/v1/claims/:id/engagement/send',
    { preHandler: requireSession },
    async (req, reply) => {
      const tenantId = req.user!.tenantId!;
      const claimId = req.params.id;

      // Render data we need to pull: claim core fields + the tenant's
      // template + the consultant's display name. All inside the same
      // tenant-scoped transaction so a concurrent tenant switch doesn't
      // mix-and-match data from two firms.
      try {
        const result = await sql.begin(async (tx) => {
          await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;

          // Load the claim. RLS narrows visibility — a cross-tenant id is
          // simply absent.
          const claimRows = await tx<
            {
              id: string;
              fiscal_year: number;
              claimant_name: string;
            }[]
          >`
            SELECT c.id,
                   c.fiscal_year,
                   st.name AS claimant_name
              FROM claim c
              JOIN subject_tenant st ON st.id = c.subject_tenant_id
             WHERE c.id = ${claimId}
          `;
          const claim = claimRows[0];
          if (!claim) {
            return { kind: 'not_found' as const };
          }

          // Load the firm template. `privilegedSql` is NOT needed —
          // `tenant` has no RLS, but we're already inside a tx so use
          // the same handle for consistency.
          const tenantRows = await tx<
            { name: string; engagement_letter_template_md: string | null }[]
          >`
            SELECT name, engagement_letter_template_md
              FROM tenant
             WHERE id = ${tenantId}
          `;
          const tenantRow = tenantRows[0];
          if (!tenantRow) {
            // Theoretical — RLS scope guarantees we have a tenant — but
            // be defensive: tenant deletion would land here.
            return { kind: 'not_found' as const };
          }
          if (!tenantRow.engagement_letter_template_md) {
            return { kind: 'template_missing' as const };
          }

          // Consultant display name — pulled from the user table by the
          // session subject. Falls back to email if display_name is NULL.
          const userRows = await tx<{ display_name: string | null; email: string }[]>`
            SELECT display_name, email FROM "user" WHERE id = ${req.user!.id}
          `;
          const userRow = userRows[0];
          const consultantName = userRow?.display_name ?? userRow?.email ?? '';

          const rendered = renderTemplate(tenantRow.engagement_letter_template_md, {
            claimant_name: claim.claimant_name,
            financial_year: String(claim.fiscal_year),
            // `fee_pct` is not yet modelled — emit empty so the
            // placeholder remains literal in the output (see
            // render-template.ts JSDoc on the missing-key policy)
            // unless the operator explicitly omitted it from the template.
            engagement_date: new Date().toISOString().slice(0, 10),
            consultant_name: consultantName,
          });

          const sendToken = generateOpaqueToken();
          const expiresAt = new Date(Date.now() + SEND_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
          const templateVersion = 'v1';

          // UPSERT: re-send after decline/expire overwrites the row.
          // `one_letter_per_claim` enforces uniqueness; the ON CONFLICT
          // DO UPDATE rotates the token + resets the lifecycle markers
          // that don't apply to the new attempt (decline/expire columns
          // cleared; signed/countersigned should never be present on a
          // resend because once signed the row is terminal — guarded by
          // the WHERE filter to avoid silently overwriting a real signature).
          const upserted = await tx<{ id: string }[]>`
            INSERT INTO engagement_letter
              (tenant_id, claim_id, rendered_markdown, template_version,
               send_token, send_token_expires_at, sent_to_claimant_at)
            VALUES
              (${tenantId}, ${claimId}, ${rendered}, ${templateVersion},
               ${sendToken}, ${expiresAt}, NOW())
            ON CONFLICT (claim_id) DO UPDATE SET
              rendered_markdown      = EXCLUDED.rendered_markdown,
              template_version       = EXCLUDED.template_version,
              send_token             = EXCLUDED.send_token,
              send_token_expires_at  = EXCLUDED.send_token_expires_at,
              sent_to_claimant_at    = NOW(),
              declined_at            = NULL,
              declined_reason        = NULL,
              expired_at             = NULL
              WHERE engagement_letter.signed_by_claimant_at IS NULL
            RETURNING id
          `;
          const letter = upserted[0];
          if (!letter) {
            // The WHERE on the ON CONFLICT branch filtered the row out —
            // claim already has a signed letter. Refuse to overwrite.
            return { kind: 'already_signed' as const };
          }

          await tx`
            UPDATE claim
               SET engagement_status = 'sent',
                   updated_at = NOW()
             WHERE id = ${claimId}
          `;

          return {
            kind: 'ok' as const,
            response: {
              engagementId: letter.id,
              sendToken,
              expiresAt: expiresAt.toISOString(),
            } satisfies SendResponse,
          };
        });

        if (result.kind === 'not_found') {
          return await reply
            .status(404)
            .send({ error: 'not_found', message: 'claim not found', requestId: req.id });
        }
        if (result.kind === 'template_missing') {
          return await reply.status(422).send({
            error: 'template_missing',
            message:
              'tenant.engagement_letter_template_md is NULL — firm has not configured a template',
            requestId: req.id,
          });
        }
        if (result.kind === 'already_signed') {
          return await reply.status(409).send({
            error: 'already_signed',
            message: 'engagement letter is already signed and cannot be resent',
            requestId: req.id,
          });
        }

        return await reply.status(200).send(result.response);
      } catch (err) {
        req.log.error({ err, claimId, tenantId }, 'engagement send failed');
        throw err;
      }
    },
  );
}
