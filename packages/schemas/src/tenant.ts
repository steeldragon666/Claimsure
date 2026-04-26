import { z } from 'zod';
import { Uuid } from './primitives.js';

/**
 * Per-tenant role enum. Used in both tenant_user (firm-level role) and
 * subject_tenant_user (per-claimant role would have its own enum, but for
 * the firm-level surface this is the canonical list).
 *
 * - admin: manages firm settings, users, claimants
 * - consultant: works on claimants per ACL
 * - viewer: read-only across the firm
 */
export const RoleEnum = z.enum(['admin', 'consultant', 'viewer']);
export type Role = z.infer<typeof RoleEnum>;

/**
 * Compact tenant reference — the shape returned in JWT availableTenants
 * claim and /v1/tenants list responses.
 *
 * Distinct from the full `tenant` row (which has primary_idp + audit cols
 * we don't surface to clients). The `role` and `isDefault` fields come
 * from the joined tenant_user row for the requesting user.
 */
export const TenantRef = z.object({
  id: Uuid,
  name: z.string().min(1),
  slug: z.string().min(1),
  role: RoleEnum,
  isDefault: z.boolean(),
});
export type TenantRef = z.infer<typeof TenantRef>;
