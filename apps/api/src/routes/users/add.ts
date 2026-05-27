import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getOrAddTenantUser, requireAdmin } from '@cpa/auth';
import { privilegedSql } from '@cpa/db/client';

const AddBody = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'consultant', 'viewer']),
  isDefault: z.boolean().optional(),
});

interface UserLookupRow {
  id: string;
  display_name: string | null;
}

/**
 * Register POST /v1/users — add an existing user to the active firm.
 *
 * Body: { email, role, isDefault?: boolean }
 *
 * Behaviour:
 *   1. Look up user by email (privilegedSql since the user table is GLOBAL).
 *   2. If user not found: 404 with hint to ask them to log in once first
 *      (P3+ adds the email-invitation flow).
 *   3. Call getOrAddTenantUser:
 *      - 'created' → 201 + UserRef (new membership row)
 *      - 'undeleted' → 200 + UserRef (re-onboarded a soft-deleted member)
 *      - 'already_member' → 409 with current row (caller knows they're a member)
 *
 * preHandler: requireAdmin.
 */
export function registerAddUser(app: FastifyInstance): void {
  app.post('/v1/users', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = AddBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'invalid_body',
        message: 'Body must be { email, role, isDefault? }',
        requestId: req.id,
      });
    }
    const { email, role, isDefault = false } = parsed.data;
    const tenantId = req.user!.tenantId!;

    const userRows = await privilegedSql<UserLookupRow[]>`
      SELECT id, display_name
        FROM "user"
       WHERE email = ${email} AND deleted_at IS NULL
    `;
    if (!userRows[0]) {
      return reply.status(404).send({
        error: 'user_not_found',
        message: 'User not found — ask them to complete approved signup first, then retry',
        requestId: req.id,
      });
    }
    const userId = userRows[0].id;
    const displayName = userRows[0].display_name;

    const result = await getOrAddTenantUser({ tenantId, userId, role, isDefault });

    const userRef = {
      id: userId,
      email,
      displayName,
      role: result.row.role,
      isDefault: result.row.isDefault,
      addedAt:
        typeof result.row.addedAt === 'string'
          ? result.row.addedAt
          : result.row.addedAt.toISOString(),
    };

    if (result.status === 'created') {
      return reply.status(201).send(userRef);
    }
    if (result.status === 'undeleted') {
      return reply.status(200).send(userRef);
    }
    // already_member
    return reply.status(409).send({
      error: 'already_member',
      message: 'User is already a member of this firm',
      member: userRef,
      requestId: req.id,
    });
  });
}
