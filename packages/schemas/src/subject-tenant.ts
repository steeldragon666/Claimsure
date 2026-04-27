import { z } from 'zod';
import { Iso8601, Uuid } from './primitives.js';

/**
 * Subject-tenant kind discriminator.
 *
 * - claimant: owned by the firm; firm staff have access via subject_tenant_user
 *   roles (T7 schema). The default kind for the create endpoint.
 * - financier: granted scoped read access via delegation_token (T8 schema, P8
 *   API surface). Does not have firm-level membership.
 *
 * Mirrors the DB-level enum on `subject_tenant.kind` (packages/db/src/schema/
 * subject_tenant.ts).
 */
export const subjectTenantKind = z.enum(['claimant', 'financier']);
export type SubjectTenantKind = z.infer<typeof subjectTenantKind>;

/**
 * Public shape of a subject_tenant row over the API. Timestamps are
 * ISO-8601 with offset (matches the audit-anchor convention used across
 * @cpa/schemas).
 */
export const subjectTenant = z.object({
  id: Uuid,
  tenant_id: Uuid,
  name: z.string(),
  kind: subjectTenantKind,
  created_at: Iso8601,
  updated_at: Iso8601,
});
export type SubjectTenant = z.infer<typeof subjectTenant>;

/**
 * POST /v1/subject-tenants body. Defaults `kind` to 'claimant' since that's
 * the dominant case (financier subject-tenants are created via a separate
 * delegation flow in P8).
 */
export const createSubjectTenantBody = z.object({
  name: z.string().min(1).max(200),
  kind: subjectTenantKind.default('claimant'),
});
export type CreateSubjectTenantBody = z.infer<typeof createSubjectTenantBody>;

/**
 * GET /v1/subject-tenants query — optional `kind` filter for narrowing.
 * Omit to list all kinds in the active firm.
 */
export const listSubjectTenantsQuery = z.object({
  kind: subjectTenantKind.optional(),
});
export type ListSubjectTenantsQuery = z.infer<typeof listSubjectTenantsQuery>;
