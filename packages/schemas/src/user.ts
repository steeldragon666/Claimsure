import { z } from 'zod';
import { Iso8601, Uuid } from './primitives.js';
import { RoleEnum } from './tenant.js';

/**
 * Compact user reference for /v1/users list + detail responses.
 *
 * Joins user × tenant_user — `id` is the user.id (NOT tenant_user.id),
 * `role` and `isDefault` come from the tenant_user row in the active
 * firm, `addedAt` is the tenant_user.created_at (when this user joined
 * the firm — NOT the user's overall account creation).
 */
export const UserRef = z.object({
  id: Uuid,
  email: z.string().email(),
  displayName: z.string().nullable(),
  role: RoleEnum,
  isDefault: z.boolean(),
  addedAt: Iso8601,
});
export type UserRef = z.infer<typeof UserRef>;
