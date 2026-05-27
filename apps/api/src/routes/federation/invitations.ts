import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import { createResendClient, createEmailSender, federationInvitationEmail } from '@cpa/email';
import { publicUrl } from '../../lib/public-base-url.js';

/**
 * P9 Phase 3 — Federation invitation endpoints.
 *
 * POST /v1/federation/invitations       — create invitation + send email
 * POST /v1/federation/invitations/:id/accept — accept invitation → create share
 */

export function registerFederationInvitations(app: FastifyInstance): void {
  // ---------------------------------------------------------------
  // POST /v1/federation/invitations — create invitation + send email
  // ---------------------------------------------------------------
  app.post(
    '/v1/federation/invitations',
    {
      preHandler: requireSession,
      schema: {
        body: z.object({
          subject_tenant_id: z.string().uuid(),
          target_email: z.string().email(),
          expires_in_days: z.union([z.literal(7), z.literal(14), z.literal(30)]),
        }),
      },
    },
    async (req, reply) => {
      const body = req.body as {
        subject_tenant_id: string;
        target_email: string;
        expires_in_days: 7 | 14 | 30;
      };
      const userId = req.user!.id;
      const tenantId = req.user!.tenantId;

      // Validate subject_tenant belongs to current tenant (RLS handles scoping).
      // If the subject_tenant doesn't exist under this tenant, the query returns 0 rows.
      const subjectCheck = await sql<{ id: string }[]>`
        SELECT id FROM subject_tenant
        WHERE id = ${body.subject_tenant_id}
          AND tenant_id = ${tenantId}
      `;
      if (subjectCheck.length === 0) {
        return reply.code(404).send({
          error: 'NotFound',
          message: 'Subject tenant not found or not accessible',
        });
      }

      // Look up subject tenant name and firm name for the email
      const [subjectRow] = await sql<{ name: string }[]>`
        SELECT name FROM subject_tenant WHERE id = ${body.subject_tenant_id}
      `;
      const [tenantRow] = await sql<{ name: string }[]>`
        SELECT name FROM tenant WHERE id = ${tenantId}
      `;
      const [userRow] = await sql<{ display_name: string }[]>`
        SELECT display_name FROM "user" WHERE id = ${userId}
      `;

      // Generate 256-bit random token
      const tokenBytes = crypto.randomBytes(32);
      const tokenHex = tokenBytes.toString('hex');
      const tokenHash = crypto.createHash('sha256').update(tokenBytes).digest('hex');

      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + body.expires_in_days);

      // INSERT invitation
      const invRows = await sql<{ id: string; status: string; expires_at: Date }[]>`
        INSERT INTO federation_invitation (
          subject_tenant_id, source_tenant_id, target_email,
          invited_by_user_id, token_hash, expires_at
        )
        VALUES (
          ${body.subject_tenant_id}, ${tenantId}, ${body.target_email},
          ${userId}, ${tokenHash}, ${expiresAt.toISOString()}::timestamptz
        )
        RETURNING id, status, expires_at
      `;
      const invitation = invRows[0]!;

      // Build accept URL and send email
      const acceptUrl = publicUrl(`/federation/accept?token=${tokenHex}`);

      try {
        const client = createResendClient();
        const sender = createEmailSender(client, {
          fromAddress:
            process.env['EMAIL_FROM_ADDRESS'] ?? 'CPA Platform <noreply@cpaplatform.com>',
        });

        const email = federationInvitationEmail({
          recipientEmail: body.target_email,
          firmName: tenantRow?.name ?? 'CPA Platform Firm',
          entityName: subjectRow?.name ?? 'Entity',
          inviterName: userRow?.display_name ?? 'A consultant',
          acceptUrl,
          expiresAt,
        });

        await sender.send({
          to: body.target_email,
          subject: email.subject,
          html: email.html,
          text: email.text,
        });
      } catch (err) {
        // Log email failure but don't fail the invitation creation
        app.log.error({ err }, 'Failed to send federation invitation email');
      }

      return reply.code(201).send({
        id: invitation.id,
        status: invitation.status,
        expires_at: invitation.expires_at,
      });
    },
  );

  // ---------------------------------------------------------------
  // POST /v1/federation/invitations/:id/accept — accept → create share
  // ---------------------------------------------------------------
  app.post(
    '/v1/federation/invitations/:id/accept',
    {
      preHandler: requireSession,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ token: z.string().min(1) }),
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { token } = req.body as { token: string };
      const currentTenantId = req.user!.tenantId;
      const currentUserId = req.user!.id;

      // Hash the provided token for lookup
      const tokenHash = crypto.createHash('sha256').update(Buffer.from(token, 'hex')).digest('hex');

      // Lookup invitation by id + token_hash using privilegedSql because
      // the accepting tenant isn't the source_tenant (RLS WITH CHECK would
      // block them from seeing pending invitations where target_tenant_id is NULL).
      const invitations = await privilegedSql<
        {
          id: string;
          status: string;
          expires_at: Date;
          source_tenant_id: string;
          subject_tenant_id: string;
          token_hash: string;
        }[]
      >`
        SELECT id, status, expires_at, source_tenant_id, subject_tenant_id, token_hash
        FROM federation_invitation
        WHERE id = ${id}
      `;

      if (invitations.length === 0) {
        return reply.code(404).send({
          error: 'NotFound',
          message: 'Invitation not found',
        });
      }

      const invitation = invitations[0]!;

      // Verify token hash matches
      if (invitation.token_hash !== tokenHash) {
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'Invalid invitation token',
        });
      }

      // Validate: status='pending', not expired
      if (invitation.status !== 'pending') {
        return reply.code(409).send({
          error: 'Conflict',
          message: `Invitation is already ${invitation.status}`,
        });
      }
      if (new Date(invitation.expires_at) < new Date()) {
        // Mark as expired
        await privilegedSql`
          UPDATE federation_invitation
          SET status = 'expired'
          WHERE id = ${id}
        `;
        return reply.code(410).send({
          error: 'Gone',
          message: 'Invitation has expired',
        });
      }

      // Cannot accept your own invitation
      if (invitation.source_tenant_id === currentTenantId) {
        return reply.code(409).send({
          error: 'Conflict',
          message: 'Cannot accept an invitation from your own firm',
        });
      }

      // Create federation_share + update invitation in a transaction.
      // Use privilegedSql because we need to write to federation_invitation
      // (which the target tenant can't do via RLS WITH CHECK).
      const result = await privilegedSql.begin(async (tx) => {
        // INSERT federation_share — use the normal sql client within a
        // set_config context so RLS records the correct source tenant.
        const shareRows = await tx<{ id: string }[]>`
          INSERT INTO federation_share (
            subject_tenant_id, source_tenant_id, target_tenant_id,
            granted_by_user_id
          )
          VALUES (
            ${invitation.subject_tenant_id},
            ${invitation.source_tenant_id},
            ${currentTenantId},
            ${currentUserId}
          )
          RETURNING id
        `;

        // UPDATE invitation
        await tx`
          UPDATE federation_invitation
          SET status = 'accepted',
              accepted_at = now(),
              target_tenant_id = ${currentTenantId}
          WHERE id = ${id}
        `;

        return shareRows[0]!;
      });

      return reply.code(200).send({
        share_id: result.id,
        subject_tenant_id: invitation.subject_tenant_id,
      });
    },
  );
}
